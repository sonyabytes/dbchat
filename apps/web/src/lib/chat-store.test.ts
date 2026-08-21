import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChatEvent } from "@dbchat/contracts";
import type { UiMessage } from "./chat-store.ts";

/* The store imports the RPC client, which would try to open a WebSocket. Stub it. */
mock.module("@/rpc/client", () => ({
  callRpc: mock(async () => []),
  streamRpc: mock(() => () => {}),
}));

const { isDraftThread, reduceEvent, useChat } = await import("./chat-store.ts");

const T = "thread-1";
const ev = <E extends ChatEvent>(e: E): ChatEvent => e;

const userMsg = (id: string, text: string) =>
  ev({ _tag: "UserMessage", message: { id, threadId: T, role: "user", parts: [{ _tag: "Text", text }], createdAt: "2026-01-01T00:00:00.000Z" } } as never);

const run = (events: ChatEvent[], start: UiMessage[] = []) => events.reduce((msgs, e) => reduceEvent(msgs, T, e), start);

describe("isDraftThread", () => {
  test("draft ids never hit the server", () => {
    for (const id of ["", "home", "new", "new-abc", "draft-xyz"]) expect(isDraftThread(id)).toBe(true);
    expect(isDraftThread("thr_123")).toBe(false);
    expect(isDraftThread("newish")).toBe(false);
  });
});

describe("reduceEvent", () => {
  test("UserMessage replaces the optimistic pending message instead of duplicating it", () => {
    const pending: UiMessage = { id: "local_1", threadId: T, role: "user", parts: [{ _tag: "Text", text: "hi" }], createdAt: "x", pending: true };
    const out = run([userMsg("m1", "hi")], [pending]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "m1", role: "user" });
    expect(out[0]!.pending).toBeUndefined();
  });

  test("UserMessage is idempotent (events can arrive on two subscriptions)", () => {
    const out = run([userMsg("m1", "hi"), userMsg("m1", "hi")]);
    expect(out).toHaveLength(1);
  });

  test("TextDelta creates the assistant message and coalesces consecutive deltas", () => {
    const out = run([
      ev({ _tag: "TextDelta", messageId: "a1", text: "Hel" } as never),
      ev({ _tag: "TextDelta", messageId: "a1", text: "lo" } as never),
      ev({ _tag: "ThinkingDelta", messageId: "a1", text: "…" } as never),
      ev({ _tag: "TextDelta", messageId: "a1", text: "!" } as never),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe("assistant");
    expect(out[0]!.parts).toEqual([
      { _tag: "Text", text: "Hello" },
      { _tag: "Thinking", text: "…" },
      { _tag: "Text", text: "!" },
    ]);
  });

  test("ToolStart → ToolEnd updates the matching tool call in place", () => {
    const out = run([
      ev({ _tag: "ToolStart", messageId: "a1", toolCallId: "tc1", name: "run_sql", input: { sql: "select 1" } } as never),
      ev({ _tag: "ToolStart", messageId: "a1", toolCallId: "tc2", name: "describe", input: {} } as never),
      ev({ _tag: "ToolEnd", toolCallId: "tc1", output: { rows: 1 }, isError: false, durationMs: 12 } as never),
      ev({ _tag: "ToolEnd", toolCallId: "tc2", output: "boom", isError: true, durationMs: 3 } as never),
    ]);
    expect(out[0]!.parts).toEqual([
      { _tag: "ToolCall", id: "tc1", name: "run_sql", input: { sql: "select 1" }, status: "done", output: { rows: 1 }, durationMs: 12 },
      { _tag: "ToolCall", id: "tc2", name: "describe", input: {}, status: "error", output: "boom", durationMs: 3 },
    ] as never);
  });

  test("ToolEnd for an unknown id leaves the array untouched (same reference)", () => {
    const before = run([ev({ _tag: "TextDelta", messageId: "a1", text: "x" } as never)]);
    const after = reduceEvent(before, T, ev({ _tag: "ToolEnd", toolCallId: "nope", output: null, isError: false, durationMs: 0 } as never));
    expect(after).toBe(before);
  });

  test("ApprovalRequested → ApprovalResolved flips status; rowEstimate only when present", () => {
    const out = run([
      ev({ _tag: "ApprovalRequested", messageId: "a1", approvalId: "ap1", sql: "delete from t", rowEstimate: 42 } as never),
      ev({ _tag: "ApprovalRequested", messageId: "a1", approvalId: "ap2", sql: "drop table t" } as never),
      ev({ _tag: "ApprovalResolved", approvalId: "ap1", status: "approved" } as never),
    ]);
    expect(out[0]!.parts).toEqual([
      { _tag: "Approval", id: "ap1", sql: "delete from t", status: "approved", rowEstimate: 42 },
      { _tag: "Approval", id: "ap2", sql: "drop table t", status: "pending" },
    ] as never);
  });

  test("ResultTable appends a table part", () => {
    const out = run([ev({ _tag: "ResultTable", messageId: "a1", columns: [{ name: "n", type: "int4" }], rows: [{ n: 1 }], sql: "select 1 n" } as never)]);
    expect(out[0]!.parts[0]).toMatchObject({ _tag: "ResultTable", sql: "select 1 n", rows: [{ n: 1 }] });
  });

  test("TurnDone records usage and model on the assistant message", () => {
    const out = run([
      ev({ _tag: "TextDelta", messageId: "a1", text: "done" } as never),
      ev({ _tag: "TurnDone", messageId: "a1", usage: { inputTokens: 10, outputTokens: 5 }, model: "claude-sonnet-5" } as never),
    ]);
    expect(out[0]).toMatchObject({ usage: { inputTokens: 10, outputTokens: 5 }, model: "claude-sonnet-5" });
  });

  test("events for a second assistant message do not touch the first", () => {
    const out = run([
      ev({ _tag: "TextDelta", messageId: "a1", text: "one" } as never),
      userMsg("m2", "more"),
      ev({ _tag: "TextDelta", messageId: "a2", text: "two" } as never),
    ]);
    expect(out.map((m) => m.id)).toEqual(["a1", "m2", "a2"]);
    expect(out[0]!.parts).toEqual([{ _tag: "Text", text: "one" }]);
  });
});

describe("useChat.applyEvent", () => {
  beforeEach(() => useChat.setState({ threads: {}, currentThread: {} }));

  test("Error events set the thread error and stop streaming", () => {
    useChat.setState({ threads: { [T]: { messages: [], streaming: true, loaded: true } } });
    useChat.getState().applyEvent(T, ev({ _tag: "Error", message: "rate limited" } as never));
    expect(useChat.getState().get(T)).toMatchObject({ error: "rate limited", streaming: false });
  });

  test("TurnDone refreshes the thread model", () => {
    useChat.getState().applyEvent(T, ev({ _tag: "TurnDone", messageId: "a1", model: "claude-opus-5" } as never));
    expect(useChat.getState().get(T).model).toBe("claude-opus-5");
  });

  test("setCurrentThread is a no-op when unchanged (no new object)", () => {
    useChat.getState().setCurrentThread("c1", T);
    const before = useChat.getState().currentThread;
    useChat.getState().setCurrentThread("c1", T);
    expect(useChat.getState().currentThread).toBe(before);
  });

  test("get() returns the empty thread for unknown ids", () => {
    expect(useChat.getState().get("missing")).toEqual({ messages: [], streaming: false, loaded: false });
  });
});
