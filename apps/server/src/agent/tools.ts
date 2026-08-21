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

export const DBCHAT_TOOL_NAMES = ["list_schemas", "describe_table", "sample_rows", "run_sql", "explain", "propose_write"] as const;
export type DbchatToolName = (typeof DBCHAT_TOOL_NAMES)[number];

/** Provider-neutral tool metadata used by Codex dynamic tools and the OpenCode MCP bridge. */
export const DBCHAT_TOOL_SPECS: ReadonlyArray<{
  readonly name: DbchatToolName;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}> = [
  {
    name: "list_schemas",
    description: "List schemas and their tables (with kind and approximate row counts).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "describe_table",
    description: "Describe one table: columns (type, nullable, default), primary key, foreign keys and indexes.",
    inputSchema: {
      type: "object",
      properties: {
        schema: { type: "string", description: "Schema name (e.g. public, main, a MySQL database, or a BigQuery dataset)" },
        table: { type: "string" },
      },
      required: ["schema", "table"],
      additionalProperties: false,
    },
  },
  {
    name: "sample_rows",
    description: `Return up to ${MAX_SAMPLE_ROWS} rows from a table to understand its data.`,
    inputSchema: {
      type: "object",
      properties: {
        schema: { type: "string" },
        table: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: MAX_SAMPLE_ROWS },
      },
      required: ["schema", "table"],
      additionalProperties: false,
    },
  },
  {
    name: "run_sql",
    description: `Run a READ-ONLY SQL query (SELECT/WITH/SHOW/EXPLAIN). Rows are capped at ${MAX_ROWS}; writes are rejected and must use propose_write.`,
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "The SQL to execute" },
        limit: { type: "integer", minimum: 1, maximum: MAX_ROWS },
      },
      required: ["sql"],
      additionalProperties: false,
    },
  },
  {
    name: "explain",
    description: "Return the query plan (EXPLAIN) for a SQL statement without executing it against data.",
    inputSchema: {
      type: "object",
      properties: { sql: { type: "string" } },
      required: ["sql"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_write",
    description: "Submit one data-changing statement. It runs only when policy permits AI writes or after the user approves it in dbchat.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "Exact statement to run; one statement, inside a transaction" },
        rationale: { type: "string", description: "What this changes and why" },
        estimatedRows: { type: "integer", minimum: 0 },
      },
      required: ["sql", "rationale"],
      additionalProperties: false,
    },
  },
];

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

const objectInput = (input: unknown): Record<string, unknown> =>
  input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};

/** Execute one dbchat tool independently of any agent SDK. */
export const invokeDbchatTool = (ctx: ToolContext, name: string, input: unknown): Promise<ToolResult> => {
  const g = guarded(ctx);
  const value = objectInput(input);
  const string = (key: string) => {
    const v = value[key];
    if (typeof v !== "string" || v.length === 0) throw new Error(`${key} must be a non-empty string`);
    return v;
  };
  const optionalInt = (key: string, max?: number, min = 0) => {
    const v = value[key];
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || (max !== undefined && v > max)) {
      throw new Error(`${key} must be an integer${max === undefined ? ` at least ${min}` : ` between ${min} and ${max}`}`);
    }
    return v;
  };

  try {
    switch (name) {
      case "list_schemas":
        return g(Effect.gen(function* () {
          const driver = yield* ctx.driver;
          const schemas = yield* driver.introspect;
          return ok(schemas.map((schema) => ({
            schema: schema.name,
            tables: schema.tables.map((table) => ({ name: table.name, kind: table.kind, rowEstimate: table.rowEstimate })),
          })));
        }));
      case "describe_table": {
        const schema = string("schema");
        const table = string("table");
        return g(Effect.gen(function* () {
          const driver = yield* ctx.driver;
          const detail = yield* driver.describeTable(schema, table);
          return ok({
            table: detail.table,
            columns: detail.columns,
            primaryKey: detail.columns.filter((column) => column.isPrimaryKey).map((column) => column.name),
            foreignKeys: detail.columns.filter((column) => column.foreignKey).map((column) => ({ column: column.name, references: column.foreignKey })),
            indexes: detail.indexes,
          });
        }));
      }
      case "sample_rows": {
        const schema = string("schema");
        const table = string("table");
        const limit = optionalInt("limit", MAX_SAMPLE_ROWS, 1);
        return g(Effect.gen(function* () {
          const driver = yield* ctx.driver;
          const page = yield* driver.rows({ connectionId: ctx.connectionId, schema, table, limit: Math.min(limit ?? 10, MAX_SAMPLE_ROWS), offset: 0 });
          return ok({ columns: page.columns.map((column) => column.name), rows: page.rows.map((row) => row.map(truncateCell)), total: page.total });
        }));
      }
      case "run_sql": {
        const sql = string("sql");
        const limit = optionalInt("limit", MAX_ROWS, 1);
        return g(Effect.gen(function* () {
          const driver = yield* ctx.driver;
          const started = Date.now();
          const result = yield* collectQuery(driver, sql, { readOnly: true, limit: Math.max(1, limit ?? 100) });
          const durationMs = Date.now() - started;
          yield* ctx.emit({ _tag: "ResultTable", messageId: ctx.messageId, columns: result.columns, rows: result.rows, sql });
          return ok({
            columns: result.columns.map((column) => `${column.name}:${column.type}`),
            rowCount: result.rows.length,
            truncated: result.truncated,
            durationMs,
            rows: result.rows,
          });
        }));
      }
      case "explain": {
        const sql = string("sql");
        return g(Effect.gen(function* () {
          const driver = yield* ctx.driver;
          return ok(yield* driver.explain(sql));
        }));
      }
      case "propose_write": {
        const sql = string("sql");
        const rationale = string("rationale");
        const estimatedRows = optionalInt("estimatedRows");
        return g(Effect.gen(function* () {
          const outcome = yield* ctx.proposeWrite({ sql, rationale, ...(estimatedRows !== undefined ? { estimatedRows } : {}) });
          switch (outcome.status) {
            case "executed": return ok({ status: "executed", rowCount: outcome.rowCount ?? null });
            case "rejected": return ok({ status: "rejected", note: "The user rejected this write. Do not retry it unless they ask." });
            case "failed": return err(`Write failed: ${outcome.error ?? "unknown error"}`);
          }
        }));
      }
      default:
        return Promise.resolve(err(`Unknown tool: ${name}`));
    }
  } catch (error) {
    return Promise.resolve(err(errorMessage(error)));
  }
};

export const makeDbchatMcpServer = (ctx: ToolContext) => {
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "0.1.0",
    alwaysLoad: true,
    tools: [
      tool(
        "list_schemas",
        "List schemas and their tables (with kind and approximate row counts).",
        {},
        () => invokeDbchatTool(ctx, "list_schemas", {}),
      ),
      tool(
        "describe_table",
        "Describe one table: columns (type, nullable, default), primary key, foreign keys and indexes.",
        { schema: z.string().describe("Schema name (e.g. public, main, a MySQL database, or a BigQuery dataset)"), table: z.string() },
        (input) => invokeDbchatTool(ctx, "describe_table", input),
      ),
      tool(
        "sample_rows",
        `Return up to ${MAX_SAMPLE_ROWS} rows from a table to understand its data.`,
        { schema: z.string(), table: z.string(), limit: z.number().int().min(1).max(MAX_SAMPLE_ROWS).optional() },
        (input) => invokeDbchatTool(ctx, "sample_rows", input),
      ),
      tool(
        "run_sql",
        `Run a READ-ONLY SQL query (SELECT/WITH/SHOW/EXPLAIN). Rows are capped at ${MAX_ROWS}; the user sees the results as a grid automatically, so do not repeat them verbatim. Writes are rejected: use propose_write.`,
        { sql: z.string().describe("The SQL to execute"), limit: z.number().int().min(1).max(MAX_ROWS).optional().describe(`Row cap (default 100, max ${MAX_ROWS})`) },
        (input) => invokeDbchatTool(ctx, "run_sql", input),
      ),
      tool(
        "explain",
        "Return the query plan (EXPLAIN) for a SQL statement without executing it against data.",
        { sql: z.string() },
        (input) => invokeDbchatTool(ctx, "explain", input),
      ),
      tool(
        "propose_write",
        "Submit one data-changing statement (INSERT/UPDATE/DELETE/DDL). It runs only when the connection policy permits AI writes or after the user approves it in the UI; approval waits up to 10 minutes. Returns the row count on success or a rejection notice.",
        {
          sql: z.string().describe("Exact statement to run. One statement; it runs inside a transaction."),
          rationale: z.string().describe("One or two sentences: what this changes and why."),
          estimatedRows: z.number().int().nonnegative().optional().describe("Estimated affected rows, if known"),
        },
        (input) => invokeDbchatTool(ctx, "propose_write", input),
      ),
    ],
  });
};
