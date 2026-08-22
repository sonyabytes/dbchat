import * as Schema from "effect/Schema";
import { ApprovalId, IsoDateTime, MessageId, ThreadId, ToolCallId } from "./ids.ts";
import { ColumnMeta } from "./schema.ts";
import { SourceRef } from "./source.ts";
import { Row } from "./table.ts";

export const Thread = Schema.Struct({
  id: ThreadId,
  sources: Schema.Array(SourceRef),
  title: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  sdkSessionId: Schema.optional(Schema.String),
  /** Last model used on this thread; the picker reopens on it. */
  model: Schema.optional(Schema.String),
});
export type Thread = typeof Thread.Type;

export const MessageRole = Schema.Literals(["user", "assistant"]);
export type MessageRole = typeof MessageRole.Type;

export const ToolCallStatus = Schema.Literals(["running", "done", "error"]);
export type ToolCallStatus = typeof ToolCallStatus.Type;

export const ApprovalStatus = Schema.Literals(["pending", "approved", "rejected", "executed", "failed"]);
export type ApprovalStatus = typeof ApprovalStatus.Type;

export const TextPart = Schema.Struct({ _tag: Schema.Literal("Text"), text: Schema.String });
export const ThinkingPart = Schema.Struct({ _tag: Schema.Literal("Thinking"), text: Schema.String });
export const ToolCallPart = Schema.Struct({
  _tag: Schema.Literal("ToolCall"),
  id: ToolCallId,
  name: Schema.String,
  input: Schema.Unknown,
  status: ToolCallStatus,
  output: Schema.optional(Schema.Unknown),
  durationMs: Schema.optional(Schema.Number),
});
export const ResultTablePart = Schema.Struct({
  _tag: Schema.Literal("ResultTable"),
  columns: Schema.Array(ColumnMeta),
  rows: Schema.Array(Row),
  sql: Schema.String,
  source: Schema.optional(SourceRef),
});
export const ApprovalPart = Schema.Struct({
  _tag: Schema.Literal("Approval"),
  id: ApprovalId,
  sql: Schema.String,
  rowEstimate: Schema.optional(Schema.Number),
  status: ApprovalStatus,
  source: Schema.optional(SourceRef),
});

export const MessagePart = Schema.Union([TextPart, ThinkingPart, ToolCallPart, ResultTablePart, ApprovalPart]);
export type MessagePart = typeof MessagePart.Type;

export const Message = Schema.Struct({
  id: MessageId,
  threadId: ThreadId,
  role: MessageRole,
  parts: Schema.Array(MessagePart),
  createdAt: IsoDateTime,
});
export type Message = typeof Message.Type;

export const Usage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  costUsd: Schema.optional(Schema.Number),
});
export type Usage = typeof Usage.Type;

/* ---------- Streamed events ---------- */
export const ChatEvent = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("ThreadCreated"), thread: Thread }),
  Schema.Struct({ _tag: Schema.Literal("UserMessage"), message: Message }),
  Schema.Struct({ _tag: Schema.Literal("TextDelta"), messageId: MessageId, text: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("ThinkingDelta"), messageId: MessageId, text: Schema.String }),
  Schema.Struct({
    _tag: Schema.Literal("ToolStart"),
    messageId: MessageId,
    toolCallId: ToolCallId,
    name: Schema.String,
    input: Schema.Unknown,
  }),
  Schema.Struct({
    _tag: Schema.Literal("ToolEnd"),
    toolCallId: ToolCallId,
    output: Schema.Unknown,
    durationMs: Schema.Number,
    isError: Schema.Boolean,
  }),
  Schema.Struct({
    _tag: Schema.Literal("ResultTable"),
    messageId: MessageId,
    columns: Schema.Array(ColumnMeta),
    rows: Schema.Array(Row),
    sql: Schema.String,
    source: Schema.optional(SourceRef),
  }),
  Schema.Struct({
    _tag: Schema.Literal("ApprovalRequested"),
    messageId: MessageId,
    approvalId: ApprovalId,
    sql: Schema.String,
    rowEstimate: Schema.optional(Schema.Number),
    source: Schema.optional(SourceRef),
  }),
  Schema.Struct({ _tag: Schema.Literal("ApprovalResolved"), approvalId: ApprovalId, status: ApprovalStatus }),
  Schema.Struct({
    _tag: Schema.Literal("TurnDone"),
    messageId: MessageId,
    usage: Schema.optional(Usage),
    /** Model id that produced this turn (shown in the message footer). */
    model: Schema.optional(Schema.String),
  }),
  Schema.Struct({ _tag: Schema.Literal("Error"), message: Schema.String }),
]);
export type ChatEvent = typeof ChatEvent.Type;

export const ChatContext = Schema.Struct({
  table: Schema.optional(Schema.String),
  sql: Schema.optional(Schema.String),
});
export type ChatContext = typeof ChatContext.Type;

export const ChatSendInput = Schema.Struct({
  threadId: ThreadId,
  text: Schema.String,
  context: Schema.optional(ChatContext),
  /** Full model id from the catalog; defaults to the thread's, then the server's. */
  model: Schema.optional(Schema.String),
});
export type ChatSendInput = typeof ChatSendInput.Type;

export const ThreadCreateInput = Schema.Struct({
  title: Schema.optional(Schema.String),
  sources: Schema.optional(Schema.Array(SourceRef)),
});
export type ThreadCreateInput = typeof ThreadCreateInput.Type;

export const ThreadSourcesSetInput = Schema.Struct({
  threadId: ThreadId,
  sources: Schema.Array(SourceRef),
});
export type ThreadSourcesSetInput = typeof ThreadSourcesSetInput.Type;

export const ApprovalResolveInput = Schema.Struct({
  approvalId: ApprovalId,
  approve: Schema.Boolean,
});
export type ApprovalResolveInput = typeof ApprovalResolveInput.Type;
