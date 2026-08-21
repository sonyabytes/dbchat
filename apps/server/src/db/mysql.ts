/**
 * MySQL driver (`mysql2/promise` pool).
 *
 * Read-only enforcement is the classifier plus `START TRANSACTION READ ONLY`
 * and `SET SESSION max_execution_time` (the READ ONLY transaction only really
 * blocks writes on InnoDB, so the classifier is the primary guard here).
 * Interrupting the `query` stream issues `KILL QUERY <connectionId>` from a
 * second pooled connection.
 *
 * `readOnly: false` takes a separate, non-streaming path (`runWrite`): mysql2
 * answers DML with a `ResultSetHeader`, so `affectedRows` is the only real
 * count. It runs inside `beginTransaction … commit` with each `;`-separated
 * statement executed in order, which makes a multi-statement `propose_write`
 * atomic without enabling mysql2's `multipleStatements`.
 */
import {
  type ColumnMeta,
  ConnectionError,
  DriverError,
  type IndexMeta,
  NotFound,
  type RowsPage,
  type RowsRequest,
  type SchemaMeta,
  SqlError,
  type TableDetail,
  type TableMeta,
  WriteBlocked,
} from "@dbchat/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import mysql from "mysql2/promise";

import type { Driver, QueryOptions, RowBatch } from "../Services/DriverRegistry.ts";
import { splitStatements } from "../sql/statements.ts";
import { explainGuard, isReadOnlySql, splitStatements as splitForDialect } from "./classify.ts";
import { toJsonSafeRows } from "./jsonSafe.ts";
import { mysqlColumnMeta, type MysqlField } from "./mysqlTypes.ts";
import { buildCountQuery, buildRowsQuery, hasFilters } from "./queryBuilder.ts";

export interface MysqlConfig {
  readonly url?: string | undefined;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly database?: string | undefined;
  readonly user?: string | undefined;
  readonly password?: string | undefined;
  readonly ssl?: "disable" | "prefer" | "require" | undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const BATCH_SIZE = 500;
const EXACT_COUNT_THRESHOLD = 50_000;

const SYSTEM_SCHEMAS = ["mysql", "information_schema", "performance_schema", "sys"];

const errMessage = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);

const toSqlError = (e: unknown): SqlError => {
  const anyErr = e as { code?: unknown } | null;
  const code = typeof anyErr?.code === "string" ? anyErr.code : undefined;
  return new SqlError({ message: errMessage(e), ...(code !== undefined ? { code } : {}) });
};

const toDriverError = (e: unknown): DriverError =>
  new DriverError({ dialect: "mysql", message: errMessage(e) });

const toPoolConfig = (cfg: MysqlConfig): mysql.PoolOptions => {
  const base: mysql.PoolOptions = {
    connectionLimit: 4,
    waitForConnections: true,
    dateStrings: true,
    ...(cfg.ssl === "require" ? { ssl: { rejectUnauthorized: false } } : {}),
  };
  if (cfg.url !== undefined && cfg.url.length > 0) return { ...base, uri: cfg.url };
  return {
    ...base,
    ...(cfg.host !== undefined && cfg.host.length > 0 ? { host: cfg.host } : {}),
    ...(cfg.port !== undefined && cfg.port > 0 ? { port: cfg.port } : {}),
    ...(cfg.database !== undefined && cfg.database.length > 0 ? { database: cfg.database } : {}),
    ...(cfg.user !== undefined && cfg.user.length > 0 ? { user: cfg.user } : {}),
    ...(cfg.password !== undefined && cfg.password.length > 0 ? { password: cfg.password } : {}),
  };
};

export const makeMysqlDriver = (cfg: MysqlConfig): Effect.Effect<Driver, ConnectionError> =>
  Effect.gen(function* () {
    const pool = yield* Effect.try({
      try: () => mysql.createPool(toPoolConfig(cfg)),
      catch: (e) => new ConnectionError({ message: `could not create a MySQL pool: ${errMessage(e)}` }),
    });
    const defaultSchema = cfg.database ?? "";

    const rawQuery = <T>(sql: string, params: ReadonlyArray<unknown> = []): Effect.Effect<Array<T>, SqlError> =>
      Effect.tryPromise({
        try: async () => {
          const [rows] = await pool.query(sql, params as Array<unknown>);
          return (Array.isArray(rows) ? rows : []) as Array<T>;
        },
        catch: toSqlError,
      });

    const killQuery = (threadId: number): Effect.Effect<void> =>
      Effect.promise(async () => {
        try {
          await pool.query(`KILL QUERY ${Math.trunc(threadId)}`);
        } catch {
          /* best effort */
        }
      });

    /* ---- ping ---- */
    const ping = Effect.gen(function* () {
      const started = Date.now();
      const rows = yield* rawQuery<{ v: string }>("select version() as v");
      return { latencyMs: Date.now() - started, ...(rows[0] ? { serverVersion: `MySQL ${rows[0].v}` } : {}) };
    }).pipe(Effect.mapError((e) => new DriverError({ dialect: "mysql", message: e.message })));

    /* ---- introspect ---- */
    const introspect = Effect.gen(function* () {
      const placeholders = SYSTEM_SCHEMAS.map(() => "?").join(", ");
      const [schemas, tables] = yield* Effect.all(
        [
          rawQuery<{ SCHEMA_NAME: string }>(
            `select schema_name as SCHEMA_NAME from information_schema.schemata
             where schema_name not in (${placeholders}) order by 1`,
            SYSTEM_SCHEMAS,
          ),
          rawQuery<{ TABLE_SCHEMA: string; TABLE_NAME: string; TABLE_TYPE: string; TABLE_ROWS: number | null }>(
            `select table_schema as TABLE_SCHEMA, table_name as TABLE_NAME,
                    table_type as TABLE_TYPE, table_rows as TABLE_ROWS
             from information_schema.tables
             where table_schema not in (${placeholders}) order by 1, 2`,
            SYSTEM_SCHEMAS,
          ),
        ],
        { concurrency: 2 },
      );
      const bySchema = new Map<string, Array<TableMeta>>();
      for (const s of schemas) bySchema.set(s.SCHEMA_NAME, []);
      for (const t of tables) {
        const list = bySchema.get(t.TABLE_SCHEMA) ?? [];
        list.push({
          schema: t.TABLE_SCHEMA,
          name: t.TABLE_NAME,
          kind: t.TABLE_TYPE === "VIEW" ? "view" : "table",
          rowEstimate: Number(t.TABLE_ROWS ?? 0) || 0,
        });
        bySchema.set(t.TABLE_SCHEMA, list);
      }
      return [...bySchema.entries()].map(([name, list]): SchemaMeta => ({ name, tables: list }));
    }).pipe(Effect.mapError((e) => new DriverError({ dialect: "mysql", message: e.message })));

    /* ---- describeTable ---- */
    const describeTable = (
      schema: string,
      table: string,
    ): Effect.Effect<TableDetail, DriverError | NotFound> =>
      Effect.gen(function* () {
        const db = schema.length > 0 ? schema : defaultSchema;
        const [cols, fks, stats, meta] = yield* Effect.all(
          [
            rawQuery<{
              COLUMN_NAME: string;
              COLUMN_TYPE: string;
              IS_NULLABLE: string;
              COLUMN_DEFAULT: string | null;
              COLUMN_KEY: string;
            }>(
              `select column_name as COLUMN_NAME, column_type as COLUMN_TYPE, is_nullable as IS_NULLABLE,
                      column_default as COLUMN_DEFAULT, column_key as COLUMN_KEY
               from information_schema.columns
               where table_schema = ? and table_name = ? order by ordinal_position`,
              [db, table],
            ),
            rawQuery<{
              COLUMN_NAME: string;
              REFERENCED_TABLE_SCHEMA: string;
              REFERENCED_TABLE_NAME: string;
              REFERENCED_COLUMN_NAME: string;
            }>(
              `select column_name as COLUMN_NAME, referenced_table_schema as REFERENCED_TABLE_SCHEMA,
                      referenced_table_name as REFERENCED_TABLE_NAME, referenced_column_name as REFERENCED_COLUMN_NAME
               from information_schema.key_column_usage
               where table_schema = ? and table_name = ? and referenced_table_name is not null`,
              [db, table],
            ),
            rawQuery<{ INDEX_NAME: string; NON_UNIQUE: number; SEQ_IN_INDEX: number; COLUMN_NAME: string }>(
              `select index_name as INDEX_NAME, non_unique as NON_UNIQUE,
                      seq_in_index as SEQ_IN_INDEX, column_name as COLUMN_NAME
               from information_schema.statistics
               where table_schema = ? and table_name = ? order by index_name, seq_in_index`,
              [db, table],
            ),
            rawQuery<{ TABLE_TYPE: string; TABLE_ROWS: number | null }>(
              `select table_type as TABLE_TYPE, table_rows as TABLE_ROWS
               from information_schema.tables where table_schema = ? and table_name = ?`,
              [db, table],
            ),
          ],
          { concurrency: 4 },
        );
        if (cols.length === 0) {
          return yield* Effect.fail(new NotFound({ entity: "table", id: `${db}.${table}` }));
        }
        const fkByColumn = new Map(
          fks.map((f) => [
            f.COLUMN_NAME,
            { table: `${f.REFERENCED_TABLE_SCHEMA}.${f.REFERENCED_TABLE_NAME}`, column: f.REFERENCED_COLUMN_NAME },
          ]),
        );
        const columns: Array<ColumnMeta> = cols.map((c) => ({
          name: c.COLUMN_NAME,
          type: c.COLUMN_TYPE,
          nullable: c.IS_NULLABLE === "YES",
          isPrimaryKey: c.COLUMN_KEY === "PRI",
          ...(fkByColumn.has(c.COLUMN_NAME) ? { foreignKey: fkByColumn.get(c.COLUMN_NAME)! } : {}),
          ...(c.COLUMN_DEFAULT !== null ? { default: c.COLUMN_DEFAULT } : {}),
        }));
        const grouped = new Map<string, { unique: boolean; columns: Array<string> }>();
        for (const s of stats) {
          const entry = grouped.get(s.INDEX_NAME) ?? { unique: s.NON_UNIQUE === 0, columns: [] };
          entry.columns.push(s.COLUMN_NAME);
          grouped.set(s.INDEX_NAME, entry);
        }
        const indexes: Array<IndexMeta> = [...grouped.entries()].map(([name, e]): IndexMeta => ({
          name,
          columns: e.columns,
          unique: e.unique,
          definition: `${e.unique ? "UNIQUE " : ""}KEY \`${name}\` (${e.columns.map((c) => `\`${c}\``).join(", ")})`,
        }));
        return {
          table: {
            schema: db,
            name: table,
            kind: meta[0]?.TABLE_TYPE === "VIEW" ? "view" : "table",
            rowEstimate: Number(meta[0]?.TABLE_ROWS ?? 0) || 0,
          },
          columns,
          indexes,
        } satisfies TableDetail;
      }).pipe(
        Effect.catchTag("SqlError", (e): Effect.Effect<never, DriverError | NotFound> => Effect.fail(new DriverError({ dialect: "mysql", message: e.message }))),
      );

    /* ---- rows ---- */
    const rows = (req: RowsRequest): Effect.Effect<RowsPage, DriverError | SqlError> =>
      Effect.gen(function* () {
        const normalised: RowsRequest = { ...req, schema: req.schema.length > 0 ? req.schema : defaultSchema };
        const built = buildRowsQuery("mysql", normalised);
        const page = yield* Effect.tryPromise({
          try: async () => {
            const [data, fields] = await pool.query(
              { sql: built.text, rowsAsArray: true },
              built.params as Array<unknown>,
            );
            return {
              rows: (Array.isArray(data) ? data : []) as unknown as Array<Array<unknown>>,
              fields: (fields ?? []) as unknown as ReadonlyArray<MysqlField>,
            };
          },
          catch: toSqlError,
        });
        const detail = yield* describeTable(normalised.schema, req.table).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        );
        const metaByName = new Map((detail?.columns ?? []).map((c) => [c.name, c]));
        const columns: Array<ColumnMeta> = page.fields.map((f) => metaByName.get(f.name) ?? mysqlColumnMeta(f));
        const total = yield* totalFor(normalised, detail?.table.rowEstimate ?? 0);
        return {
          columns,
          rows: toJsonSafeRows(page.rows),
          ...(total !== undefined ? { total } : {}),
          truncated: page.rows.length >= req.limit,
        } satisfies RowsPage;
      });

    const totalFor = (req: RowsRequest, estimate: number): Effect.Effect<number | undefined, never> =>
      Effect.gen(function* () {
        if (!hasFilters(req) && estimate >= EXACT_COUNT_THRESHOLD) return estimate;
        const count = buildCountQuery("mysql", req);
        const res = yield* rawQuery<{ total: number }>(count.text, count.params);
        return Number(res[0]?.total ?? 0);
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));

    /* ---- write path (readOnly: false) ---- */
    /**
     * Data-changing statements do not stream: mysql2 answers them with a
     * `ResultSetHeader`, so `affectedRows` is the only meaningful count. The
     * whole text runs inside one explicit transaction (`beginTransaction` …
     * `commit`, rolled back on any error) with each `;`-separated statement
     * executed in order, so a multi-statement `propose_write` is atomic without
     * having to turn on mysql2's `multipleStatements`.
     */
    const runWrite = (
      sqlText: string,
      timeoutMs: number,
      hardLimit: number | undefined,
    ): Effect.Effect<RowBatch, DriverError | SqlError> =>
      Effect.tryPromise({
        try: async () => {
          const statements = splitStatements(sqlText);
          const conn = await pool.getConnection();
          try {
            await conn.query(`SET SESSION max_execution_time = ${timeoutMs}`).catch(() => undefined);
            await conn.beginTransaction();
            let affectedRows = 0;
            let rows: Array<Array<unknown>> = [];
            let fields: ReadonlyArray<MysqlField> = [];
            try {
              for (const statement of statements.length > 0 ? statements : [sqlText]) {
                const [data, f] = await conn.query({ sql: statement, rowsAsArray: true });
                if (Array.isArray(data)) {
                  // A result set (e.g. a SELECT mixed into the batch).
                  rows = data as unknown as Array<Array<unknown>>;
                  fields = (f ?? []) as unknown as ReadonlyArray<MysqlField>;
                } else {
                  affectedRows += Number((data as { affectedRows?: number }).affectedRows ?? 0);
                  rows = [];
                  fields = [];
                }
              }
              await conn.commit();
            } catch (e) {
              await conn.rollback().catch(() => undefined);
              throw e;
            }
            return { affectedRows, rows, fields };
          } finally {
            try {
              conn.release();
            } catch {
              /* ignore */
            }
          }
        },
        catch: toSqlError,
      }).pipe(
        Effect.map(
          (res): RowBatch => ({
            columns: res.fields.map(mysqlColumnMeta),
            rows: toJsonSafeRows(hardLimit === undefined ? res.rows : res.rows.slice(0, hardLimit)),
            affectedRows: res.affectedRows,
          }),
        ),
      );

    /* ---- query (streaming) ---- */
    const query = (
      sqlText: string,
      options?: QueryOptions,
    ): Stream.Stream<RowBatch, DriverError | SqlError | WriteBlocked> => {
      const readOnly = options?.readOnly === true;
      const timeoutMs = Math.max(1, Math.trunc(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS));
      const hardLimit = options?.limit;

      if (!readOnly) return Stream.fromEffect(runWrite(sqlText, timeoutMs, hardLimit));

      const setup = Effect.gen(function* () {
        {
          const verdict = isReadOnlySql(sqlText, "mysql");
          if (!verdict.readOnly) {
            return yield* Effect.fail(
              new WriteBlocked({ sql: sqlText, reason: verdict.reason ?? "statement is not a read" }),
            );
          }
        }

        const conn = yield* Effect.acquireRelease(
          Effect.tryPromise({ try: () => pool.getConnection(), catch: toDriverError }),
          (c) =>
            Effect.promise(async () => {
              try {
                await c.query("ROLLBACK");
              } catch {
                /* connection may already be dead */
              }
              try {
                c.release();
              } catch {
                /* ignore */
              }
            }),
        );

        const threadId = (conn as unknown as { threadId?: number; connection?: { threadId?: number } }).threadId
          ?? (conn as unknown as { connection?: { threadId?: number } }).connection?.threadId
          ?? 0;

        yield* Effect.tryPromise({
          try: async () => {
            await conn.query(`SET SESSION max_execution_time = ${timeoutMs}`).catch(() => undefined);
            await conn.query("START TRANSACTION READ ONLY");
          },
          catch: toSqlError,
        });

        const iterator = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const core = (conn as unknown as { connection: { query: (opts: unknown) => unknown } }).connection;
            const q = core.query({ sql: sqlText, rowsAsArray: true }) as {
              stream: (o?: { highWaterMark?: number }) => NodeJS.ReadableStream;
              on: (event: string, cb: (arg: unknown) => void) => unknown;
            };
            let fields: ReadonlyArray<MysqlField> = [];
            q.on("fields", (f) => {
              fields = (Array.isArray(f) ? f : []) as ReadonlyArray<MysqlField>;
            });
            const readable = q.stream({ highWaterMark: BATCH_SIZE });
            const iter = (readable as unknown as AsyncIterable<Array<unknown>>)[Symbol.asyncIterator]();
            return { iter, getFields: () => fields, readable };
          }),
          (s) =>
            Effect.promise(async () => {
              try {
                await s.iter.return?.(undefined);
              } catch {
                /* ignore */
              }
            }),
        );

        let emitted = 0;
        let finished = false;
        let columns: ReadonlyArray<ColumnMeta> | undefined;

        const readBatch = Effect.callback<Array<Array<unknown>>, SqlError>((resume) => {
          let settled = false;
          const want = hardLimit === undefined ? BATCH_SIZE : Math.max(0, Math.min(BATCH_SIZE, hardLimit - emitted));
          if (want === 0) {
            resume(Effect.succeed([]));
            return;
          }
          void (async () => {
            const batch: Array<Array<unknown>> = [];
            try {
              while (batch.length < want) {
                const next = await iterator.iter.next();
                if (next.done === true) break;
                batch.push(next.value);
              }
              settled = true;
              resume(Effect.succeed(batch));
            } catch (e) {
              settled = true;
              resume(Effect.fail(toSqlError(e)));
            }
          })();
          return Effect.suspend(() => (settled || threadId === 0 ? Effect.void : killQuery(threadId)));
        });

        const pull: Effect.Effect<readonly [RowBatch, ...Array<RowBatch>], SqlError | Cause.Done<void>> =
          Effect.gen(function* () {
            if (finished) return yield* Effect.fail(Cause.Done());
            const batch = yield* readBatch;
            if (columns === undefined) {
              const fields = iterator.getFields();
              if (fields.length > 0) columns = fields.map(mysqlColumnMeta);
            }
            if (batch.length === 0) {
              finished = true;
              return yield* Effect.fail(Cause.Done());
            }
            emitted += batch.length;
            if (hardLimit !== undefined && emitted >= hardLimit) finished = true;
            return [{ columns: columns ?? [], rows: toJsonSafeRows(batch) }] as const;
          });

        return pull;
      });

      return Stream.scoped(Stream.fromPull(setup));
    };

    /* ---- explain ---- */
    const explain = (sqlText: string): Effect.Effect<string, DriverError | SqlError> =>
      Effect.suspend(() => {
        // One statement, no `ANALYZE` (EXPLAIN ANALYZE executes it in MySQL 8).
        const blocked = explainGuard(sqlText, "mysql");
        if (blocked !== undefined) return Effect.fail(new SqlError({ message: blocked, code: "EXPLAIN_BLOCKED" }));
        const statement = splitForDialect(sqlText, "mysql")[0]!;
        return rawQuery<Record<string, unknown>>(`EXPLAIN FORMAT=TREE ${statement}`).pipe(
          Effect.catch(() => rawQuery<Record<string, unknown>>(`EXPLAIN ${statement}`)),
        );
      }).pipe(
        Effect.map((res) =>
          res
            .map((r) => {
              const values = Object.values(r);
              return values.length === 1 ? String(values[0]) : JSON.stringify(r);
            })
            .join("\n"),
        ),
      );

    const driver: Driver = {
      dialect: "mysql",
      ping,
      introspect,
      describeTable,
      rows,
      query,
      explain,
      close: Effect.promise(() => pool.end().catch(() => undefined)),
    };
    return driver;
  });
