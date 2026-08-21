/**
 * SQLite driver (`bun:sqlite`).
 *
 * `bun:sqlite` is synchronous, so there is nothing to cancel; read-only
 * enforcement is the classifier plus `PRAGMA query_only = ON` around the
 * statement. There is a single schema, reported as `main`.
 *
 * `readOnly: false` takes a separate path (`runWrite`) that runs each
 * `;`-separated statement inside an explicit `BEGIN … COMMIT` and reports the
 * summed `changes()` as `RowBatch.affectedRows`.
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
import { Database } from "bun:sqlite";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { Driver, QueryOptions, RowBatch } from "../Services/DriverRegistry.ts";
import { splitStatements } from "../sql/statements.ts";
import { explainGuard, isReadOnlySql, splitStatements as splitForDialect } from "./classify.ts";
import { toJsonSafeRows } from "./jsonSafe.ts";
import { buildCountQuery, buildRowsQuery, quoteIdent } from "./queryBuilder.ts";

export const SQLITE_SCHEMA = "main";

const BATCH_SIZE = 500;

export interface SqliteConfig {
  /** Path to the database file. `:memory:` works for tests. */
  readonly filename: string;
  readonly readonly?: boolean | undefined;
}

const errMessage = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);

const toSqlError = (e: unknown): SqlError => new SqlError({ message: errMessage(e) });

/** Storage class of a JS value, used when neither declared nor runtime types help. */
const typeOfValue = (v: unknown): string | undefined => {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "real";
  if (typeof v === "bigint") return "integer";
  if (typeof v === "boolean") return "integer";
  if (typeof v === "string") return "text";
  if (v instanceof Uint8Array || ArrayBuffer.isView(v)) return "blob";
  return undefined;
};

/**
 * SQLite is dynamically typed, so a result-set column has no single type. In
 * order of usefulness: the column's *declared* type (`sqlite3_column_decltype`,
 * only present when the column comes straight from a table), the runtime
 * storage class of the first row (`sqlite3_column_type`), then the JS type of
 * the first value.
 */
export const sqliteColumnMeta = (args: {
  readonly names: ReadonlyArray<string>;
  readonly declared: ReadonlyArray<string | null | undefined>;
  readonly runtime: ReadonlyArray<string | null | undefined>;
  readonly firstRow: ReadonlyArray<unknown> | undefined;
}): Array<ColumnMeta> =>
  args.names.map((name, i) => {
    const declared = args.declared[i];
    const runtime = args.runtime[i];
    const type =
      (typeof declared === "string" && declared.length > 0 ? declared.toLowerCase() : undefined) ??
      (typeof runtime === "string" && runtime.length > 0 && runtime.toUpperCase() !== "NULL"
        ? runtime.toLowerCase()
        : undefined) ??
      typeOfValue(args.firstRow?.[i]) ??
      "unknown";
    // A result set carries no nullability or key information.
    return { name, type, nullable: true, isPrimaryKey: false };
  });

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}
interface FkRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
}
interface IndexListRow {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
}
interface IndexInfoRow {
  seqno: number;
  cid: number;
  name: string | null;
}

export const makeSqliteDriver = (cfg: SqliteConfig): Effect.Effect<Driver, ConnectionError> =>
  Effect.gen(function* () {
    const db = yield* Effect.try({
      try: () =>
        new Database(cfg.filename, cfg.readonly === true ? { readonly: true } : { create: true, readwrite: true }),
      catch: (e) => new ConnectionError({ message: `could not open ${cfg.filename}: ${errMessage(e)}` }),
    });

    /**
     * Reads run on a second, `readonly` handle to the same file so the
     * read-only guarantee does not depend on `PRAGMA query_only` being toggled
     * on a handle shared with the write path (fibers interleave). An in-memory
     * database cannot be shared across handles, so it falls back to `db`.
     */
    const readDb: Database =
      cfg.filename === ":memory:" || cfg.filename.length === 0
        ? db
        : yield* Effect.try({
            try: () => new Database(cfg.filename, { readonly: true }),
            catch: (e) => new ConnectionError({ message: `could not open ${cfg.filename} read-only: ${errMessage(e)}` }),
          });

    const all = <T>(sql: string, params: ReadonlyArray<unknown> = []): Effect.Effect<Array<T>, SqlError> =>
      Effect.try({
        try: () => db.query(sql).all(...(params as Array<never>)) as Array<T>,
        catch: toSqlError,
      });

    /** Reads the three type sources off a prepared statement, defensively. */
    const stmtTypes = (stmt: {
      columnNames?: ReadonlyArray<string>;
      declaredTypes?: ReadonlyArray<string | null>;
      columnTypes?: ReadonlyArray<string | null>;
    }) => {
      const read = <T>(f: () => ReadonlyArray<T> | undefined): ReadonlyArray<T> => {
        try {
          return f() ?? [];
        } catch {
          return [];
        }
      };
      return {
        names: read(() => stmt.columnNames),
        declared: read(() => stmt.declaredTypes),
        runtime: read(() => stmt.columnTypes),
      };
    };

    const valuesOf = (
      sql: string,
      params: ReadonlyArray<unknown> = [],
      on: Database = db,
    ): Effect.Effect<{ columns: Array<ColumnMeta>; rows: Array<Array<unknown>> }, SqlError> =>
      Effect.try({
        try: () => {
          const stmt = on.query(sql);
          const meta = stmtTypes(stmt);
          // `values()` returns null for statements that produce no result set.
          const rows = (stmt.values(...(params as Array<never>)) as Array<Array<unknown>> | null) ?? [];
          return { columns: sqliteColumnMeta({ ...meta, firstRow: rows[0] }), rows };
        },
        catch: toSqlError,
      });

    const exec = (sql: string): Effect.Effect<void, SqlError> =>
      Effect.try({ try: () => void db.exec(sql), catch: toSqlError });

    /* ---- ping ---- */
    const ping = Effect.gen(function* () {
      const started = Date.now();
      const rows = yield* all<{ v: string }>("select sqlite_version() as v");
      return { latencyMs: Date.now() - started, ...(rows[0] ? { serverVersion: `SQLite ${rows[0].v}` } : {}) };
    }).pipe(Effect.mapError((e) => new DriverError({ dialect: "sqlite", message: e.message })));

    /* ---- introspect ---- */
    const introspect = Effect.gen(function* () {
      const objs = yield* all<{ name: string; type: string }>(
        `select name, type from sqlite_master
         where type in ('table', 'view') and name not like 'sqlite_%'
         order by type, name`,
      );
      const tables: Array<TableMeta> = [];
      for (const o of objs) {
        const kind = o.type === "view" ? "view" : "table";
        const estimate =
          kind === "table"
            ? yield* all<{ n: number }>(`select count(*) as n from ${quoteIdent("sqlite", o.name)}`).pipe(
                Effect.map((r) => Number(r[0]?.n ?? 0)),
                Effect.catch(() => Effect.succeed(0)),
              )
            : 0;
        tables.push({ schema: SQLITE_SCHEMA, name: o.name, kind, rowEstimate: estimate });
      }
      return [{ name: SQLITE_SCHEMA, tables }] satisfies ReadonlyArray<SchemaMeta>;
    }).pipe(Effect.mapError((e) => new DriverError({ dialect: "sqlite", message: e.message })));

    /* ---- describeTable ---- */
    const describeTable = (
      schema: string,
      table: string,
    ): Effect.Effect<TableDetail, DriverError | NotFound> =>
      Effect.gen(function* () {
        const quoted = quoteIdent("sqlite", table);
        const info = yield* all<TableInfoRow>(`pragma table_info(${quoted})`);
        if (info.length === 0) {
          return yield* Effect.fail(new NotFound({ entity: "table", id: `${schema}.${table}` }));
        }
        const fks = yield* all<FkRow>(`pragma foreign_key_list(${quoted})`);
        const fkByColumn = new Map(
          fks.map((f) => [f.from, { table: f.table, column: f.to ?? "" }] as const),
        );
        const columns: Array<ColumnMeta> = info.map((c) => ({
          name: c.name,
          type: c.type === "" ? "blob" : c.type,
          nullable: c.notnull === 0,
          isPrimaryKey: c.pk > 0,
          ...(fkByColumn.has(c.name) ? { foreignKey: fkByColumn.get(c.name)! } : {}),
          ...(c.dflt_value !== null ? { default: c.dflt_value } : {}),
        }));

        const idxList = yield* all<IndexListRow>(`pragma index_list(${quoted})`);
        const defs = yield* all<{ name: string; sql: string | null }>(
          `select name, sql from sqlite_master where type = 'index' and tbl_name = ?`,
          [table],
        );
        const defByName = new Map(defs.map((d) => [d.name, d.sql]));
        const indexes: Array<IndexMeta> = [];
        for (const ix of idxList) {
          const cols = yield* all<IndexInfoRow>(`pragma index_info(${quoteIdent("sqlite", ix.name)})`);
          indexes.push({
            name: ix.name,
            columns: cols.map((c) => c.name).filter((n): n is string => n !== null),
            unique: ix.unique === 1,
            definition:
              defByName.get(ix.name) ??
              `${ix.unique === 1 ? "UNIQUE " : ""}INDEX ${ix.name} (implicit, origin=${ix.origin})`,
          });
        }

        const kindRow = yield* all<{ type: string }>(`select type from sqlite_master where name = ?`, [table]);
        const rowEstimate = yield* all<{ n: number }>(`select count(*) as n from ${quoted}`).pipe(
          Effect.map((r) => Number(r[0]?.n ?? 0)),
          Effect.catch(() => Effect.succeed(0)),
        );

        return {
          table: {
            schema: SQLITE_SCHEMA,
            name: table,
            kind: kindRow[0]?.type === "view" ? "view" : "table",
            rowEstimate,
          },
          columns,
          indexes,
        } satisfies TableDetail;
      }).pipe(
        Effect.catchTag("SqlError", (e): Effect.Effect<never, DriverError | NotFound> =>
          /no such table/i.test(e.message)
            ? Effect.fail(new NotFound({ entity: "table", id: `${schema}.${table}` }))
            : Effect.fail(new DriverError({ dialect: "sqlite", message: e.message })),
        ),
      );

    /* ---- rows ---- */
    const rows = (req: RowsRequest): Effect.Effect<RowsPage, DriverError | SqlError> =>
      Effect.gen(function* () {
        // SQLite has one schema; ignore whatever the client sent.
        const normalised: RowsRequest = { ...req, schema: "" };
        const built = buildRowsQuery("sqlite", normalised);
        const page = yield* valuesOf(built.text, built.params);
        const detail = yield* describeTable(SQLITE_SCHEMA, req.table).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        );
        const metaByName = new Map((detail?.columns ?? []).map((c) => [c.name, c]));
        const columns: Array<ColumnMeta> = page.columns.map((c) => metaByName.get(c.name) ?? c);
        const count = buildCountQuery("sqlite", normalised);
        const total = yield* all<{ total: number }>(count.text, count.params).pipe(
          Effect.map((r) => Number(r[0]?.total ?? 0)),
          Effect.catch(() => Effect.succeed(undefined)),
        );
        return {
          columns,
          rows: toJsonSafeRows(page.rows),
          ...(total !== undefined ? { total } : {}),
          truncated: page.rows.length >= req.limit,
        } satisfies RowsPage;
      });

    /* ---- write path (readOnly: false) ---- */
    /**
     * A prepared `bun:sqlite` statement only ever steps the *first* statement of
     * a `;`-separated batch, and its `changes` count is not cumulative, so the
     * text is split and executed one statement at a time inside an explicit
     * `BEGIN … COMMIT` (rolled back on any error). That makes a multi-statement
     * `propose_write` atomic and lets `affectedRows` be a true sum.
     */
    const runWrite = (sqlText: string, hardLimit: number | undefined): Effect.Effect<RowBatch, SqlError> =>
      Effect.try({
        try: () => {
          const statements = splitStatements(sqlText);
          db.exec("BEGIN");
          try {
            let affectedRows = 0;
            let rows: Array<Array<unknown>> = [];
            let meta = { names: [] as ReadonlyArray<string>, declared: [], runtime: [] } as ReturnType<
              typeof stmtTypes
            >;
            for (const statement of statements.length > 0 ? statements : [sqlText]) {
              const stmt = db.query(statement);
              meta = stmtTypes(stmt);
              // `values()` returns null unless the statement has a result set
              // (a plain SELECT, or `INSERT … RETURNING`).
              rows = (stmt.values() as Array<Array<unknown>> | null) ?? [];
              affectedRows += Number((db.query("select changes() as c").get() as { c: number } | null)?.c ?? 0);
            }
            db.exec("COMMIT");
            return {
              columns: sqliteColumnMeta({ ...meta, firstRow: rows[0] }),
              rows: toJsonSafeRows(hardLimit === undefined ? rows : rows.slice(0, hardLimit)),
              affectedRows,
            } satisfies RowBatch;
          } catch (e) {
            try {
              db.exec("ROLLBACK");
            } catch {
              /* no transaction to roll back */
            }
            throw e;
          }
        },
        catch: toSqlError,
      });

    /* ---- query ---- */
    const query = (
      sqlText: string,
      options?: QueryOptions,
    ): Stream.Stream<RowBatch, DriverError | SqlError | WriteBlocked> => {
      const readOnly = options?.readOnly === true;
      if (!readOnly) return Stream.fromEffect(runWrite(sqlText, options?.limit));

      const collect = Effect.gen(function* () {
        const verdict = isReadOnlySql(sqlText, "sqlite");
        if (!verdict.readOnly) {
          return yield* Effect.fail(
            new WriteBlocked({ sql: sqlText, reason: verdict.reason ?? "statement is not a read" }),
          );
        }
        const run = Effect.gen(function* () {
          const res = yield* valuesOf(sqlText, [], readDb);
          const limited =
            options?.limit !== undefined && res.rows.length > options.limit
              ? res.rows.slice(0, options.limit)
              : res.rows;
          const columns = res.columns;
          const batches: Array<RowBatch> = [];
          for (let i = 0; i < limited.length; i += BATCH_SIZE) {
            batches.push({ columns, rows: toJsonSafeRows(limited.slice(i, i + BATCH_SIZE)) });
          }
          return batches.length === 0 ? [{ columns, rows: [] }] : batches;
        });

        if (readDb !== db) return yield* run;
        return yield* Effect.acquireUseRelease(
          exec("PRAGMA query_only = ON"),
          () => run,
          () => exec("PRAGMA query_only = OFF").pipe(Effect.ignore),
        );
      });
      return Stream.unwrap(collect.pipe(Effect.map(Stream.fromArray)));
    };

    /* ---- explain ---- */
    const explain = (sqlText: string): Effect.Effect<string, DriverError | SqlError> =>
      Effect.suspend(() => {
        const blocked = explainGuard(sqlText, "sqlite");
        if (blocked !== undefined) return Effect.fail(new SqlError({ message: blocked, code: "EXPLAIN_BLOCKED" }));
        return all<{ id: number; parent: number; detail: string }>(
          `EXPLAIN QUERY PLAN ${splitForDialect(sqlText, "sqlite")[0]!}`,
        );
      }).pipe(
        Effect.map((res) => res.map((r) => `${"  ".repeat(r.parent > 0 ? 1 : 0)}${r.detail}`).join("\n")),
      );

    const driver: Driver = {
      dialect: "sqlite",
      ping,
      introspect,
      describeTable,
      rows,
      query,
      explain,
      close: Effect.sync(() => {
        for (const handle of readDb === db ? [db] : [readDb, db]) {
          try {
            handle.close();
          } catch {
            /* already closed */
          }
        }
      }),
    };
    return driver;
  }).pipe(Effect.tapError((e) => Effect.logDebug("sqlite driver open failed", { message: e.message })));
