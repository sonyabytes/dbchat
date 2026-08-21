import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { MessageId } from "@dbchat/contracts";

import { TurnNormalizer, displayToolName } from "./events.ts";

const mid = "m_test" as MessageId;
const sid = "sess-1";

const assistant = (content: unknown[]): SDKMessage =>
  ({ type: "assistant", uuid: "u1", session_id: sid, parent_tool_use_id: null, message: { role: "assistant", content } }) as unknown as SDKMessage;
const user = (content: unknown[]): SDKMessage =>
  ({ type: "user", uuid: "u2", session_id: sid, parent_tool_use_id: null, message: { role: "user", content } }) as unknown as SDKMessage;
const delta = (d: unknown): SDKMessage =>
  ({ type: "stream_event", uuid: "u3", session_id: sid, parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: d } }) as unknown as SDKMessage;
const result = (over: Record<string, unknown> = {}): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    session_id: sid,
    uuid: "u4",
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
    errors: [],
    ...over,
  }) as unknown as SDKMessage;

describe("TurnNormalizer", () => {
  test("captures session id from system init", () => {
    const n = new TurnNormalizer(mid);
    const out = n.handle({ type: "system", subtype: "init", session_id: sid } as unknown as SDKMessage);
    expect(out).toEqual([]);
    expect(n.sessionId).toBe(sid);
  });

  test("per-block assistant messages (no partials): text, thinking, tool_use, tool_result, result", () => {
    let t = 1000;
    const n = new TurnNormalizer(mid, () => t);
    const events = [
      ...n.handle(assistant([{ type: "thinking", thinking: "hmm" }])),
      ...n.handle(assistant([{ type: "text", text: "Let me look." }])),
      ...n.handle(assistant([{ type: "tool_use", id: "tu1", name: "mcp__dbchat__list_schemas", input: {} }])),
    ];
    t = 1040;
    events.push(...n.handle(user([{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: '[{"schema":"public"}]' }] }])));
    events.push(...n.handle(result()));

    expect(events.map((e) => e._tag)).toEqual(["ThinkingDelta", "TextDelta", "ToolStart", "ToolEnd", "TurnDone"]);
    const start = events[2]!;
    expect(start._tag === "ToolStart" && start.name).toBe("list_schemas");
    const end = events[3]!;
    expect(end._tag === "ToolEnd" && end.durationMs).toBe(40);
    expect(end._tag === "ToolEnd" && end.output).toEqual([{ schema: "public" }]);
    const done = events[4]!;
    expect(done._tag === "TurnDone" && done.usage).toEqual({ inputTokens: 110, outputTokens: 5, costUsd: 0.01 });

    expect([...n.snapshotParts()] as unknown[]).toEqual([
      { _tag: "Thinking", text: "hmm" },
      { _tag: "Text", text: "Let me look." },
      { _tag: "ToolCall", id: "tu1", name: "list_schemas", input: {}, status: "done", output: [{ schema: "public" }], durationMs: 40 },
    ]);
    expect(n.outcome?.ok).toBe(true);
  });

  test("partial messages stream deltas and the full assistant block is not re-emitted", () => {
    const n = new TurnNormalizer(mid);
    const events = [
      ...n.handle(delta({ type: "text_delta", text: "Hel" })),
      ...n.handle(delta({ type: "text_delta", text: "lo" })),
      ...n.handle(assistant([{ type: "text", text: "Hello" }])),
      ...n.handle(result()),
    ];
    expect(events.map((e) => e._tag)).toEqual(["TextDelta", "TextDelta", "TurnDone"]);
    expect(n.snapshotParts()).toEqual([{ _tag: "Text", text: "Hello" }]);
  });

  test("error results emit Error then TurnDone", () => {
    const n = new TurnNormalizer(mid);
    const events = n.handle(result({ subtype: "error_max_turns", errors: ["too many turns"] }));
    expect(events.map((e) => e._tag)).toEqual(["Error", "TurnDone"]);
    expect(n.outcome?.error).toBe("too many turns");
  });

  test("tool events (ResultTable / approvals) are folded into parts", () => {
    const n = new TurnNormalizer(mid);
    n.ingestToolEvent({ _tag: "ResultTable", messageId: mid, columns: [], rows: [[1]], sql: "select 1" });
    n.ingestToolEvent({ _tag: "ApprovalRequested", messageId: mid, approvalId: "ap1" as never, sql: "delete from x" });
    n.ingestToolEvent({ _tag: "ApprovalResolved", approvalId: "ap1" as never, status: "executed" });
    expect([...n.snapshotParts()] as unknown[]).toEqual([
      { _tag: "ResultTable", columns: [], rows: [[1]], sql: "select 1" },
      { _tag: "Approval", id: "ap1", sql: "delete from x", status: "executed" },
    ]);
  });

  test("displayToolName strips the mcp prefix", () => {
    expect(displayToolName("mcp__dbchat__run_sql")).toBe("run_sql");
    expect(displayToolName("Bash")).toBe("Bash");
  });
});
