/** Inline SQL suggestion: one fast, tool-less Haiku call. Never throws to the UI. */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { claudeCliOption } from "./session.ts";
import type { SqlSuggestResult } from "@dbchat/contracts";
import * as Effect from "effect/Effect";

export const SUGGEST_MODEL = "claude-haiku-4-5-20251001";
export const SUGGEST_TIMEOUT_MS = 8_000;

export const buildSuggestPrompt = (args: { dialect: string; schema: string; sql: string; cursor: number }) => {
  const before = args.sql.slice(0, args.cursor);
  const after = args.sql.slice(args.cursor);
  return [
    `You autocomplete ${args.dialect} SQL in an editor. Propose the next short fragment (one clause or a few tokens, ≤ 120 chars) to insert at the cursor, using only tables/columns from the schema.`,
    'Reply with ONLY compact JSON: {"text": "<fragment to insert at cursor>", "reason": "<≤ 12 words>"} or the literal null if nothing useful.',
    "",
    "Schema:",
    args.schema || "(unknown)",
    "",
    "SQL before cursor:",
    before,
    "<CURSOR>",
    after ? `SQL after cursor:\n${after}` : "",
  ].join("\n");
};

export const parseSuggestion = (raw: string): SqlSuggestResult => {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  if (!trimmed || trimmed === "null") return {};
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  try {
    const v = JSON.parse(trimmed.slice(start, end + 1)) as { text?: unknown; reason?: unknown };
    if (typeof v.text !== "string" || v.text.length === 0) return {};
    return { suggestion: { text: v.text, reason: typeof v.reason === "string" ? v.reason : "" } };
  } catch {
    return {};
  }
};

export const runSuggest = (prompt: string, cwd: string): Effect.Effect<SqlSuggestResult> =>
  Effect.promise(async (signal) => {
    const q = query({
      prompt,
      options: {
        model: SUGGEST_MODEL,
        cwd,
        systemPrompt: "You are a terse SQL autocomplete engine. Output JSON only.",
        tools: [],
        maxTurns: 1,
        thinking: { type: "disabled" },
        persistSession: false,
        strictMcpConfig: true,
        settingSources: [],
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "dbchat-suggest/0.1.0" },
        ...claudeCliOption(),
      },
    });
    const onAbort = () => q.interrupt().catch(() => undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      for await (const m of q) {
        if (m.type === "result") return m.subtype === "success" && !m.is_error ? parseSuggestion(m.result) : {};
      }
      return {};
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }).pipe(
    Effect.timeoutOption(SUGGEST_TIMEOUT_MS),
    Effect.map((o) => (o._tag === "Some" ? o.value : {})),
    Effect.catchCause(() => Effect.succeed({} as SqlSuggestResult)),
  );
