/**
 * Per-thread chat state: ChatEvents reduced into the message/part model from contracts.
 *
 * Streaming rule: **one RPC stream per thread at a time**.
 *  - While idle, a mounted view subscribes to `chat.events` (passive mirror of a turn
 *    started anywhere else). Views refcount that subscription, so the main tab and the
 *    side panel showing the same thread share a single socket stream.
 *  - `send` interrupts the passive subscription and consumes `chat.send` instead (the
 *    server publishes the same events to both), then re-subscribes when the turn ends.
 * That keeps every event applied exactly once no matter how many views are mounted.
 */
import {
  type ApprovalId,
  type ChatContext,
  type ChatEvent,
  type MessagePart,
  RPC,
  type ThreadId,
  type Usage,
} from "@dbchat/contracts";
import { create } from "zustand";

import { callRpc, streamRpc } from "@/rpc/client";

export interface UiMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  parts: MessagePart[];
  createdAt: string;
  /** Optimistic user message, not yet echoed by the server. */
  pending?: boolean;
  usage?: Usage;
  /** Model that produced this turn (from `TurnDone`). */
  model?: string;
}

export interface ThreadState {
  messages: UiMessage[];
  streaming: boolean;
  loaded: boolean;
  error?: string;
  lastUserText?: string;
  /**
   * Model this thread is on for the session: set by the picker and refreshed
   * from every `TurnDone`, so both views agree without refetching the thread.
   * Undefined = fall back to the persisted thread model / user default.
   */
  model?: string;
}

const emptyThread: ThreadState = { messages: [], streaming: false, loaded: false };

/* ---------------- reducer helpers ---------------- */

function upsertAssistant(msgs: UiMessage[], threadId: string, messageId: string): UiMessage[] {
  if (msgs.some((m) => m.id === messageId)) return msgs;
  return [...msgs, { id: messageId, threadId, role: "assistant", parts: [], createdAt: new Date().toISOString() }];
}

function patch(msgs: UiMessage[], id: string, fn: (m: UiMessage) => UiMessage): UiMessage[] {
  return msgs.map((m) => (m.id === id ? fn(m) : m));
}

function appendDelta(parts: MessagePart[], tag: "Text" | "Thinking", text: string): MessagePart[] {
  const last = parts[parts.length - 1];
  if (last && last._tag === tag) return [...parts.slice(0, -1), { ...last, text: last.text + text }];
  return [...parts, { _tag: tag, text }];
}

function mapParts(msgs: UiMessage[], fn: (p: MessagePart) => MessagePart | null): UiMessage[] {
  let touched = false;
  const next = msgs.map((m) => {
    let changed = false;
    const parts = m.parts.map((p) => {
      const r = fn(p);
      if (r && r !== p) changed = true;
      return r ?? p;
    });
    if (!changed) return m;
    touched = true;
    return { ...m, parts };
  });
  return touched ? next : msgs;
}

/** Pure reducer: ChatEvent → messages. Stream-level flags are handled in `applyEvent`. */
export function reduceEvent(messages: UiMessage[], threadId: string, ev: ChatEvent): UiMessage[] {
  switch (ev._tag) {
    case "UserMessage": {
      const incoming: UiMessage = {
        id: ev.message.id,
        threadId,
        role: ev.message.role,
        parts: [...ev.message.parts],
        createdAt: ev.message.createdAt,
      };
      if (messages.some((m) => m.id === incoming.id)) return messages;
      const pendingIdx = messages.findIndex((m) => m.pending && m.role === "user");
      if (pendingIdx >= 0) {
        const next = [...messages];
        next[pendingIdx] = incoming;
        return next;
      }
      return [...messages, incoming];
    }
    case "TextDelta":
    case "ThinkingDelta": {
      const tag = ev._tag === "TextDelta" ? "Text" : "Thinking";
      const withMsg = upsertAssistant(messages, threadId, ev.messageId);
      return patch(withMsg, ev.messageId, (m) => ({ ...m, parts: appendDelta(m.parts, tag, ev.text) }));
    }
    case "ToolStart": {
      const withMsg = upsertAssistant(messages, threadId, ev.messageId);
      return patch(withMsg, ev.messageId, (m) => ({
        ...m,
        parts: [...m.parts, { _tag: "ToolCall", id: ev.toolCallId, name: ev.name, input: ev.input, status: "running" }],
      }));
    }
    case "ToolEnd":
      return mapParts(messages, (p) =>
        p._tag === "ToolCall" && p.id === ev.toolCallId
          ? { ...p, status: ev.isError ? "error" : "done", output: ev.output, durationMs: ev.durationMs }
          : p,
      );
    case "ResultTable": {
      const withMsg = upsertAssistant(messages, threadId, ev.messageId);
      return patch(withMsg, ev.messageId, (m) => ({
        ...m,
        parts: [...m.parts, { _tag: "ResultTable", columns: ev.columns, rows: ev.rows, sql: ev.sql, ...(ev.source ? { source: ev.source } : {}) }],
      }));
    }
    case "ApprovalRequested": {
      const withMsg = upsertAssistant(messages, threadId, ev.messageId);
      return patch(withMsg, ev.messageId, (m) => ({
        ...m,
        parts: [
          ...m.parts,
          {
            _tag: "Approval",
            id: ev.approvalId,
            sql: ev.sql,
            status: "pending",
            ...(ev.rowEstimate === undefined ? {} : { rowEstimate: ev.rowEstimate }),
            ...(ev.source ? { source: ev.source } : {}),
          },
        ],
      }));
    }
    case "ApprovalResolved":
      return mapParts(messages, (p) => (p._tag === "Approval" && p.id === ev.approvalId ? { ...p, status: ev.status } : p));
    case "TurnDone": {
      const withMsg = upsertAssistant(messages, threadId, ev.messageId);
      if (!ev.usage && !ev.model) return withMsg;
      return patch(withMsg, ev.messageId, (m) => ({
        ...m,
        ...(ev.usage ? { usage: ev.usage } : {}),
        ...(ev.model ? { model: ev.model } : {}),
      }));
    }
    default:
      return messages;
  }
}

/* ---------------- stream bookkeeping (outside react state) ---------------- */

interface StreamHandle {
  refs: number;
  mode: "events" | "send" | null;
  stop?: () => void;
  aborting?: boolean;
}
const handles = new Map<string, StreamHandle>();
const handle = (id: string): StreamHandle => {
  let h = handles.get(id);
  if (!h) handles.set(id, (h = { refs: 0, mode: null }));
  return h;
};

function errorText(e: unknown, depth = 0): string {
  if (e == null || depth > 4) return "Something went wrong";
  if (typeof e === "string") return e;
  const any = e as Record<string, unknown>;
  if (typeof any.message === "string" && any.message) return any.message;
  if (Array.isArray(any.failures)) {
    for (const f of any.failures as Array<Record<string, unknown>>) {
      if (f?._tag === "Fail" && f.error) return errorText(f.error, depth + 1);
      if (f?.error) return errorText(f.error, depth + 1);
    }
  }
  if (any.error) return errorText(any.error, depth + 1);
  if (any.cause) return errorText(any.cause, depth + 1);
  return "Something went wrong";
}

function isInterrupt(e: unknown): boolean {
  const any = e as Record<string, unknown> | null;
  if (!any || typeof any !== "object") return false;
  if (Array.isArray(any.failures)) return (any.failures as Array<{ _tag?: string }>).every((f) => f?._tag === "Interrupt");
  return false;
}

/* ---------------- store ---------------- */

interface ChatStore {
  threads: Record<string, ThreadState>;
  /** Last chat thread opened per connection — what the side panel mirrors. */
  currentThread: Record<string, string>;
  setCurrentThread: (connectionId: string, threadId: string) => void;

  get: (threadId: string) => ThreadState;
  applyEvent: (threadId: string, ev: ChatEvent) => void;
  /** Pick the model for the next turn on this thread. */
  setModel: (threadId: string, model: string) => void;
  /** Load history once (no-op for draft threads). */
  load: (threadId: string) => Promise<void>;
  /** Mount a view: refcount + passive `chat.events` subscription. */
  attach: (threadId: string) => void;
  detach: (threadId: string) => void;
  send: (threadId: string, text: string, context?: ChatContext, model?: string) => void;
  retry: (threadId: string, context?: ChatContext, model?: string) => void;
  abort: (threadId: string) => void;
  resolveApproval: (threadId: string, approvalId: ApprovalId, approve: boolean) => Promise<void>;
  reset: (threadId: string) => void;
  clearError: (threadId: string) => void;
}

/** Draft thread ids never exist server-side; the first send creates a real thread. */
export const isDraftThread = (threadId: string): boolean =>
  !threadId || threadId === "home" || threadId === "new" || threadId.startsWith("new-") || threadId.startsWith("draft-");

export const useChat = create<ChatStore>((set, get) => {
  const mutate = (threadId: string, fn: (t: ThreadState) => ThreadState) =>
    set((s) => ({ threads: { ...s.threads, [threadId]: fn(s.threads[threadId] ?? emptyThread) } }));

  const stopStream = (threadId: string) => {
    const h = handle(threadId);
    if (h.stop) {
      h.aborting = true;
      h.stop();
      h.stop = undefined;
      h.mode = null;
      h.aborting = false;
    }
  };

  const subscribeEvents = (threadId: string) => {
    const h = handle(threadId);
    if (h.mode || h.refs <= 0 || isDraftThread(threadId)) return;
    h.mode = "events";
    h.stop = streamRpc(
      (c) => c[RPC.chatEvents]({ threadId: threadId as ThreadId }),
      (ev) => get().applyEvent(threadId, ev),
      {
        onError: () => {
          if (handle(threadId).mode === "events") {
            handle(threadId).mode = null;
            handle(threadId).stop = undefined;
          }
        },
        onDone: () => {
          if (handle(threadId).mode === "events") {
            handle(threadId).mode = null;
            handle(threadId).stop = undefined;
          }
        },
      },
    );
  };

  const finishTurn = (threadId: string, error?: string) => {
    const h = handle(threadId);
    h.stop = undefined;
    h.mode = null;
    mutate(threadId, (t) => ({ ...t, streaming: false, ...(error ? { error } : {}) }));
    subscribeEvents(threadId);
  };

  const startSend = (threadId: string, text: string, context?: ChatContext, model?: string) => {
    stopStream(threadId);
    const optimistic: UiMessage = {
      id: `local_${Date.now().toString(36)}`,
      threadId,
      role: "user",
      parts: [{ _tag: "Text", text }],
      createdAt: new Date().toISOString(),
      pending: true,
    };
    mutate(threadId, (t) => ({
      ...t,
      messages: [...t.messages, optimistic],
      streaming: true,
      lastUserText: text,
      error: undefined,
    }));
    const h = handle(threadId);
    h.mode = "send";
    h.stop = streamRpc(
      (c) =>
        c[RPC.chatSend]({
          threadId: threadId as ThreadId,
          text,
          ...(context ? { context } : {}),
          ...(model ? { model } : {}),
        }),
      (ev) => get().applyEvent(threadId, ev),
      {
        onDone: () => finishTurn(threadId),
        onError: (e) => finishTurn(threadId, isInterrupt(e) ? undefined : errorText(e)),
      },
    );
  };

  return {
    threads: {},
    currentThread: {},
    setCurrentThread: (connectionId, threadId) =>
      set((s) =>
        s.currentThread[connectionId] === threadId
          ? s
          : { currentThread: { ...s.currentThread, [connectionId]: threadId } },
      ),

    get: (threadId) => get().threads[threadId] ?? emptyThread,

    setModel: (threadId, model) => mutate(threadId, (t) => (t.model === model ? t : { ...t, model })),

    applyEvent: (threadId, ev) => {
      if (ev._tag === "Error") {
        mutate(threadId, (t) => ({ ...t, error: ev.message, streaming: false }));
        return;
      }
      mutate(threadId, (t) => {
        const messages = reduceEvent(t.messages, threadId, ev);
        if (ev._tag === "TurnDone") {
          return { ...t, messages, streaming: false, ...(ev.model ? { model: ev.model } : {}) };
        }
        // Any event other than the closing one means a turn is in flight (covers
        // the passive `chat.events` mirror, where we never called `send` ourselves).
        return { ...t, messages, streaming: true };
      });
    },

    load: async (threadId) => {
      if (isDraftThread(threadId)) {
        mutate(threadId, (t) => ({ ...t, loaded: true }));
        return;
      }
      if (get().get(threadId).loaded) return;
      try {
        const msgs = await callRpc((c) => c[RPC.chatMessagesList]({ threadId: threadId as ThreadId }));
        mutate(threadId, (t) => ({
          ...t,
          loaded: true,
          messages: msgs.length
            ? msgs.map((m) => ({
                id: m.id,
                threadId,
                role: m.role,
                parts: [...m.parts],
                createdAt: m.createdAt,
              }))
            : t.messages,
        }));
      } catch {
        mutate(threadId, (t) => ({ ...t, loaded: true }));
      }
    },

    attach: (threadId) => {
      if (!threadId) return;
      const h = handle(threadId);
      h.refs += 1;
      if (h.refs === 1 && !h.mode) subscribeEvents(threadId);
    },

    detach: (threadId) => {
      if (!threadId) return;
      const h = handle(threadId);
      h.refs = Math.max(0, h.refs - 1);
      // Keep an in-flight `chat.send` alive (interrupting it aborts the turn server-side).
      if (h.refs === 0 && h.mode === "events") stopStream(threadId);
    },

    send: (threadId, text, context, model) => startSend(threadId, text, context, model),

    retry: (threadId, context, model) => {
      const last = get().get(threadId).lastUserText;
      if (!last) return;
      // Drop the previous assistant turn so the retry renders cleanly.
      mutate(threadId, (t) => {
        const lastUser = [...t.messages].reverse().findIndex((m) => m.role === "user");
        if (lastUser < 0) return t;
        const idx = t.messages.length - 1 - lastUser;
        return { ...t, messages: t.messages.slice(0, idx) };
      });
      startSend(threadId, last, context, model);
    },

    abort: (threadId) => {
      const h = handle(threadId);
      if (h.mode === "send") stopStream(threadId);
      mutate(threadId, (t) => ({ ...t, streaming: false }));
      if (!isDraftThread(threadId)) {
        void callRpc((c) => c[RPC.chatAbort]({ threadId: threadId as ThreadId })).catch(() => {});
      }
      subscribeEvents(threadId);
    },

    resolveApproval: async (threadId, approvalId, approve) => {
      // Optimistic: mark the card so it stops offering buttons while the server works.
      mutate(threadId, (t) => ({
        ...t,
        messages: mapParts(t.messages, (p) =>
          p._tag === "Approval" && p.id === approvalId ? { ...p, status: approve ? "approved" : "rejected" } : p,
        ),
      }));
      try {
        await callRpc((c) => c[RPC.chatApprovalResolve]({ approvalId, approve }));
      } catch (e) {
        mutate(threadId, (t) => ({
          ...t,
          error: errorText(e),
          messages: mapParts(t.messages, (p) =>
            p._tag === "Approval" && p.id === approvalId ? { ...p, status: approve ? "failed" : "rejected" } : p,
          ),
        }));
      }
    },

    reset: (threadId) => {
      stopStream(threadId);
      set((s) => {
        const { [threadId]: _drop, ...rest } = s.threads;
        return { threads: rest };
      });
    },

    clearError: (threadId) => mutate(threadId, (t) => ({ ...t, error: undefined })),
  };
});

/** Live dot for the sidebar / thread list. */
export const useThreadStreaming = (threadId: string): boolean =>
  useChat((s) => s.threads[threadId]?.streaming ?? false);

/** Dev-only handle so the chat reducer can be driven from the console (`__dbchatChat.getState().applyEvent(...)`). */
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__dbchatChat = useChat;
}
