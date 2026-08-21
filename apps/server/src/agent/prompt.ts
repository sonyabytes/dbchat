/** System prompt + compact schema summary for the agent. */
import type { ChatContext, Connection, SchemaMeta, TableDetail } from "@dbchat/contracts";

export const SCHEMA_SUMMARY_MAX_CHARS = 6_000;

/**
 * Compact schema summary: `schema.table(col type, ...)` one table per line.
 * `details` is optional (column info may not be available cheaply); falls back
 * to table names + row estimates. Truncated to `maxChars`.
 */
export const schemaSummary = (
  schemas: ReadonlyArray<SchemaMeta>,
  details: ReadonlyMap<string, TableDetail> = new Map(),
  maxChars = SCHEMA_SUMMARY_MAX_CHARS,
): string => {
  const lines: string[] = [];
  for (const s of schemas) {
    for (const t of s.tables) {
      const key = `${t.schema}.${t.name}`;
      const d = details.get(key);
      const cols = d ? d.columns.map((c) => `${c.name} ${c.type}${c.isPrimaryKey ? " pk" : ""}`).join(", ") : "";
      lines.push(`${key}${t.kind === "view" ? " [view]" : ""} ~${t.rowEstimate} rows${cols ? ` (${cols})` : ""}`);
    }
  }
  let out = "";
  let truncated = 0;
  for (const line of lines) {
    if (out.length + line.length + 1 > maxChars) {
      truncated++;
      continue;
    }
    out += `${line}\n`;
  }
  if (truncated > 0) out += `… ${truncated} more tables omitted (use list_schemas / describe_table).\n`;
  return out.trimEnd();
};

export const buildSystemPrompt = (args: { connection: Connection; dialect: string; schema: string }): string => {
  const { connection, dialect, schema } = args;
  const prodNote =
    connection.env === "prod"
      ? "This is a PRODUCTION database. Be extra careful: keep queries cheap, always LIMIT, never propose a write unless the user asked for it explicitly and you have shown them the exact statement."
      : `Environment: ${connection.env}.`;
  return [
    `You are dbchat, an expert ${dialect} assistant embedded in a database GUI.`,
    `Connection: "${connection.name}" (${dialect}, database "${connection.database || "default"}"). ${prodNote}`,
    "",
    "## Tools",
    "- list_schemas: schemas and tables with row estimates.",
    "- describe_table: columns, keys, indexes for one table. Use it before writing non-trivial queries.",
    "- sample_rows: a few rows to understand data shapes.",
    "- run_sql: run a READ-ONLY query. Results are shown to the user as a grid automatically.",
    "- explain: query plan.",
    "- propose_write: the ONLY way to change data. It asks the user to approve; it may be rejected.",
    "",
    "## Rules",
    "- You are read-only by default. NEVER try to execute INSERT/UPDATE/DELETE/DDL with run_sql; call propose_write with a clear rationale instead.",
    "- Prefer LIMIT (≤ 100 unless asked) and selective columns. Avoid SELECT * on big tables.",
    "- Use the exact identifier quoting for " + dialect + ".",
    "- Do not guess column names: if unsure, describe_table first.",
    "- Respond in concise markdown. Keep explanations brief.",
    "- After running a query, summarise the results in 1–3 sentences; do not repeat the full table in text (the user already sees the grid). Show the SQL in a fenced ```sql block.",
    "- If a query fails, fix it and retry at most twice, then explain.",
    "",
    "## Schema summary (use describe_table for details)",
    schema || "(no tables found)",
  ].join("\n");
};

export const buildUserPrompt = (text: string, context: ChatContext | undefined): string => {
  if (!context || (!context.table && !context.sql)) return text;
  const blocks: string[] = [text, "", "<user_context>"];
  if (context.table) blocks.push(`The user is currently viewing table: ${context.table}`);
  if (context.sql) blocks.push(`Current SQL in the editor:\n\`\`\`sql\n${context.sql}\n\`\`\``);
  blocks.push("</user_context>");
  return blocks.join("\n");
};
