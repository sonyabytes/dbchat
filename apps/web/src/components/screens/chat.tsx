import type { ApprovalId, ChatContext, ConnectionId } from "@dbchat/contracts";
import { Loader } from "@/components/shared/primitives";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChatMessage } from "@/components/chat/message";
import { PromptBar } from "@/components/shared/prompt-bar";
import { ErrorBanner } from "@/components/shared/primitives";
import { isDraftThread, useChat } from "@/lib/chat-store";
import { useConnectionId } from "@/lib/nav";
import { useSettings } from "@/lib/settings";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { modelLabel, modelsQuery, resolveSelectedModel } from "@/rpc/ai";
import { createThread, threadListKey, threadListQuery } from "@/rpc/chat";
import { schemaListQuery } from "@/rpc/queries";

/**
 * Chat surface. Rendered full-width by the thread route and `compact` in the
 * workspace side panel — both read the same per-thread store, so a turn started
 * in one shows up live in the other with a single subscription.
 */
export function ChatView({ compact = false, threadId: threadIdProp }: { compact?: boolean; threadId?: string }) {
  const connectionId = useConnectionId();
  const connection = useApp((s) => s.connection);
  const params = useParams({ strict: false }) as { threadId?: string; schema?: string; table?: string };
  const search = useSearch({ strict: false }) as { context?: string; sql?: string };
  const navigate = useNavigate();
  const qc = useQueryClient();

  const currentThread = useChat((s) => s.currentThread[connectionId]);
  const threadId = threadIdProp ?? params.threadId ?? currentThread ?? "home";
  const draft = isDraftThread(threadId);

  const thread = useChat((s) => s.threads[threadId]);
  const messages = thread?.messages ?? [];
  const streaming = thread?.streaming ?? false;
  const error = thread?.error;

  const { attach, detach, load, send, retry, abort, clearError, resolveApproval, setCurrentThread, setModel } =
    useChat.getState();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [contextOff, setContextOff] = useState(false);

  /* one subscription per thread, refcounted across the tab + the side panel */
  useEffect(() => {
    if (!threadId || draft) return;
    attach(threadId);
    void load(threadId);
    return () => detach(threadId);
  }, [threadId, draft, attach, detach, load]);

  useEffect(() => {
    if (connectionId && threadId && !draft) setCurrentThread(connectionId, threadId);
  }, [connectionId, threadId, draft, setCurrentThread]);

  /* @mentions from the live schema */
  const { data: schemas } = useQuery({ ...schemaListQuery(connectionId as ConnectionId), enabled: Boolean(connectionId) });
  const tables = useMemo(
    () =>
      (schemas ?? []).flatMap((s) =>
        s.tables.map((t) => ({
          schema: s.name,
          name: t.name,
          detail: t.rowEstimate ? `${Intl.NumberFormat("en", { notation: "compact" }).format(t.rowEstimate)} rows` : "",
        })),
      ),
    [schemas],
  );

  /* model: this session's pick → the thread's last model → user default → server default */
  const { data: catalog } = useQuery(modelsQuery);
  const { data: threads } = useQuery({ ...threadListQuery(connectionId), enabled: Boolean(connectionId) && !draft });
  const persistedModel = threads?.find((t) => t.id === threadId)?.model;
  const sessionModel = useChat((s) => s.threads[threadId]?.model);
  const defaultModel = useSettings((s) => s.defaultModel);
  const selectedModel = resolveSelectedModel(catalog, [sessionModel, persistedModel, defaultModel]);
  /** Label for the model that produced a turn, falling back to the current selection. */
  const turnModelLabel = (id: string | undefined) => modelLabel(catalog, id) ?? selectedModel?.label;

  /* context: ?context=schema.table / ?sql=… , or the table the side panel is sitting on */
  const autoTableContext = useSettings((s) => s.autoTableContext);
  const contextTable =
    search.context ??
    (autoTableContext && compact && params.schema && params.table ? `${params.schema}.${params.table}` : undefined);
  const contextSql = search.sql;
  const contextLabel = contextOff ? null : (contextTable ?? (contextSql ? "editor query" : null));
  const context: ChatContext | undefined = useMemo(
    () =>
      contextOff ? undefined : contextTable ? { table: contextTable } : contextSql ? { sql: contextSql } : undefined,
    [contextOff, contextTable, contextSql],
  );

  const openInEditor = useCallback(
    (sql: string) => {
      void navigate({ to: "/c/$connectionId/sql/$queryId", params: { connectionId, queryId: "new" }, search: { sql } });
    },
    [navigate, connectionId],
  );

  const doSend = useCallback(
    async (text: string) => {
      setCreateError(null);
      if (!draft) {
        send(threadId, text, context, selectedModel?.id);
        return;
      }
      setCreating(true);
      try {
        const t = await createThread(connectionId, text.slice(0, 60));
        void qc.invalidateQueries({ queryKey: threadListKey(connectionId) });
        setCurrentThread(connectionId, t.id);
        // Carry the draft's pick onto the real thread so the picker does not blink back.
        if (selectedModel) setModel(t.id, selectedModel.id);
        send(t.id, text, context, selectedModel?.id);
        if (!compact) {
          void navigate({ to: "/c/$connectionId/chat/$threadId", params: { connectionId, threadId: t.id }, search: {} });
        }
      } catch {
        setCreateError("Could not start a new chat on this connection.");
      } finally {
        setCreating(false);
      }
    },
    [draft, threadId, context, send, connectionId, qc, setCurrentThread, setModel, compact, navigate, selectedModel],
  );

  /* stick to the bottom while a turn streams */
  const scroller = useRef<HTMLDivElement>(null);
  const lastPartCount = messages[messages.length - 1]?.parts.length ?? 0;
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, streaming, lastPartCount]);

  const promptProps = {
    compact,
    tables,
    streaming,
    onStop: () => abort(threadId),
    onSend: (t: string) => void doSend(t),
    disabled: creating,
    context: contextLabel ? { label: contextLabel, onRemove: () => setContextOff(true) } : null,
    ...(selectedModel ? { model: selectedModel.id, modelLabel: selectedModel.label } : {}),
    // Applies from the next send onwards; the server persists it on the thread.
    onModelChange: (id: string) => setModel(threadId, id),
  };

  const empty = messages.length === 0;

  if (empty && draft) {
    return (
      <div className={cn("flex h-full flex-col items-center justify-center px-6", compact && "px-3")}>
        <h2 className={cn("text-center font-semibold tracking-tight", compact ? "text-base" : "text-xl")}>
          What do you want to know about <span className="font-mono">{connection?.database ?? "your data"}</span>?
        </h2>
        <div className={cn("mt-6 w-full", compact ? "max-w-none" : "max-w-2xl")}>
          <PromptBar {...promptProps} autoFocus={!compact} />
        </div>
        {createError && <div className="mt-3 w-full max-w-2xl"><ErrorBanner message={createError} /></div>}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto">
        <div className={cn("mx-auto flex w-full flex-col gap-5 px-4 py-5", compact ? "max-w-none" : "max-w-3xl")}>
          {empty && (
            <p className="py-8 text-center text-sm text-ink-3">
              No messages yet — ask something about <span className="font-mono">{connection?.database ?? "this database"}</span>.
            </p>
          )}
          {messages.map((m, i) => (
            <ChatMessage
              key={m.id}
              message={m}
              streaming={streaming && i === messages.length - 1}
              {...(connection?.name ? { connectionName: connection.name } : {})}
              {...(connection?.env ? { env: connection.env } : {})}
              onOpenSql={openInEditor}
              {...(turnModelLabel(m.model) ? { modelLabel: turnModelLabel(m.model)! } : {})}
              onRetry={
                m.role === "assistant" && i === messages.length - 1
                  ? () => retry(threadId, context, selectedModel?.id)
                  : undefined
              }
              onApprove={(approvalId, approve) => void resolveApproval(threadId, approvalId as ApprovalId, approve)}
            />
          ))}
          {streaming && messages[messages.length - 1]?.role === "user" && (
            <Loader />
          )}
          {(error || createError) && (
            <ErrorBanner message={error ?? createError ?? ""} onDismiss={() => { clearError(threadId); setCreateError(null); }} />
          )}
        </div>
      </div>
      <div className={cn("shrink-0 px-4 pb-4 pt-2", !compact && "mx-auto w-full max-w-3xl")}>
        <PromptBar {...promptProps} />
      </div>
    </div>
  );
}
