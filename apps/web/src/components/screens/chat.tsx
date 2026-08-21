import type { ApprovalId, ChatContext, ConnectionId, SourceRef } from "@dbchat/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { ChatMessage } from "@/components/chat/message";
import { PromptBar } from "@/components/shared/prompt-bar";
import { ErrorBanner, Loader } from "@/components/shared/primitives";
import { SourcePicker } from "@/components/sources/source-picker";
import { Badge } from "@/components/ui/badge";
import { isDraftThread, useChat } from "@/lib/chat-store";
import { useSettings } from "@/lib/settings";
import { useSources } from "@/lib/source-store";
import { cn } from "@/lib/utils";
import { modelLabel, modelsQuery, resolveSelectedModel } from "@/rpc/ai";
import { createThread, threadListKey, threadListQuery } from "@/rpc/chat";
import { gitRepositoryListQuery } from "@/rpc/git";
import { connectionListQuery, schemaListQuery } from "@/rpc/queries";

const EMPTY_SOURCES: ReadonlyArray<SourceRef> = [];

export function ChatView({ compact = false, threadId: threadIdProp }: { compact?: boolean; threadId?: string }) {
  const params = useParams({ strict: false }) as { threadId?: string; schema?: string; table?: string };
  const search = useSearch({ strict: false }) as { context?: string; sql?: string };
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const currentThread = useChat((state) => state.currentThread.global);
  const threadId = threadIdProp ?? params.threadId ?? currentThread ?? "home";
  const draft = isDraftThread(threadId);
  const chat = useChat((state) => state.threads[threadId]);
  const messages = chat?.messages ?? [];
  const streaming = chat?.streaming ?? false;
  const error = chat?.error;
  const { attach, detach, load, send, retry, abort, clearError, resolveApproval, setCurrentThread, setModel } = useChat.getState();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [dismissedContextKey, setDismissedContextKey] = useState<string | null>(null);

  const { data: threads = [] } = useQuery(threadListQuery);
  const { data: connections = [] } = useQuery(connectionListQuery);
  const { data: repositories = [] } = useQuery(gitRepositoryListQuery);
  const draftSources = useSources((state) => state.draftSources);
  const persistedThread = threads.find((thread) => thread.id === threadId);
  const selectedSources = draft ? draftSources : (persistedThread?.sources ?? EMPTY_SOURCES);
  const databaseSources = selectedSources.filter((source) => source.kind === "database");
  const primaryConnectionId = databaseSources[0]?.id;
  const primaryConnection = connections.find((connection) => connection.id === primaryConnectionId);

  useEffect(() => {
    if (!threadId || draft) return;
    attach(threadId);
    void load(threadId);
    return () => detach(threadId);
  }, [threadId, draft, attach, detach, load]);

  useEffect(() => {
    if (!draft) setCurrentThread("global", threadId);
  }, [threadId, draft, setCurrentThread]);

  const { data: schemas } = useQuery({
    ...schemaListQuery((primaryConnectionId ?? "unattached") as ConnectionId),
    enabled: Boolean(primaryConnectionId),
  });
  const tables = useMemo(() => (schemas ?? []).flatMap((schema) => schema.tables.map((table) => ({
    schema: schema.name,
    name: table.name,
    detail: table.rowEstimate ? `${Intl.NumberFormat("en", { notation: "compact" }).format(table.rowEstimate)} rows` : "",
  }))), [schemas]);

  const { data: catalog } = useQuery(modelsQuery);
  const persistedModel = persistedThread?.model;
  const sessionModel = useChat((state) => state.threads[threadId]?.model);
  const defaultModel = useSettings((state) => state.defaultModel);
  const selectedModel = resolveSelectedModel(catalog, [sessionModel, persistedModel, defaultModel]);
  const turnModelLabel = (id: string | undefined) => modelLabel(catalog, id) ?? selectedModel?.label;

  const autoTableContext = useSettings((state) => state.autoTableContext);
  const contextTable = search.context ?? (autoTableContext && compact && params.schema && params.table ? `${params.schema}.${params.table}` : undefined);
  const contextSql = search.sql;
  const contextKey = contextTable ? `table:${contextTable}` : contextSql ? `sql:${contextSql}` : null;
  const contextDismissed = contextKey !== null && contextKey === dismissedContextKey;
  const contextLabel = contextDismissed ? null : (contextTable ?? (contextSql ? "editor query" : null));
  const context: ChatContext | undefined = contextDismissed ? undefined : contextTable ? { table: contextTable } : contextSql ? { sql: contextSql } : undefined;

  const openInEditor = (sql: string) => {
    if (!primaryConnectionId) return;
    void navigate({ to: "/c/$connectionId/sql/$queryId", params: { connectionId: primaryConnectionId, queryId: "new" }, search: { sql } });
  };

  const doSend = async (text: string) => {
    setCreateError(null);
    if (!draft) {
      send(threadId, text, context, selectedModel?.id);
      return;
    }
    setCreating(true);
    try {
      const thread = await createThread(text.slice(0, 60), selectedSources);
      void queryClient.invalidateQueries({ queryKey: threadListKey });
      setCurrentThread("global", thread.id);
      if (selectedModel) setModel(thread.id, selectedModel.id);
      send(thread.id, text, context, selectedModel?.id);
      if (!compact) void navigate({ to: "/chat/$threadId", params: { threadId: thread.id }, search: {} });
    } catch {
      setCreateError("Could not start a new conversation.");
    } finally {
      setCreating(false);
    }
  };

  const scroller = useRef<HTMLDivElement>(null);
  const lastPartCount = messages[messages.length - 1]?.parts.length ?? 0;
  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages.length, streaming, lastPartCount]);

  const promptProps = {
    compact,
    tables,
    streaming,
    onStop: () => abort(threadId),
    onSend: (text: string) => void doSend(text),
    disabled: creating,
    context: contextLabel && contextKey
      ? { label: contextLabel, onRemove: () => setDismissedContextKey(contextKey) }
      : null,
    ...(selectedModel ? { model: selectedModel.id, modelLabel: selectedModel.label } : {}),
    onModelChange: (id: string) => setModel(threadId, id),
  };

  const sourceLabels = selectedSources.map((source) => source.kind === "database"
    ? connections.find((connection) => connection.id === source.id)?.name
    : repositories.find((repository) => repository.id === source.id)?.name,
  ).filter((label): label is string => Boolean(label));
  const sourceInfo = (source: SourceRef | undefined) => {
    if (!source) return undefined;
    if (source.kind === "database") {
      const connection = connections.find((candidate) => candidate.id === source.id);
      return connection ? { name: connection.name, env: connection.env } : undefined;
    }
    const repository = repositories.find((candidate) => candidate.id === source.id);
    return repository ? { name: `${repository.name} · ${repository.headCommit.slice(0, 8)}` } : undefined;
  };
  const sourceControls = (
    <div className="mb-2 flex min-w-0 items-center gap-1.5">
      <SourcePicker threadId={threadId} compact />
      <div className="flex min-w-0 gap-1 overflow-hidden">
        {sourceLabels.slice(0, 3).map((label) => <Badge key={label} variant="outline" className="truncate">{label}</Badge>)}
        {sourceLabels.length > 3 ? <Badge variant="outline">+{sourceLabels.length - 3}</Badge> : null}
      </div>
    </div>
  );

  const empty = messages.length === 0;
  if (empty && draft) {
    return (
      <div className={cn("flex h-full flex-col items-center justify-center px-6", compact && "px-3")}>
        <h2 className={cn("text-center font-semibold tracking-tight", compact ? "text-base" : "text-xl")}>
          What do you want to explore?
        </h2>
        <p className="mt-2 text-center text-sm text-ink-3">
          Ask a general question, or attach databases and Git models for live context.
        </p>
        <div className={cn("mt-6 w-full", compact ? "max-w-none" : "max-w-2xl")}>
          {sourceControls}
          <PromptBar {...promptProps} autoFocus={!compact} />
        </div>
        {createError ? <div className="mt-3 w-full max-w-2xl"><ErrorBanner message={createError} /></div> : null}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto">
        <div className={cn("mx-auto flex w-full flex-col gap-5 px-4 py-5", compact ? "max-w-none" : "max-w-3xl")}>
          {empty ? <p className="py-8 text-center text-sm text-ink-3">No messages yet—ask about your connected sources or start without one.</p> : null}
          {messages.map((message, index) => (
            <ChatMessage
              key={message.id}
              message={message}
              streaming={streaming && index === messages.length - 1}
              sourceInfo={sourceInfo}
              {...(primaryConnection?.name ? { connectionName: primaryConnection.name } : {})}
              {...(primaryConnection?.env ? { env: primaryConnection.env } : {})}
              {...(primaryConnectionId ? { onOpenSql: openInEditor } : {})}
              {...(turnModelLabel(message.model) ? { modelLabel: turnModelLabel(message.model)! } : {})}
              onRetry={message.role === "assistant" && index === messages.length - 1 ? () => retry(threadId, context, selectedModel?.id) : undefined}
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
        {sourceControls}
        <PromptBar {...promptProps} />
      </div>
    </div>
  );
}
