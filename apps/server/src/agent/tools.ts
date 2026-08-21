/** Guarded, provider-neutral tools for attached database and Git sources. */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type {
  ChatEvent,
  ColumnMeta,
  Connection,
  ConnectionId,
  GitRepository,
  MessageId,
} from "@dbchat/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { z } from "zod";

import type { Driver } from "../Services/DriverRegistry.ts";
import { inspectGitRepository, readGitFile, searchGitRepository } from "./git.ts";
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

export interface ToolDatabase {
  readonly connection: Connection;
  readonly driver: Effect.Effect<Driver, unknown>;
}

export const DBCHAT_TOOL_NAMES = [
  "list_sources",
  "list_schemas",
  "describe_table",
  "sample_rows",
  "run_sql",
  "explain",
  "propose_write",
  "list_models",
  "search_models",
  "read_model",
] as const;
export type DbchatToolName = (typeof DBCHAT_TOOL_NAMES)[number];

const sourceIdProperty = {
  sourceId: { type: "string", description: "Database source id; required when more than one database is attached" },
};
const repositoryIdProperty = {
  repositoryId: { type: "string", description: "Git repository id; required when more than one repository is attached" },
};

/** Provider-neutral metadata used by Codex dynamic tools and the OpenCode bridge. */
export const DBCHAT_TOOL_SPECS: ReadonlyArray<{
  readonly name: DbchatToolName;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}> = [
  {
    name: "list_sources",
    description: "List every database and Git repository attached to this conversation, including ids required by other tools.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_schemas",
    description: "List schemas and tables in one attached database.",
    inputSchema: { type: "object", properties: sourceIdProperty, additionalProperties: false },
  },
  {
    name: "describe_table",
    description: "Describe one table: columns, primary key, foreign keys, and indexes.",
    inputSchema: {
      type: "object",
      properties: { ...sourceIdProperty, schema: { type: "string" }, table: { type: "string" } },
      required: ["schema", "table"],
      additionalProperties: false,
    },
  },
  {
    name: "sample_rows",
    description: `Return up to ${MAX_SAMPLE_ROWS} rows from a table in one attached database.`,
    inputSchema: {
      type: "object",
      properties: { ...sourceIdProperty, schema: { type: "string" }, table: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: MAX_SAMPLE_ROWS } },
      required: ["schema", "table"],
      additionalProperties: false,
    },
  },
  {
    name: "run_sql",
    description: `Run a READ-ONLY SQL query against one attached database. Rows are capped at ${MAX_ROWS}.`,
    inputSchema: {
      type: "object",
      properties: { ...sourceIdProperty, sql: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: MAX_ROWS } },
      required: ["sql"],
      additionalProperties: false,
    },
  },
  {
    name: "explain",
    description: "Return the query plan for SQL against one attached database without executing it.",
    inputSchema: {
      type: "object",
      properties: { ...sourceIdProperty, sql: { type: "string" } },
      required: ["sql"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_write",
    description: "Submit one data-changing statement against an explicitly scoped database. It runs only when policy permits or the user approves.",
    inputSchema: {
      type: "object",
      properties: {
        ...sourceIdProperty,
        sql: { type: "string" },
        rationale: { type: "string" },
        estimatedRows: { type: "integer", minimum: 0 },
      },
      required: ["sql", "rationale"],
      additionalProperties: false,
    },
  },
  {
    name: "list_models",
    description: "List SQL/dbt models and documentation in an attached Git repository, pinned to its displayed commit.",
    inputSchema: { type: "object", properties: repositoryIdProperty, additionalProperties: false },
  },
  {
    name: "search_models",
    description: "Search filenames and contents in an attached Git repository.",
    inputSchema: {
      type: "object",
      properties: { ...repositoryIdProperty, query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_model",
    description: "Read one SQL, YAML, Markdown, manifest.json, or catalog.json file from an attached Git repository.",
    inputSchema: {
      type: "object",
      properties: { ...repositoryIdProperty, path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
];

export interface ToolContext {
  readonly databases: ReadonlyArray<ToolDatabase>;
  readonly repositories: ReadonlyArray<GitRepository>;
  readonly messageId: MessageId;
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  readonly emit: (event: ChatEvent) => Effect.Effect<void>;
  readonly proposeWrite: (args: {
    connectionId: ConnectionId;
    sql: string;
    rationale: string;
    estimatedRows?: number;
  }) => Effect.Effect<ProposeWriteOutcome>;
}

const ok = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
});
const err = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

const errorMessage = (error: unknown): string => {
  if (error && typeof error === "object") {
    const value = error as { _tag?: string; message?: string; reason?: string };
    if (value._tag === "WriteBlocked") return `WriteBlocked: ${value.reason ?? "statement is not allowed"}.`;
    if (typeof value.message === "string") return `${value._tag ? `${value._tag}: ` : ""}${value.message}`;
  }
  return String(error);
};

export const truncateCell = (value: unknown): unknown => {
  if (typeof value === "string" && value.length > MAX_CELL_CHARS) {
    return `${value.slice(0, MAX_CELL_CHARS)}… [truncated ${value.length - MAX_CELL_CHARS} chars]`;
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (value && typeof value === "object") {
    const serialized = JSON.stringify(value);
    return serialized.length > MAX_CELL_CHARS ? `${serialized.slice(0, MAX_CELL_CHARS)}…` : value;
  }
  return value;
};

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
    let affectedRows: number | undefined;
    yield* driver.query(sql, { readOnly: options.readOnly, limit, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) }).pipe(
      Stream.takeWhile(() => rows.length < limit),
      Stream.runForEach((batch) =>
        Effect.sync(() => {
          if (batch.columns.length > 0) columns = batch.columns;
          if (batch.affectedRows !== undefined) affectedRows = (affectedRows ?? 0) + batch.affectedRows;
          for (const row of batch.rows) {
            if (rows.length >= limit) {
              truncated = true;
              break;
            }
            rows.push(row.map(truncateCell));
          }
        }),
      ),
    );
    return { columns, rows: rows as ReadonlyArray<ReadonlyArray<unknown>>, truncated, affectedRows };
  });

const guarded =
  (ctx: ToolContext) =>
  <E>(effect: Effect.Effect<ToolResult, E>) =>
    ctx.run(effect.pipe(Effect.catch((error) => Effect.succeed(err(errorMessage(error)))))).catch((error: unknown) => err(errorMessage(error)));

const objectInput = (input: unknown): Record<string, unknown> =>
  input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};

const resolveDatabase = (ctx: ToolContext, sourceId: unknown): ToolDatabase => {
  if (typeof sourceId === "string" && sourceId) {
    const database = ctx.databases.find(({ connection }) => connection.id === sourceId);
    if (!database) throw new Error(`Database source is not attached: ${sourceId}`);
    return database;
  }
  if (ctx.databases.length === 1) return ctx.databases[0]!;
  if (ctx.databases.length === 0) throw new Error("No database source is attached to this conversation.");
  throw new Error("sourceId is required because multiple databases are attached.");
};

const resolveRepository = (ctx: ToolContext, repositoryId: unknown): GitRepository => {
  if (typeof repositoryId === "string" && repositoryId) {
    const repository = ctx.repositories.find((candidate) => candidate.id === repositoryId);
    if (!repository) throw new Error(`Git repository is not attached: ${repositoryId}`);
    return repository;
  }
  if (ctx.repositories.length === 1) return ctx.repositories[0]!;
  if (ctx.repositories.length === 0) throw new Error("No Git repository is attached to this conversation.");
  throw new Error("repositoryId is required because multiple Git repositories are attached.");
};

export const invokeDbchatTool = (ctx: ToolContext, name: string, input: unknown): Promise<ToolResult> => {
  const g = guarded(ctx);
  const value = objectInput(input);
  const string = (key: string) => {
    const candidate = value[key];
    if (typeof candidate !== "string" || candidate.length === 0) throw new Error(`${key} must be a non-empty string`);
    return candidate;
  };
  const optionalInt = (key: string, max?: number, min = 0) => {
    const candidate = value[key];
    if (candidate === undefined) return undefined;
    if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate < min || (max !== undefined && candidate > max)) {
      throw new Error(`${key} must be an integer${max === undefined ? ` at least ${min}` : ` between ${min} and ${max}`}`);
    }
    return candidate;
  };

  try {
    switch (name) {
      case "list_sources":
        return Promise.resolve(ok({
          databases: ctx.databases.map(({ connection }) => ({ id: connection.id, name: connection.name, dialect: connection.dialect, database: connection.database, environment: connection.env })),
          repositories: ctx.repositories.map((repository) => ({ id: repository.id, name: repository.name, branch: repository.branch, commit: repository.headCommit })),
        }));
      case "list_schemas": {
        const database = resolveDatabase(ctx, value.sourceId);
        return g(Effect.gen(function* () {
          const schemas = yield* (yield* database.driver).introspect;
          return ok({ source: { id: database.connection.id, name: database.connection.name }, schemas: schemas.map((schema) => ({
            schema: schema.name,
            tables: schema.tables.map((table) => ({ name: table.name, kind: table.kind, rowEstimate: table.rowEstimate })),
          })) });
        }));
      }
      case "describe_table": {
        const database = resolveDatabase(ctx, value.sourceId);
        const schema = string("schema");
        const table = string("table");
        return g(Effect.gen(function* () {
          const detail = yield* (yield* database.driver).describeTable(schema, table);
          return ok({
            source: { id: database.connection.id, name: database.connection.name },
            table: detail.table,
            columns: detail.columns,
            primaryKey: detail.columns.filter((column) => column.isPrimaryKey).map((column) => column.name),
            foreignKeys: detail.columns.filter((column) => column.foreignKey).map((column) => ({ column: column.name, references: column.foreignKey })),
            indexes: detail.indexes,
          });
        }));
      }
      case "sample_rows": {
        const database = resolveDatabase(ctx, value.sourceId);
        const schema = string("schema");
        const table = string("table");
        const limit = optionalInt("limit", MAX_SAMPLE_ROWS, 1);
        return g(Effect.gen(function* () {
          const page = yield* (yield* database.driver).rows({ connectionId: database.connection.id, schema, table, limit: Math.min(limit ?? 10, MAX_SAMPLE_ROWS), offset: 0 });
          return ok({ source: { id: database.connection.id, name: database.connection.name }, columns: page.columns.map((column) => column.name), rows: page.rows.map((row) => row.map(truncateCell)), total: page.total });
        }));
      }
      case "run_sql": {
        const database = resolveDatabase(ctx, value.sourceId);
        const sql = string("sql");
        const limit = optionalInt("limit", MAX_ROWS, 1);
        return g(Effect.gen(function* () {
          const started = Date.now();
          const result = yield* collectQuery(yield* database.driver, sql, { readOnly: true, limit: Math.max(1, limit ?? 100) });
          const durationMs = Date.now() - started;
          const source = { kind: "database" as const, id: database.connection.id };
          yield* ctx.emit({ _tag: "ResultTable", messageId: ctx.messageId, columns: result.columns, rows: result.rows, sql, source });
          return ok({ source: { id: database.connection.id, name: database.connection.name }, columns: result.columns.map((column) => `${column.name}:${column.type}`), rowCount: result.rows.length, truncated: result.truncated, durationMs, rows: result.rows });
        }));
      }
      case "explain": {
        const database = resolveDatabase(ctx, value.sourceId);
        const sql = string("sql");
        return g(Effect.gen(function* () {
          return ok({ source: { id: database.connection.id, name: database.connection.name }, plan: yield* (yield* database.driver).explain(sql) });
        }));
      }
      case "propose_write": {
        const database = resolveDatabase(ctx, value.sourceId);
        const sql = string("sql");
        const rationale = string("rationale");
        const estimatedRows = optionalInt("estimatedRows");
        return g(Effect.gen(function* () {
          const outcome = yield* ctx.proposeWrite({ connectionId: database.connection.id, sql, rationale, ...(estimatedRows !== undefined ? { estimatedRows } : {}) });
          if (outcome.status === "executed") return ok({ source: database.connection.name, status: "executed", rowCount: outcome.rowCount ?? null });
          if (outcome.status === "rejected") return ok({ source: database.connection.name, status: "rejected", note: "The user rejected this write." });
          return err(`Write failed on ${database.connection.name}: ${outcome.error ?? "unknown error"}`);
        }));
      }
      case "list_models": {
        const repository = resolveRepository(ctx, value.repositoryId);
        return Promise.resolve(ok({ repository: repository.name, branch: repository.branch, commit: repository.headCommit, models: inspectGitRepository(repository) }));
      }
      case "search_models": {
        const repository = resolveRepository(ctx, value.repositoryId);
        return Promise.resolve(ok({ repository: repository.name, commit: repository.headCommit, results: searchGitRepository(repository, string("query")) }));
      }
      case "read_model": {
        const repository = resolveRepository(ctx, value.repositoryId);
        const path = string("path");
        return Promise.resolve(ok({ repository: repository.name, path, branch: repository.branch, commit: repository.headCommit, content: readGitFile(repository, path) }));
      }
      default:
        return Promise.resolve(err(`Unknown tool: ${name}`));
    }
  } catch (error) {
    return Promise.resolve(err(errorMessage(error)));
  }
};

const sourceId = z.string().optional().describe("Database source id; required with multiple attached databases");
const repositoryId = z.string().optional().describe("Git repository id; required with multiple attached repositories");

export const makeDbchatMcpServer = (ctx: ToolContext) => createSdkMcpServer({
  name: MCP_SERVER_NAME,
  version: "0.1.0",
  alwaysLoad: true,
  tools: [
    tool("list_sources", "List attached database and Git sources with their ids.", {}, () => invokeDbchatTool(ctx, "list_sources", {})),
    tool("list_schemas", "List schemas and tables in one attached database.", { sourceId }, (input) => invokeDbchatTool(ctx, "list_schemas", input)),
    tool("describe_table", "Describe a table in one attached database.", { sourceId, schema: z.string(), table: z.string() }, (input) => invokeDbchatTool(ctx, "describe_table", input)),
    tool("sample_rows", `Return up to ${MAX_SAMPLE_ROWS} rows from a table.`, { sourceId, schema: z.string(), table: z.string(), limit: z.number().int().min(1).max(MAX_SAMPLE_ROWS).optional() }, (input) => invokeDbchatTool(ctx, "sample_rows", input)),
    tool("run_sql", "Run a read-only query against one attached database.", { sourceId, sql: z.string(), limit: z.number().int().min(1).max(MAX_ROWS).optional() }, (input) => invokeDbchatTool(ctx, "run_sql", input)),
    tool("explain", "Explain SQL against one attached database.", { sourceId, sql: z.string() }, (input) => invokeDbchatTool(ctx, "explain", input)),
    tool("propose_write", "Propose one database write, subject to the connection's approval policy.", { sourceId, sql: z.string(), rationale: z.string(), estimatedRows: z.number().int().nonnegative().optional() }, (input) => invokeDbchatTool(ctx, "propose_write", input)),
    tool("list_models", "List SQL/dbt models in an attached Git repository.", { repositoryId }, (input) => invokeDbchatTool(ctx, "list_models", input)),
    tool("search_models", "Search an attached Git repository for model context.", { repositoryId, query: z.string() }, (input) => invokeDbchatTool(ctx, "search_models", input)),
    tool("read_model", "Read one model or documentation file from an attached Git repository.", { repositoryId, path: z.string() }, (input) => invokeDbchatTool(ctx, "read_model", input)),
  ],
});
