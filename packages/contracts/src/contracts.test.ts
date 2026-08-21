import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";

import { ChatEvent, Message, MessagePart } from "./chat.ts";
import { NotFound, SqlError, WriteBlocked } from "./errors.ts";
import { ConnectionId, ThreadId } from "./ids.ts";

const decode = Schema.decodeUnknownSync;
const encode = Schema.encodeUnknownSync;

describe("branded ids", () => {
  test("accept non-empty strings", () => {
    expect(decode(ConnectionId)("c1")).toBe("c1" as never);
    expect(decode(ThreadId)("t-abc")).toBe("t-abc" as never);
  });

  test("reject empty strings and non-strings", () => {
    expect(() => decode(ConnectionId)("")).toThrow();
    expect(() => decode(ConnectionId)(42)).toThrow();
    expect(() => decode(ThreadId)(null)).toThrow();
  });
});

describe("MessagePart union", () => {
  test("decodes every variant by _tag", () => {
    expect(decode(MessagePart)({ _tag: "Text", text: "hi" })).toEqual({ _tag: "Text", text: "hi" });
    expect(decode(MessagePart)({ _tag: "Thinking", text: "hmm" })._tag).toBe("Thinking");
    expect(decode(MessagePart)({ _tag: "ToolCall", id: "tc1", name: "run_sql", input: { sql: "select 1" }, status: "running" })._tag).toBe("ToolCall");
    expect(decode(MessagePart)({ _tag: "Approval", id: "a1", sql: "delete from t", status: "pending" })._tag).toBe("Approval");
    expect(decode(MessagePart)({ _tag: "ResultTable", columns: [], rows: [], sql: "select 1" })._tag).toBe("ResultTable");
  });

  test("rejects unknown tags and bad enum values", () => {
    expect(() => decode(MessagePart)({ _tag: "Nope", text: "x" })).toThrow();
    expect(() => decode(MessagePart)({ _tag: "ToolCall", id: "tc1", name: "x", input: null, status: "pending" })).toThrow();
    expect(() => decode(MessagePart)({ _tag: "Approval", id: "a1", sql: "x", status: "running" })).toThrow();
  });

  test("optional fields round-trip through encode", () => {
    const part = { _tag: "ToolCall" as const, id: "tc1", name: "x", input: 1, status: "done" as const, durationMs: 12 };
    expect(encode(MessagePart)(decode(MessagePart)(part))).toEqual(part);
  });
});

describe("Message / ChatEvent", () => {
  test("message requires a valid role and part list", () => {
    const msg = { id: "m1", threadId: "t1", role: "user", parts: [{ _tag: "Text", text: "hello" }], createdAt: "2026-01-01T00:00:00.000Z" };
    expect(decode(Message)(msg)).toEqual(msg as never);
    expect(() => decode(Message)({ ...msg, role: "system" })).toThrow();
    expect(() => decode(Message)({ ...msg, parts: [{ _tag: "Text" }] })).toThrow();
  });

  test("chat events decode from their JSON wire form", () => {
    expect(decode(ChatEvent)({ _tag: "TextDelta", messageId: "m1", text: "a" })).toEqual({ _tag: "TextDelta", messageId: "m1", text: "a" } as never);
    expect(decode(ChatEvent)({ _tag: "ApprovalResolved", approvalId: "a1", status: "approved" })._tag).toBe("ApprovalResolved");
    expect(() => decode(ChatEvent)({ _tag: "TextDelta", messageId: "m1" })).toThrow();
  });
});

describe("tagged errors", () => {
  test("carry their tag and fields", () => {
    const e = new SqlError({ message: "syntax error", position: 7 });
    expect(e._tag).toBe("SqlError");
    expect(e.message).toBe("syntax error");
    expect(e.position).toBe(7);
    expect(e instanceof Error).toBe(true);
  });

  test("survive an encode/decode round-trip (what the RPC layer does)", () => {
    const nf = new NotFound({ entity: "thread", id: "t1" });
    const wire = encode(NotFound)(nf);
    expect(wire).toMatchObject({ _tag: "NotFound", entity: "thread", id: "t1" });
    const back = decode(NotFound)(wire);
    expect(back).toBeInstanceOf(NotFound);
    expect(back.id).toBe("t1");
  });

  test("WriteBlocked keeps the offending sql", () => {
    const wb = new WriteBlocked({ sql: "drop table t", reason: "read-only" });
    expect(decode(WriteBlocked)(encode(WriteBlocked)(wb)).sql).toBe("drop table t");
  });
});
