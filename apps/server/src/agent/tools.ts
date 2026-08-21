/**
 * In-process MCP server exposing the database to the model. Every tool runs an
 * Effect through `ctx.run` (the session's runtime) because SDK handlers are plain
 * async functions.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { ChatEvent, ColumnMeta, ConnectionId, MessageId } from "@dbchat/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { z } from "zod";

import type { Driver } from "../Services/DriverRegistry.ts";
import { MCP_SERVER_NAME } from "./events.ts";

export const MAX_ROWS = 500;
export const MAX_SAMPLE_ROWS = 20;
export const MAX_CELL_CHARS = 2_000;

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ProposeWriteOutcome {
  readonly status: "executed" | "rejected" | "failed";
  readonly rowCount?: number;
  readonly error?: string;
}

export interface ToolContext {
  readonly connectionId: ConnectionId;
  readonly messageId: MessageId;
  /** Run an Effect in the session runtime (errors are surfaced as tool errors). */
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  /** Lazily acquire the thread's driver. */
  readonly driver: Effect.Effect<Driver, unknown>;
  /** Publish a ChatEvent on the thread (ResultTable, approvals). */
  readonly emit: (event: ChatEvent) => Effect.Effect<void>;
  /** Approval flow: persist, emit ApprovalRequested, wait for resolution, execute. */
  readonly proposeWrite: (args: {
    sql: string;
    rationale: string;
    estimatedRows?: number;
  }) => Effect.Effect<ProposeWriteOutcome>;
}

const ok = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
});
const err = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

const errorMessage = (e: unknown): string => {
  if (e && typeof e === "object") {
    const o = e as { _tag?: string; message?: string; reason?: string; sql?: string };
    if (o._tag === "WriteBlocked") {
      return `WriteBlocked: ${o.reason ?? "statement is not read-only"}. Data-changing statements must go through propose_write.`;
    }
    if (typeof o.message === "string") return `${o._tag ? `${o._tag}: ` : ""}${o.message}`;
  }
  return String(e);
};

export const truncateCell = (v: unknown): unknown => {
  if (typeof v === "string" && v.length > MAX_CELL_CHARS) return `${v.slice(0, MAX_CELL_CHARS)}… [truncated ${v.length - MAX_CELL_CHARS} chars]`;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return v.toString();
  if (v && typeof v === "object") {
    const s = JSON.stringify(v);
    return s.length > MAX_CELL_CHARS ? `${s.slice(0, MAX_CELL_CHARS)}…` : v;
  }
  return v;
};

/** Collect a driver query stream into columns + rows (capped). */
export const collectQuery = (
  driver: Driver,
  sql: string,
  options: { readOnly: boolean; limit: number; timeoutMs?: number },
) =>
  Effect.gen(function* () {
    const limit = Math.min(options.limit, MAX_ROWS);
    let columns: ReadonlyArray<ColumnMeta> = [];
    const rows: unknown[][] = [];
    let truncated = false;
    /** Set only on the write path; `undefined` means "count the rows instead". */
    let affectedRows: number | undefined;
    yield* driver.query(sql, { readOnly: options.readOnly, limit, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) }).pipe(
      Stream.takeWhile(() => rows.length < limit),
      Stream.runForEach((batch) =>
        Effect.sync(() => {
          if (batch.columns.length > 0) columns = batch.columns;
          if (batch.affectedRows !== undefined) affectedRows = (affectedRows ?? 0) + batch.affectedRows;
          for (const r of batch.rows) {
            if (rows.length >= limit) {
              truncated = true;
              break;
            }
            rows.push(r.map(truncateCell));
          }
        }),
      ),
    );
    return { columns, rows: rows as ReadonlyArray<ReadonlyArray<unknown>>, truncated, affectedRows };
  });

/** Wraps a tool body so any failure becomes an MCP tool error instead of crashing the turn. */
const guarded =
  (ctx: ToolContext) =>
  <A>(effect: Effect.Effect<ToolResult, A>) =>
    ctx.run(effect.pipe(Effect.catch((e) => Effect.succeed(err(errorMessage(e)))))).catch((e: unknown) => err(errorMessage(e)));

export const makeDbchatMcpServer = (ctx: ToolContext) => {
  const g = guarded(ctx);
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "0.1.0",
    alwaysLoad: true,
    tools: [
      tool(
        "list_schemas",
        "List schemas and their tables (with kind and approximate row counts).",
        {},
        () =>
          g(
            Effect.gen(function* () {
              const driver = yield* ctx.driver;
              const schemas = yield* driver.introspect;
              return ok(
                schemas.map((s) => ({
                  schema: s.name,
                  tables: s.tables.map((t) => ({ name: t.name, kind: t.kind, rowEstimate: t.rowEstimate })),
                })),
              );
            }),
          ),
      ),
      tool(
        "describe_table",
        "Describe one table: columns (type, nullable, default), primary key, foreign keys and indexes.",
        { schema: z.string().describe("Schema name (e.g. public, main, a MySQL database, or a BigQuery dataset)"), table: z.string() },
        ({ schema, table }) =>
          g(
            Effect.gen(function* () {
              const driver = yield* ctx.driver;
              const d = yield* driver.describeTable(schema, table);
              return ok({
                table: d.table,
                columns: d.columns,
                primaryKey: d.columns.filter((c) => c.isPrimaryKey).map((c) => c.name),
                foreignKeys: d.columns.filter((c) => c.foreignKey).map((c) => ({ column: c.name, references: c.foreignKey })),
                indexes: d.indexes,
              });
            }),
          ),
      ),
      tool(
        "sample_rows",
        `Return up to ${MAX_SAMPLE_ROWS} rows from a table to understand its data.`,
        { schema: z.string(), table: z.string(), limit: z.number().int().min(1).max(MAX_SAMPLE_ROWS).optional() },
        ({ schema, table, limit }) =>
          g(
            Effect.gen(function* () {
              const driver = yield* ctx.driver;
              const page = yield* driver.rows({ connectionId: ctx.connectionId, schema, table, limit: Math.min(limit ?? 10, MAX_SAMPLE_ROWS), offset: 0 });
              return ok({
                columns: page.columns.map((c) => c.name),
                rows: page.rows.map((r) => r.map(truncateCell)),
                total: page.total,
              });
            }),
          ),
      ),
      tool(
        "run_sql",
        `Run a READ-ONLY SQL query (SELECT/WITH/SHOW/EXPLAIN). Rows are capped at ${MAX_ROWS}; the user sees the results as a grid automatically, so do not repeat them verbatim. Writes are rejected: use propose_write.`,
        { sql: z.string().describe("The SQL to execute"), limit: z.number().int().min(1).max(MAX_ROWS).optional().describe(`Row cap (default 100, max ${MAX_ROWS})`) },
        ({ sql, limit }) =>
          g(
            Effect.gen(function* () {
              const driver = yield* ctx.driver;
              const started = Date.now();
              const res = yield* collectQuery(driver, sql, { readOnly: true, limit: limit ?? 100 });
              const durationMs = Date.now() - started;
              yield* ctx.emit({ _tag: "ResultTable", messageId: ctx.messageId, columns: res.columns, rows: res.rows, sql });
              return ok({
                columns: res.columns.map((c) => `${c.name}:${c.type}`),
                rowCount: res.rows.length,
                truncated: res.truncated,
                durationMs,
                rows: res.rows,
              });
            }),
          ),
      ),
      tool(
        "explain",
        "Return the query plan (EXPLAIN) for a SQL statement without executing it against data.",
        { sql: z.string() },
        ({ sql }) =>
          g(
            Effect.gen(function* () {
              const driver = yield* ctx.driver;
              const plan = yield* driver.explain(sql);
              return ok(plan);
            }),
          ),
      ),
      tool(
        "propose_write",
        "Submit one data-changing statement (INSERT/UPDATE/DELETE/DDL). It runs only when the connection policy permits AI writes or after the user approves it in the UI; approval waits up to 10 minutes. Returns the row count on success or a rejection notice.",
        {
          sql: z.string().describe("Exact statement to run. One statement; it runs inside a transaction."),
          rationale: z.string().describe("One or two sentences: what this changes and why."),
          estimatedRows: z.number().int().nonnegative().optional().describe("Estimated affected rows, if known"),
        },
        ({ sql, rationale, estimatedRows }) =>
          g(
            Effect.gen(function* () {
              const outcome = yield* ctx.proposeWrite({ sql, rationale, ...(estimatedRows !== undefined ? { estimatedRows } : {}) });
              switch (outcome.status) {
                case "executed":
                  return ok({ status: "executed", rowCount: outcome.rowCount ?? null });
                case "rejected":
                  return ok({ status: "rejected", note: "The user rejected this write. Do not retry it unless they ask." });
                case "failed":
                  return err(`Write failed: ${outcome.error ?? "unknown error"}`);
              }
            }),
          ),
      ),
    ],
  });
};
