import type { ApprovalId, ChatEvent, MessageId, MessagePart, ToolCallId, Usage } from "@dbchat/contracts";

type MutablePart =
  | { _tag: "Text"; text: string }
  | { _tag: "Thinking"; text: string }
  | { _tag: "ToolCall"; id: ToolCallId; name: string; input: unknown; status: "running" | "done" | "error"; output?: unknown; durationMs?: number }
  | Extract<MessagePart, { _tag: "ResultTable" }>
  | { _tag: "Approval"; id: ApprovalId; sql: string; rowEstimate?: number; status: "pending" | "approved" | "rejected" | "executed" | "failed" };

const outputValue = (content: ReadonlyArray<{ type: "text"; text: string }>): unknown => {
  const text = content.map((item) => item.text).join("\n");
  try { return JSON.parse(text); } catch { return text; }
};

/** Accumulates provider-neutral callbacks into the same persisted parts/events as Claude. */
export class DriverEventCollector {
  readonly parts: MutablePart[] = [];
  usage: Usage | undefined;
  private readonly starts = new Map<string, number>();
  readonly messageId: MessageId;
  private readonly now: () => number;

  constructor(messageId: MessageId, now: () => number = Date.now) {
    this.messageId = messageId;
    this.now = now;
  }

  text(text: string): ChatEvent | undefined {
    if (!text) return undefined;
    const last = this.parts[this.parts.length - 1];
    if (last?._tag === "Text") last.text += text;
    else this.parts.push({ _tag: "Text", text });
    return { _tag: "TextDelta", messageId: this.messageId, text };
  }

  thinking(text: string): ChatEvent | undefined {
    if (!text) return undefined;
    const last = this.parts[this.parts.length - 1];
    if (last?._tag === "Thinking") last.text += text;
    else this.parts.push({ _tag: "Thinking", text });
    return { _tag: "ThinkingDelta", messageId: this.messageId, text };
  }

  toolStart(id: string, name: string, input: unknown): ChatEvent {
    this.starts.set(id, this.now());
    this.parts.push({ _tag: "ToolCall", id: id as ToolCallId, name, input, status: "running" });
    return { _tag: "ToolStart", messageId: this.messageId, toolCallId: id as ToolCallId, name, input };
  }

  toolEnd(id: string, content: ReadonlyArray<{ type: "text"; text: string }>, isError: boolean): ChatEvent {
    const durationMs = Math.max(0, this.now() - (this.starts.get(id) ?? this.now()));
    const output = outputValue(content);
    const part = this.parts.find((item) => item._tag === "ToolCall" && item.id === id);
    if (part?._tag === "ToolCall") {
      part.status = isError ? "error" : "done";
      part.output = output;
      part.durationMs = durationMs;
    }
    return { _tag: "ToolEnd", toolCallId: id as ToolCallId, output, durationMs, isError };
  }

  ingestToolEvent(event: ChatEvent): void {
    if (event._tag === "ResultTable") {
      this.parts.push({ _tag: "ResultTable", columns: event.columns, rows: event.rows, sql: event.sql });
    } else if (event._tag === "ApprovalRequested") {
      this.parts.push({
        _tag: "Approval",
        id: event.approvalId,
        sql: event.sql,
        ...(event.rowEstimate !== undefined ? { rowEstimate: event.rowEstimate } : {}),
        status: "pending",
      });
    } else if (event._tag === "ApprovalResolved") {
      const part = this.parts.find((item) => item._tag === "Approval" && item.id === event.approvalId);
      if (part?._tag === "Approval") part.status = event.status;
    }
  }

  snapshotParts(): ReadonlyArray<MessagePart> {
    return this.parts.map((part) => ({ ...part })) as ReadonlyArray<MessagePart>;
  }
}
