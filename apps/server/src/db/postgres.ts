/**
 * Postgres driver (`pg` Pool + `pg-cursor`).
 *
 * Read-only enforcement is two-layered: the statement must classify as a read
 * *and* it runs inside `BEGIN; SET TRANSACTION READ ONLY; SET LOCAL
 * statement_timeout = …` which is rolled back at the end. Interrupting the
 * `query` stream issues `pg_cancel_backend(pid)` from a second connection.
 *
 * `readOnly: false` takes a separate, non-streaming path (`runWrite`): a cursor
 * only describes a portal, so DML through it reports no rows at all. Writes run
 * as one simple query inside an explicit `BEGIN … COMMIT` — rolled back on any
 * error, which makes a multi-statement `propose_write` atomic — and report
 * `RowBatch.affectedRows`.
 *
 * Result-set columns are named from their type OID (see `pgTypes.ts`). Values
 * are never re-parsed: `int8`/`numeric` stay strings, exactly as `pg` hands
 * them over, so nothing is lost to float precision.
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
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { Client, Pool } from "pg";
import type { PoolClient, PoolConfig } from "pg";
import Cursor from "pg-cursor";

import type { Driver, QueryOptions, RowBatch } from "../Services/DriverRegistry.ts";
import { explainGuard, isReadOnlySql, splitStatements } from "./classify.ts";
import { toJsonSafeRows } from "./jsonSafe.ts";
import { makePgTypeResolver, type PgTypeRow, UNKNOWN_TYPE } from "./pgTypes.ts";
import { buildCountQuery, buildRowsQuery, hasFilters, quoteRelation } from "./queryBuilder.ts";

export interface PostgresConfig {
  readonly url?: string | undefined;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly database?: string | undefined;
  readonly user?: string | undefined;
  readonly password?: string | undefined;
  readonly ssl?: "disable" | "prefer" | "require" | undefined;
  readonly applicationName?: string | undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const BATCH_SIZE = 500;
/** Below this many estimated rows we just run an exact `count(*)`. */
const EXACT_COUNT_THRESHOLD = 50_000;

const toPoolConfig = (cfg: PostgresConfig): PoolConfig => {
  const ssl = cfg.ssl === "require" ? { rejectUnauthorized: false } : false;
  const base = {
    ssl,
    application_name: cfg.applicationName ?? "dbchat",
    max: 4,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  };
  if (cfg.url !== undefined && cfg.url.length > 0) {
    return { ...base, connectionString: cfg.url };
  }
  return {
    ...base,
    ...(cfg.host !== undefined && cfg.host.length > 0 ? { host: cfg.host } : {}),
    ...(cfg.port !== undefined && cfg.port > 0 ? { port: cfg.port } : {}),
    ...(cfg.database !== undefined && cfg.database.length > 0 ? { database: cfg.database } : {}),
    ...(cfg.user !== undefined && cfg.user.length > 0 ? { user: cfg.user } : {}),
    ...(cfg.password !== undefined && cfg.password.length > 0 ? { password: cfg.password } : {}),
  };
};

const errMessage = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);

/** pg errors carry `code` / `position`; keep them for the UI. */
export const toSqlError = (e: unknown): SqlError => {
  const anyErr = e as { code?: unknown; position?: unknown } | null;
  const code = typeof anyErr?.code === "string" ? anyErr.code : undefined;
  const position = anyErr?.position !== undefined ? Number(anyErr.position) : undefined;
  return new SqlError({
    message: errMessage(e),
    ...(code !== undefined ? { code } : {}),
    ...(position !== undefined && Number.isFinite(position) ? { position } : {}),
  });
};

const toDriverError = (e: unknown): DriverError =>
  new DriverError({ dialect: "postgres", message: errMessage(e) });

/* -------------------------------------------------------------------------- */
/*  Introspection SQL                                                          */
/* -------------------------------------------------------------------------- */

const SCHEMAS_SQL = `
  select n.nspname as schema
  from pg_namespace n
  where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
    and n.nspname not like 'pg\\_toast\\_temp%'
    and n.nspname not like 'pg\\_temp%'
  order by 1
`;

const RELATIONS_SQL = `
  select n.nspname as schema,
         c.relname  as name,
         case when c.relkind in ('v', 'm') then 'view' else 'table' end as kind,
         greatest(c.reltuples, 0)::bigint as row_estimate
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p', 'v', 'm', 'f')
    and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
    and n.nspname not like 'pg\\_toast\\_temp%'
    and n.nspname not like 'pg\\_temp%'
  order by 1, 2
`;

const COLUMNS_SQL = `
  select a.attname                                  as name,
         format_type(a.atttypid, a.atttypmod)       as type,
         not a.attnotnull                           as nullable,
         pg_get_expr(d.adbin, d.adrelid)            as "default",
         coalesce(pk.is_pk, false)                  as is_pk
  from pg_attribute a
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  left join lateral (
    select true as is_pk
    from pg_index i
    where i.indrelid = a.attrelid and i.indisprimary and a.attnum = any(i.indkey)
    limit 1
  ) pk on true
  where a.attrelid = $1::regclass
    and a.attnum > 0
    and not a.attisdropped
  order by a.attnum
`;

const FKS_SQL = `
  select att.attname     as column,
         nsp.nspname      as ref_schema,
         cl.relname       as ref_table,
         refatt.attname   as ref_column
  from pg_constraint con
  cross join lateral unnest(con.conkey, con.confkey) as k(conkey, confkey)
  join pg_attribute att    on att.attrelid = con.conrelid  and att.attnum = k.conkey
  join pg_class cl         on cl.oid = con.confrelid
  join pg_namespace nsp    on nsp.oid = cl.relnamespace
  join pg_attribute refatt on refatt.attrelid = con.confrelid and refatt.attnum = k.confkey
  where con.conrelid = $1::regclass and con.contype = 'f'
`;

const INDEXES_SQL = `
  select i.relname                      as name,
         ix.indisunique                  as unique,
         pg_get_indexdef(ix.indexrelid)  as definition,
         array(
           select pg_get_indexdef(ix.indexrelid, k + 1, true)
           from generate_subscripts(ix.indkey, 1) as k
           order by k
         )                               as columns
  from pg_index ix
  join pg_class i on i.oid = ix.indexrelid
  where ix.indrelid = $1::regclass
  order by 1
`;

const RELINFO_SQL = `
  select greatest(reltuples, 0)::bigint as estimate,
         case when relkind in ('v', 'm') then 'view' else 'table' end as kind
  from pg_class where oid = $1::regclass
`;

/**
 * One sweep per pool; picks up enums, domains, composites and extension types.
 * Array types are reported as `elem[]` rather than the raw `_elem` typname so
 * they read the same way as `format_type`.
 */
const PG_TYPE_SWEEP_SQL = `
  select t.oid::int8 as oid,
         case when t.typcategory = 'A' and t.typelem <> 0
              then coalesce(e.typname, t.typname) || '[]'
              else t.typname end as name
  from pg_type t
  left join pg_type e on e.oid = t.typelem
`;

/** Last-resort lookup for OIDs created after the sweep. */
const PG_TYPE_BY_OID_SQL = `select o::int8 as oid, format_type(o, null) as name from unnest($1::oid[]) as o`;

/* -------------------------------------------------------------------------- */
/*  Driver                                                                     */
/* -------------------------------------------------------------------------- */

export const makePostgresDriver = (cfg: PostgresConfig): Effect.Effect<Driver, ConnectionError> =>
  Effect.gen(function* () {
    const poolConfig = toPoolConfig(cfg);
    const pool = yield* Effect.try({
      try: () => new Pool(poolConfig),
      catch: (e) => new ConnectionError({ message: `could not create a Postgres pool: ${errMessage(e)}` }),
    });
    // A pool that emits `error` with no listener kills the process.
    pool.on("error", () => {});

    /** Run `fn` with a pooled client; the client always goes back to the pool. */
    const withClient = <A, E>(
      fn: (client: PoolClient) => Promise<A>,
      onError: (e: unknown) => E,
    ): Effect.Effect<A, E> =>
      Effect.tryPromise({
        try: async () => {
          const client = await pool.connect();
          try {
            return await fn(client);
          } finally {
            client.release();
          }
        },
        catch: onError,
      });

    const rawQuery = <T = Record<string, unknown>>(
      text: string,
      params: ReadonlyArray<unknown> = [],
    ): Effect.Effect<Array<T>, SqlError> =>
      withClient(async (client) => {
        const res = await client.query(text, params as Array<unknown>);
        return res.rows as Array<T>;
      }, toSqlError);

    /** Cancel the backend running on `pid` using a fresh, separate connection. */
    const cancelBackend = (pid: number): Effect.Effect<void> =>
      Effect.promise(async () => {
        const client = new Client(poolConfig);
        try {
          await client.connect();
          await client.query("select pg_cancel_backend($1)", [pid]);
        } catch {
          /* best effort */
        } finally {
          try {
            await client.end();
          } catch {
            /* ignore */
          }
        }
      });

    /* ---- result-set column types (OID → name) ---- */
    const types = makePgTypeResolver({
      loadCatalog: rawQuery<{ oid: string | number; name: string }>(PG_TYPE_SWEEP_SQL).pipe(
        Effect.map((rows): ReadonlyArray<PgTypeRow> => rows.map((r) => ({ oid: Number(r.oid), name: r.name }))),
      ),
      formatTypes: (oids) =>
        rawQuery<{ oid: string | number; name: string }>(PG_TYPE_BY_OID_SQL, [oids as Array<number>]).pipe(
          Effect.map((rows): ReadonlyArray<PgTypeRow> => rows.map((r) => ({ oid: Number(r.oid), name: r.name }))),
        ),
    });

    /** `ColumnMeta` for a result set; pg only tells us the name + type OID. */
    const columnsOf = (
      fields: ReadonlyArray<{ name: string; dataTypeID?: number | undefined }>,
    ): Effect.Effect<Array<ColumnMeta>> =>
      Effect.gen(function* () {
        const names = yield* types.resolve(fields.map((f) => f.dataTypeID ?? 0));
        return fields.map((f) => ({
          name: f.name,
          type: names.get(f.dataTypeID ?? 0) ?? UNKNOWN_TYPE,
          // A result set carries no nullability or key information.
          nullable: true,
          isPrimaryKey: false,
        }));
      });

    /* ---- ping ---- */
    const ping = Effect.gen(function* () {
      const started = Date.now();
      const rows = yield* rawQuery<{ version: string }>("select version()").pipe(
        Effect.mapError((e) => new DriverError({ dialect: "postgres", message: e.message })),
      );
      return { latencyMs: Date.now() - started, ...(rows[0] ? { serverVersion: rows[0].version } : {}) };
    });

    /* ---- introspect ---- */
    const introspect = Effect.gen(function* () {
      const [schemas, relations] = yield* Effect.all(
        [
          rawQuery<{ schema: string }>(SCHEMAS_SQL),
          rawQuery<{ schema: string; name: string; kind: string; row_estimate: string | number }>(RELATIONS_SQL),
        ],
        { concurrency: 2 },
      );
      const bySchema = new Map<string, Array<TableMeta>>();
      for (const s of schemas) bySchema.set(s.schema, []);
      for (const r of relations) {
        const list = bySchema.get(r.schema) ?? [];
        list.push({
          schema: r.schema,
          name: r.name,
          kind: r.kind === "view" ? "view" : "table",
          rowEstimate: Number(r.row_estimate) || 0,
        });
        bySchema.set(r.schema, list);
      }
      return [...bySchema.entries()].map(([name, tables]): SchemaMeta => ({ name, tables }));
    }).pipe(Effect.mapError((e) => new DriverError({ dialect: "postgres", message: e.message })));

    /* ---- describeTable ---- */
    const describeTable = (
      schema: string,
      table: string,
    ): Effect.Effect<TableDetail, DriverError | NotFound> =>
      Effect.gen(function* () {
        const rel = quoteRelation("postgres", schema, table);
        const [cols, fks, idx, meta] = yield* Effect.all(
          [
            rawQuery<{ name: string; type: string; nullable: boolean; default: string | null; is_pk: boolean }>(
              COLUMNS_SQL,
              [rel],
            ),
            rawQuery<{ column: string; ref_schema: string; ref_table: string; ref_column: string }>(FKS_SQL, [rel]),
            rawQuery<{ name: string; unique: boolean; definition: string; columns: Array<string | null> }>(
              INDEXES_SQL,
              [rel],
            ),
            rawQuery<{ estimate: string | number; kind: string }>(RELINFO_SQL, [rel]),
          ],
          { concurrency: 4 },
        );
        if (cols.length === 0) {
          return yield* Effect.fail(new NotFound({ entity: "table", id: `${schema}.${table}` }));
        }
        const fkByColumn = new Map(
          fks.map((f) => [f.column, { table: `${f.ref_schema}.${f.ref_table}`, column: f.ref_column }]),
        );
        const columns: Array<ColumnMeta> = cols.map((c) => ({
          name: c.name,
          type: c.type,
          nullable: c.nullable,
          isPrimaryKey: c.is_pk,
          ...(fkByColumn.has(c.name) ? { foreignKey: fkByColumn.get(c.name)! } : {}),
          ...(c.default !== null ? { default: c.default } : {}),
        }));
        const indexes: Array<IndexMeta> = idx.map((i) => ({
          name: i.name,
          columns: i.columns.filter((c): c is string => typeof c === "string" && c.length > 0),
          unique: i.unique,
          definition: i.definition,
        }));
        const detail: TableDetail = {
          table: {
            schema,
            name: table,
            kind: meta[0]?.kind === "view" ? "view" : "table",
            rowEstimate: Number(meta[0]?.estimate ?? 0) || 0,
          },
          columns,
          indexes,
        };
        return detail;
      }).pipe(
        Effect.catchTag("SqlError", (e): Effect.Effect<never, DriverError | NotFound> =>
          /does not exist/i.test(e.message)
            ? Effect.fail(new NotFound({ entity: "table", id: `${schema}.${table}` }))
            : Effect.fail(new DriverError({ dialect: "postgres", message: e.message })),
        ),
      );

    /* ---- rows ---- */
    const rows = (req: RowsRequest): Effect.Effect<RowsPage, DriverError | SqlError> =>
      Effect.gen(function* () {
        const rel = quoteRelation("postgres", req.schema, req.table);
        const built = buildRowsQuery("postgres", req);
        const page = yield* withClient(async (client) => {
          const res = await client.query({
            text: built.text,
            values: built.params as Array<unknown>,
            rowMode: "array",
          });
          return { fields: res.fields, rows: res.rows as unknown as Array<Array<unknown>> };
        }, toSqlError);

        const detail = yield* describeTable(req.schema, req.table).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        );
        const metaByName = new Map((detail?.columns ?? []).map((c) => [c.name, c]));
        const fromOids = yield* columnsOf(page.fields);
        const columns: Array<ColumnMeta> = page.fields.map(
          (f, i) => metaByName.get(f.name) ?? fromOids[i] ?? { name: f.name, type: UNKNOWN_TYPE, nullable: true, isPrimaryKey: false },
        );

        const total = yield* estimateTotal(req, rel);
        return {
          columns,
          rows: toJsonSafeRows(page.rows),
          ...(total !== undefined ? { total } : {}),
          truncated: page.rows.length >= req.limit,
        } satisfies RowsPage;
      });

    const estimateTotal = (req: RowsRequest, rel: string): Effect.Effect<number | undefined, SqlError> =>
      Effect.gen(function* () {
        if (hasFilters(req)) {
          const count = buildCountQuery("postgres", req);
          const res = yield* rawQuery<{ total: string | number }>(count.text, count.params);
          return Number(res[0]?.total ?? 0);
        }
        const est = yield* rawQuery<{ estimate: string | number }>(RELINFO_SQL, [rel]);
        const estimate = Number(est[0]?.estimate ?? 0) || 0;
        if (estimate >= EXACT_COUNT_THRESHOLD) return estimate;
        const count = buildCountQuery("postgres", req);
        const res = yield* rawQuery<{ total: string | number }>(count.text, count.params);
        return Number(res[0]?.total ?? 0);
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));

    /* ---- write path (readOnly: false) ---- */
    /**
     * Data-changing statements never go through the cursor: a cursor only
     * describes a portal, so `UPDATE`/`INSERT`/`DELETE` would report zero rows.
     * Instead the whole text runs as one simple query inside an explicit
     * `BEGIN … COMMIT` (rolled back on any error), so a multi-statement
     * proposal from `propose_write` is atomic, and `rowCount` — summed across
     * every statement — comes back as `affectedRows`.
     */
    const runWrite = (
      sqlText: string,
      timeoutMs: number,
      hardLimit: number | undefined,
    ): Effect.Effect<RowBatch, DriverError | SqlError> =>
      Effect.gen(function* () {
        const executed = yield* Effect.tryPromise({
          try: async () => {
            const client = await pool.connect();
            let committed = false;
            try {
              await client.query(`SET statement_timeout = ${Math.max(1, Math.trunc(timeoutMs))}`);
              await client.query("BEGIN");
              const res = await client.query({ text: sqlText, rowMode: "array" });
              await client.query("COMMIT");
              committed = true;
              const results = (Array.isArray(res) ? res : [res]) as Array<{
                rowCount: number | null;
                rows: Array<Array<unknown>>;
                fields: ReadonlyArray<{ name: string; dataTypeID?: number }>;
              }>;
              let affectedRows = 0;
              for (const r of results) affectedRows += r.rowCount ?? 0;
              // Only the last statement's result set is reported (RETURNING).
              const last = results[results.length - 1];
              return {
                affectedRows,
                rows: last?.rows ?? [],
                fields: last?.fields ?? [],
              };
            } catch (e) {
              try {
                await client.query("ROLLBACK");
              } catch {
                /* connection may already be dead */
              }
              throw e;
            } finally {
              client.release(committed ? undefined : true);
            }
          },
          catch: toSqlError,
        });

        const columns = yield* columnsOf(executed.fields);
        const rows = hardLimit === undefined ? executed.rows : executed.rows.slice(0, hardLimit);
        return { columns, rows: toJsonSafeRows(rows), affectedRows: executed.affectedRows } satisfies RowBatch;
      });

    /* ---- query (streaming) ---- */
    const query = (
      sqlText: string,
      options?: QueryOptions,
    ): Stream.Stream<RowBatch, DriverError | SqlError | WriteBlocked> => {
      const readOnly = options?.readOnly === true;
      const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const hardLimit = options?.limit;

      if (!readOnly) return Stream.fromEffect(runWrite(sqlText, timeoutMs, hardLimit));

      const setup = Effect.gen(function* () {
        {
          const verdict = isReadOnlySql(sqlText, "postgres");
          if (!verdict.readOnly) {
            return yield* Effect.fail(
              new WriteBlocked({ sql: sqlText, reason: verdict.reason ?? "statement is not a read" }),
            );
          }
        }

        // Dedicated client for the whole stream, released with the scope.
        const client = yield* Effect.acquireRelease(
          Effect.tryPromise({ try: () => pool.connect(), catch: toDriverError }),
          (c, exit) =>
            Effect.promise(async () => {
              try {
                await c.query("ROLLBACK");
              } catch {
                /* connection may already be dead */
              }
              // Destroy the connection when the stream was interrupted or failed;
              // a cancelled backend leaves the session in an unclear state.
              c.release(Exit.isSuccess(exit) ? undefined : true);
            }),
        );

        const pid = (client as unknown as { processID?: number }).processID ?? 0;

        yield* Effect.tryPromise({
          try: async () => {
            await client.query("BEGIN");
            await client.query("SET TRANSACTION READ ONLY");
            await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.trunc(timeoutMs))}`);
          },
          catch: toSqlError,
        });

        const cursor = yield* Effect.acquireRelease(
          Effect.sync(() => client.query(new Cursor(sqlText, [], { rowMode: "array" }) as never) as unknown as Cursor),
          (c) => Effect.promise(() => new Promise<void>((resolve) => c.close(() => resolve()))),
        );

        let emitted = 0;
        let finished = false;
        let columns: ReadonlyArray<ColumnMeta> | undefined;

        const readBatch = Effect.callback<
          { rows: Array<Array<unknown>>; fields: ReadonlyArray<{ name: string; dataTypeID?: number }> },
          SqlError
        >((resume) => {
          let settled = false;
          const want = hardLimit === undefined ? BATCH_SIZE : Math.max(0, Math.min(BATCH_SIZE, hardLimit - emitted));
          if (want === 0) {
            return void resume(Effect.succeed({ rows: [], fields: [] }));
          }
          cursor.read(want, (err, batch, result) => {
            settled = true;
            if (err) resume(Effect.fail(toSqlError(err)));
            else resume(Effect.succeed({ rows: batch, fields: result?.fields ?? [] }));
          });
          // Interruption while the read is in flight => cancel the backend.
          return Effect.suspend(() => (settled || pid === 0 ? Effect.void : cancelBackend(pid)));
        });

        const pull: Effect.Effect<readonly [RowBatch, ...Array<RowBatch>], SqlError | Cause.Done<void>> =
          Effect.gen(function* () {
            if (finished) return yield* Effect.fail(Cause.Done());
            const { rows: batch, fields } = yield* readBatch;
            if (columns === undefined && fields.length > 0) {
              columns = yield* columnsOf(fields);
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
    /**
     * Planning only: one statement, no `ANALYZE`, inside a READ ONLY transaction
     * with a statement timeout, sent over the extended protocol (which makes
     * Postgres itself reject a `;`-separated batch).
     */
    const explain = (sqlText: string): Effect.Effect<string, DriverError | SqlError> =>
      Effect.gen(function* () {
        const blocked = explainGuard(sqlText, "postgres");
        if (blocked !== undefined) return yield* Effect.fail(new SqlError({ message: blocked, code: "EXPLAIN_BLOCKED" }));
        const statement = splitStatements(sqlText, "postgres")[0]!;
        const rows = yield* withClient(async (client) => {
          try {
            await client.query("BEGIN");
            await client.query("SET TRANSACTION READ ONLY");
            await client.query(`SET LOCAL statement_timeout = ${DEFAULT_TIMEOUT_MS}`);
            const res = await client.query({
              text: `EXPLAIN (ANALYZE false, FORMAT TEXT) ${statement}`,
              values: [],
              queryMode: "extended",
            } as never);
            return (res as { rows: Array<Record<string, string>> }).rows;
          } finally {
            try {
              await client.query("ROLLBACK");
            } catch {
              /* connection may already be dead */
            }
          }
        }, toSqlError);
        return rows.map((r) => r["QUERY PLAN"] ?? Object.values(r)[0] ?? "").join("\n");
      });

    const driver: Driver = {
      dialect: "postgres",
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
