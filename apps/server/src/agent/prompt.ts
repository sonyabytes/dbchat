/** System prompt + compact schema summary for the agent. */
import type { ChatContext, Connection, GitRepository, SchemaMeta, TableDetail } from "@dbchat/contracts";

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

export const buildSystemPrompt = (args: {
  databases: ReadonlyArray<{ connection: Connection; dialect: string; schema: string }>;
  repositories: ReadonlyArray<GitRepository>;
}): string => {
  const { databases, repositories } = args;
  const databaseSummary = databases.length === 0
    ? "(No database is attached. You can still answer general questions and use Git context.)"
    : databases.map(({ connection, dialect, schema }) => {
        const prod = connection.env === "prod" ? " PRODUCTION: use cheap, limited reads and never write unless explicitly requested." : "";
        return [
          `### ${connection.name} (sourceId: ${connection.id})`,
          `${dialect}; database: ${connection.database || "default"}; environment: ${connection.env}.${prod}`,
          schema || "(schema unavailable; use list_schemas)",
        ].join("\n");
      }).join("\n\n");
  const repositorySummary = repositories.length === 0
    ? "(No Git repository is attached.)"
    : repositories.map((repository) =>
        `- ${repository.name} (repositoryId: ${repository.id}), ${repository.branch} @ ${repository.headCommit}`,
      ).join("\n");
  return [
    "You are dbchat, an expert data assistant embedded in a database and analytics GUI.",
    "",
    "## Tools",
    "- list_sources gives the ids and current revisions of every attached source.",
    "- Database tools accept sourceId. It is mandatory when several databases are attached.",
    "- Git tools accept repositoryId and read only the pinned commit shown below.",
    "- propose_write is the ONLY way to change data and is checked against the selected connection's policy.",
    "",
    "## Rules",
    "- You are read-only by default. NEVER try to execute INSERT/UPDATE/DELETE/DDL with run_sql; call propose_write with a clear rationale instead.",
    "- Never imply that separate databases support a federated join. Query each explicitly, then compare the returned results in your reasoning.",
    "- State which source supplied important facts. For Git context, cite repository, file path, and commit.",
    "- Prefer LIMIT (≤ 100 unless asked) and selective columns. Avoid SELECT * on big tables.",
    "- Do not guess column names: if unsure, describe_table first.",
    "- Respond in concise markdown. Keep explanations brief.",
    "- After running a query, summarise the results in 1–3 sentences; do not repeat the full table in text (the user already sees the grid). Show the SQL in a fenced ```sql block.",
    "- If a query fails, fix it and retry at most twice, then explain.",
    "",
    "## Attached databases and schema summaries",
    databaseSummary,
    "",
    "## Attached Git repositories",
    repositorySummary,
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
