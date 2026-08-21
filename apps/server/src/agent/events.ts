/**
 * Normalises Claude Agent SDK messages into ChatEvents and accumulates the
 * assistant Message parts for persistence. Pure & synchronous: feed messages in,
 * get events out. One instance per turn.
 */
import type { ApprovalId, ChatEvent, MessagePart, MessageId, SourceRef, ToolCallId, Usage } from "@dbchat/contracts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export const MCP_SERVER_NAME = "dbchat";
const MCP_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

export const displayToolName = (name: string) => (name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name);

type MutablePart =
  | { _tag: "Text"; text: string }
  | { _tag: "Thinking"; text: string }
  | {
      _tag: "ToolCall";
      id: ToolCallId;
      name: string;
      input: unknown;
      status: "running" | "done" | "error";
      output?: unknown;
      durationMs?: number;
    }
  | Extract<MessagePart, { _tag: "ResultTable" }>
  | { _tag: "Approval"; id: ApprovalId; sql: string; rowEstimate?: number; status: "pending" | "approved" | "rejected" | "executed" | "failed"; source?: SourceRef };

export interface TurnOutcome {
  readonly ok: boolean;
  readonly usage: Usage | undefined;
  readonly error: string | undefined;
}

const tryJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

const toolResultOutput = (content: unknown): unknown => {
  if (typeof content === "string") return tryJson(content);
  if (Array.isArray(content)) {
    const texts = content
      .filter((b): b is { type: "text"; text: string } => !!b && typeof b === "object" && (b as { type?: string }).type === "text")
      .map((b) => b.text);
    if (texts.length === 1) return tryJson(texts[0]!);
    if (texts.length > 1) return texts.map(tryJson);
    return content;
  }
  return content;
};

export class TurnNormalizer {
  readonly parts: MutablePart[] = [];
  sessionId: string | undefined;
  outcome: TurnOutcome | undefined;
  private sawPartials = false;
  private readonly toolStartedAt = new Map<string, number>();
  private readonly now: () => number;

  readonly messageId: MessageId;

  constructor(messageId: MessageId, now: () => number = Date.now) {
    this.messageId = messageId;
    this.now = now;
  }

  /** Events produced by our own MCP tools still need to land in the persisted parts. */
  ingestToolEvent(event: ChatEvent): void {
    switch (event._tag) {
      case "ResultTable":
        this.parts.push({ _tag: "ResultTable", columns: event.columns, rows: event.rows, sql: event.sql, ...(event.source ? { source: event.source } : {}) });
        return;
      case "ApprovalRequested":
        this.parts.push({
          _tag: "Approval",
          id: event.approvalId,
          sql: event.sql,
          ...(event.rowEstimate !== undefined ? { rowEstimate: event.rowEstimate } : {}),
          ...(event.source ? { source: event.source } : {}),
          status: "pending",
        });
        return;
      case "ApprovalResolved": {
        const p = this.parts.find((x) => x._tag === "Approval" && x.id === event.approvalId);
        if (p && p._tag === "Approval") p.status = event.status;
        return;
      }
      default:
        return;
    }
  }

  handle(msg: SDKMessage): ChatEvent[] {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") this.sessionId = msg.session_id;
        return [];
      case "stream_event":
        return this.handleStreamEvent(msg.event as StreamEvent);
      case "assistant":
        return this.handleAssistant(msg.message.content as ReadonlyArray<ContentBlock>);
      case "user":
        return this.handleUser(msg.message.content);
      case "result":
        return this.handleResult(msg);
      default:
        return [];
    }
  }

  private appendText(tag: "Text" | "Thinking", text: string): void {
    const last = this.parts[this.parts.length - 1];
    if (last && last._tag === tag) last.text += text;
    else this.parts.push({ _tag: tag, text });
  }

  private handleStreamEvent(ev: StreamEvent): ChatEvent[] {
    if (ev.type !== "content_block_delta") return [];
    const d = ev.delta;
    if (d.type === "text_delta" && d.text) {
      this.sawPartials = true;
      this.appendText("Text", d.text);
      return [{ _tag: "TextDelta", messageId: this.messageId, text: d.text }];
    }
    if (d.type === "thinking_delta" && d.thinking) {
      this.sawPartials = true;
      this.appendText("Thinking", d.thinking);
      return [{ _tag: "ThinkingDelta", messageId: this.messageId, text: d.thinking }];
    }
    return [];
  }

  private handleAssistant(content: ReadonlyArray<ContentBlock>): ChatEvent[] {
    const out: ChatEvent[] = [];
    for (const block of content) {
      if (block.type === "text") {
        if (this.sawPartials) {
          // Already streamed token-by-token; reconcile the part to the final text.
          const last = [...this.parts].reverse().find((p) => p._tag === "Text");
          if (last && last._tag === "Text") last.text = block.text;
          continue;
        }
        if (block.text) {
          this.parts.push({ _tag: "Text", text: block.text });
          out.push({ _tag: "TextDelta", messageId: this.messageId, text: block.text });
        }
      } else if (block.type === "thinking") {
        if (this.sawPartials) {
          const last = [...this.parts].reverse().find((p) => p._tag === "Thinking");
          if (last && last._tag === "Thinking") last.text = block.thinking;
          continue;
        }
        if (block.thinking) {
          this.parts.push({ _tag: "Thinking", text: block.thinking });
          out.push({ _tag: "ThinkingDelta", messageId: this.messageId, text: block.thinking });
        }
      } else if (block.type === "tool_use") {
        const id = block.id as ToolCallId;
        const name = displayToolName(block.name);
        this.toolStartedAt.set(block.id, this.now());
        this.parts.push({ _tag: "ToolCall", id, name, input: block.input, status: "running" });
        out.push({ _tag: "ToolStart", messageId: this.messageId, toolCallId: id, name, input: block.input });
      }
    }
    return out;
  }

  private handleUser(content: string | ReadonlyArray<unknown>): ChatEvent[] {
    if (typeof content === "string") return [];
    const out: ChatEvent[] = [];
    for (const raw of content) {
      const block = raw as ToolResultBlock;
      if (!block || block.type !== "tool_result") continue;
      const startedAt = this.toolStartedAt.get(block.tool_use_id);
      const durationMs = startedAt === undefined ? 0 : Math.max(0, this.now() - startedAt);
      const isError = block.is_error === true;
      const output = toolResultOutput(block.content);
      const part = this.parts.find((p) => p._tag === "ToolCall" && p.id === block.tool_use_id);
      if (part && part._tag === "ToolCall") {
        part.status = isError ? "error" : "done";
        part.output = output;
        part.durationMs = durationMs;
      }
      out.push({ _tag: "ToolEnd", toolCallId: block.tool_use_id as ToolCallId, output, durationMs, isError });
    }
    return out;
  }

  private handleResult(msg: Extract<SDKMessage, { type: "result" }>): ChatEvent[] {
    const usage: Usage = {
      inputTokens: msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0),
      outputTokens: msg.usage.output_tokens,
      costUsd: msg.total_cost_usd,
    };
    const out: ChatEvent[] = [];
    let error: string | undefined;
    if (msg.subtype !== "success") {
      error = (msg.errors.length > 0 ? msg.errors.join("; ") : undefined) ?? msg.subtype;
    } else if (msg.is_error) {
      error = msg.result || "Turn ended with an error.";
    }
    if (error !== undefined) out.push({ _tag: "Error", message: error });
    this.outcome = { ok: error === undefined, usage, error };
    out.push({ _tag: "TurnDone", messageId: this.messageId, usage });
    return out;
  }

  snapshotParts(): ReadonlyArray<MessagePart> {
    return this.parts.map((p) => ({ ...p })) as ReadonlyArray<MessagePart>;
  }
}

/* ---- minimal structural types for the Anthropic blocks we touch ---- */
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "other" };

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
}

type StreamEvent =
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "thinking_delta"; thinking: string }
        | { type: "input_json_delta"; partial_json: string }
        | { type: "other" };
    }
  | { type: "other" };
