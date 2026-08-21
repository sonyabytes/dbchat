/**
 * Google BigQuery driver (`@google-cloud/bigquery`).
 *
 * `database` in the connection model is the Google Cloud project ID, `host`
 * is the optional job location, and the encrypted password slot stores an
 * optional service-account JSON document. When it is omitted, the Google
 * client uses Application Default Credentials.
 *
 * BigQuery jobs are finite rather than cursor-backed. Queries are collected
 * and emitted in 500-row batches; interrupting the stream cancels the active
 * job on a best-effort basis. Read-only runs are protected by the shared SQL
 * classifier before a job is submitted.
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
import { BigQuery, type Query } from "@google-cloud/bigquery";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { Driver, QueryOptions, RowBatch } from "../Services/DriverRegistry.ts";
import { explainGuard, isReadOnlySql, splitStatements } from "./classify.ts";
import { toJsonSafeRows } from "./jsonSafe.ts";
import { buildCountQuery, buildRowsQuery, hasFilters } from "./queryBuilder.ts";

export interface BigQueryConfig {
  readonly projectId?: string | undefined;
  readonly location?: string | undefined;
  readonly credentialsJson?: string | undefined;
}

interface BigQueryField {
  readonly name?: string | null;
  readonly type?: string | null;
  readonly mode?: string | null;
  readonly fields?: ReadonlyArray<BigQueryField> | null;
  readonly defaultValueExpression?: string | null;
}

interface QueryResponse {
  readonly schema?: { readonly fields?: ReadonlyArray<BigQueryField> | null } | null;
  readonly totalRows?: string | null;
  readonly numDmlAffectedRows?: string | null;
}

const BATCH_SIZE = 500;
const DEFAULT_TIMEOUT_MS = 30_000;

const errMessage = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);

const errorCode = (e: unknown): string | undefined => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" || typeof code === "number" ? String(code) : undefined;
};

const toSqlError = (e: unknown): SqlError => {
  const code = errorCode(e);
  return new SqlError({ message: errMessage(e), ...(code !== undefined ? { code } : {}) });
};

const toDriverError = (e: unknown): DriverError =>
  new DriverError({ dialect: "bigquery", message: errMessage(e) });

/** BigQuery schema field → the compact type displayed by the client. */
export const bigQueryFieldType = (field: BigQueryField): string => {
  const base = field.type?.toUpperCase() || "UNKNOWN";
  const nested = base === "RECORD" || base === "STRUCT"
    ? `STRUCT<${(field.fields ?? []).map((f) => `${f.name ?? "field"} ${bigQueryFieldType(f)}`).join(", ")}>`
    : base;
  return field.mode === "REPEATED" ? `ARRAY<${nested}>` : nested;
};

export const bigQueryColumnMeta = (field: BigQueryField): ColumnMeta => ({
  name: field.name ?? "column",
  type: bigQueryFieldType(field),
  nullable: field.mode !== "REQUIRED",
  isPrimaryKey: false,
  ...(field.defaultValueExpression ? { default: field.defaultValueExpression } : {}),
});

const responseFields = (response: unknown): ReadonlyArray<BigQueryField> =>
  ((response as QueryResponse | undefined)?.schema?.fields ?? []) as ReadonlyArray<BigQueryField>;

const objectRowsToArrays = (
  rows: ReadonlyArray<Record<string, unknown>>,
  fields: ReadonlyArray<BigQueryField>,
): Array<Array<unknown>> => rows.map((row) => fields.map((field) => row[field.name ?? ""]));

export const makeBigQueryDriver = (cfg: BigQueryConfig): Effect.Effect<Driver, ConnectionError> =>
  Effect.gen(function* () {
    const credentials = yield* Effect.try({
      try: () => cfg.credentialsJson?.trim() ? JSON.parse(cfg.credentialsJson) as Record<string, unknown> : undefined,
      catch: (e) => new ConnectionError({ message: `invalid BigQuery service account JSON: ${errMessage(e)}` }),
    });
    const client = yield* Effect.try({
      try: () => new BigQuery({
        ...(cfg.projectId ? { projectId: cfg.projectId } : {}),
        ...(cfg.location ? { location: cfg.location } : {}),
        ...(credentials ? { credentials } : {}),
      }),
      catch: (e) => new ConnectionError({ message: `could not create a BigQuery client: ${errMessage(e)}` }),
    });

    const execute = (
      sqlText: string,
      params: ReadonlyArray<unknown> = [],
      options: { readonly limit?: number | undefined; readonly timeoutMs?: number | undefined } = {},
    ): Effect.Effect<{
      readonly columns: Array<ColumnMeta>;
      readonly rows: Array<Array<unknown>>;
      readonly affectedRows?: number | undefined;
      readonly totalRows?: number | undefined;
    }, SqlError> => {
      const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
      const query: Query = {
        query: sqlText,
        useLegacySql: false,
        jobTimeoutMs: timeoutMs,
        ...(params.length > 0 ? { params: [...params] } : {}),
        ...(cfg.location ? { location: cfg.location } : {}),
      };
      return Effect.acquireUseRelease(
        Effect.tryPromise({
          try: async () => {
            const [job] = await client.createQueryJob(query);
            return { job, finished: false };
          },
          catch: toSqlError,
        }),
        (active) =>
          Effect.tryPromise({
            try: async () => {
              const [rows, , apiResponse] = await active.job.getQueryResults({
                ...(options.limit !== undefined ? { maxResults: Math.max(0, Math.trunc(options.limit)) } : {}),
                timeoutMs,
              });
              active.finished = true;
              const response = apiResponse as QueryResponse;
              const fields = responseFields(response);
              const affectedRows = Number(response.numDmlAffectedRows);
              const totalRows = Number(response.totalRows);
              return {
                columns: fields.map(bigQueryColumnMeta),
                rows: objectRowsToArrays(rows as Array<Record<string, unknown>>, fields),
                ...(Number.isFinite(affectedRows) ? { affectedRows } : {}),
                ...(Number.isFinite(totalRows) ? { totalRows } : {}),
              };
            },
            catch: toSqlError,
          }),
        (active) => active.finished
          ? Effect.void
          : Effect.promise(() => active.job.cancel().then(() => undefined).catch(() => undefined)),
      );
    };

    /* ---- ping ---- */
    const ping = Effect.gen(function* () {
      const started = Date.now();
      yield* execute("SELECT 1 AS ok", [], { limit: 1 });
      return { latencyMs: Date.now() - started, serverVersion: "Google BigQuery" };
    }).pipe(Effect.mapError(toDriverError));

    /* ---- introspect ---- */
    const introspect = Effect.tryPromise({
      try: async () => {
        const [datasets] = await client.getDatasets();
        return await Promise.all(datasets.map(async (dataset): Promise<SchemaMeta> => {
          const [tables] = await dataset.getTables();
          const tableMeta = await Promise.all(tables.map(async (table): Promise<TableMeta> => {
            const [metadata] = await table.getMetadata();
            return {
              schema: dataset.id!,
              name: table.id!,
              kind: metadata.type === "VIEW" || metadata.type === "MATERIALIZED_VIEW" ? "view" : "table",
              rowEstimate: Number(metadata.numRows ?? 0) || 0,
            };
          }));
          return { name: dataset.id!, tables: tableMeta };
        }));
      },
      catch: toDriverError,
    });

    /* ---- describeTable ---- */
    const describeTable = (
      schema: string,
      table: string,
    ): Effect.Effect<TableDetail, DriverError | NotFound> =>
      Effect.tryPromise({
        try: async () => {
          const [metadata] = await client.dataset(schema).table(table).getMetadata();
          const fields = (metadata.schema?.fields ?? []) as ReadonlyArray<BigQueryField>;
          const indexes: Array<IndexMeta> = [];
          return {
            table: {
              schema,
              name: table,
              kind: metadata.type === "VIEW" || metadata.type === "MATERIALIZED_VIEW" ? "view" : "table",
              rowEstimate: Number(metadata.numRows ?? 0) || 0,
            },
            columns: fields.map(bigQueryColumnMeta),
            indexes,
          } satisfies TableDetail;
        },
        catch: (e) => errorCode(e) === "404"
          ? new NotFound({ entity: "table", id: `${schema}.${table}` })
          : toDriverError(e),
      });

    /* ---- rows ---- */
    const rows = (req: RowsRequest): Effect.Effect<RowsPage, DriverError | SqlError> =>
      Effect.gen(function* () {
        const built = buildRowsQuery("bigquery", req);
        const page = yield* execute(built.text, built.params, { limit: req.limit });
        const detail = yield* describeTable(req.schema, req.table).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        );
        const metaByName = new Map((detail?.columns ?? []).map((column) => [column.name, column]));
        const columns = page.columns.map((column) => metaByName.get(column.name) ?? column);
        let total: number | undefined = detail?.table.rowEstimate;
        if (hasFilters(req)) {
          const count = buildCountQuery("bigquery", req);
          const counted = yield* execute(count.text, count.params, { limit: 1 }).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          );
          total = Number(counted?.rows[0]?.[0]);
          if (!Number.isFinite(total)) total = undefined;
        }
        return {
          columns,
          rows: toJsonSafeRows(page.rows),
          ...(total !== undefined ? { total } : {}),
          truncated: page.rows.length >= req.limit,
        } satisfies RowsPage;
      });

    /* ---- query ---- */
    const query = (
      sqlText: string,
      options?: QueryOptions,
    ): Stream.Stream<RowBatch, DriverError | SqlError | WriteBlocked> => {
      if (options?.readOnly === true) {
        const verdict = isReadOnlySql(sqlText, "bigquery");
        if (!verdict.readOnly) {
          return Stream.fail(new WriteBlocked({
            sql: sqlText,
            reason: verdict.reason ?? "statement is not a read",
          }));
        }
      }
      const result = execute(sqlText, [], {
        ...(options?.limit !== undefined ? { limit: options.limit } : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      }).pipe(
        Effect.map((result) => {
          const batches: Array<RowBatch> = [];
          for (let i = 0; i < result.rows.length; i += BATCH_SIZE) {
            batches.push({
              columns: result.columns,
              rows: toJsonSafeRows(result.rows.slice(i, i + BATCH_SIZE)),
              ...(i === 0 && result.affectedRows !== undefined ? { affectedRows: result.affectedRows } : {}),
            });
          }
          return batches.length > 0
            ? batches
            : [{
                columns: result.columns,
                rows: [],
                ...(result.affectedRows !== undefined ? { affectedRows: result.affectedRows } : {}),
              }];
        }),
      );
      return Stream.unwrap(result.pipe(Effect.map(Stream.fromArray)));
    };

    /* ---- explain ---- */
    const explain = (sqlText: string): Effect.Effect<string, DriverError | SqlError> =>
      Effect.suspend(() => {
        const blocked = explainGuard(sqlText, "bigquery");
        if (blocked !== undefined) {
          return Effect.fail(new SqlError({ message: blocked, code: "EXPLAIN_BLOCKED" }));
        }
        const statement = splitStatements(sqlText, "bigquery")[0]!;
        return Effect.tryPromise({
          try: async () => {
            const [, metadata] = await client.createQueryJob({
              query: statement,
              useLegacySql: false,
              dryRun: true,
              ...(cfg.location ? { location: cfg.location } : {}),
            });
            const stats = metadata.statistics?.query;
            const bytes = Number(stats?.totalBytesProcessed ?? 0);
            const billed = Number(stats?.totalBytesBilled ?? 0);
            const statementType = stats?.statementType ?? "QUERY";
            return [
              `BigQuery dry run: ${statementType}`,
              `Bytes processed: ${Number.isFinite(bytes) ? bytes.toLocaleString("en-US") : "unknown"}`,
              `Bytes billed: ${Number.isFinite(billed) ? billed.toLocaleString("en-US") : "unknown"}`,
            ].join("\n");
          },
          catch: toSqlError,
        });
      });

    return {
      dialect: "bigquery",
      ping,
      introspect,
      describeTable,
      rows,
      query,
      explain,
      close: Effect.void,
    } satisfies Driver;
  }).pipe(Effect.tapError((e) => Effect.logDebug("bigquery driver open failed", { message: e.message })));
