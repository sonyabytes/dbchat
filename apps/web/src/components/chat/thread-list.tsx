import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Plus, Trash2 } from "lucide-react";

import { StatusDot } from "@/components/shared/primitives";
import { Button } from "@/components/ui/button";
import { useChat } from "@/lib/chat-store";
import { relativeTime } from "@/lib/format";
import { useOpenTab } from "@/lib/nav";
import { tabIds, useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { createThread, deleteThread, threadListKey, threadListQuery } from "@/rpc/chat";

/** Chat threads for the sidebar's "Chats" section. Rendered by the workspace sidebar. */
export function ThreadList({ connectionId }: { connectionId: string }) {
  const { data: threads, isLoading } = useQuery(threadListQuery(connectionId));
  const activeTab = useApp((s) => s.activeTab);
  const openTab = useOpenTab();
  const qc = useQueryClient();
  const streamingThreads = useChat((s) => s.threads);
  const resetThread = useChat((s) => s.reset);
  const setCurrentThread = useChat((s) => s.setCurrentThread);

  const create = useMutation({
    mutationFn: () => createThread(connectionId),
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: threadListKey(connectionId) });
      setCurrentThread(connectionId, t.id);
      openTab({ id: tabIds.chat(t.id), kind: "chat", threadId: t.id, title: t.title });
    },
  });

  const remove = useMutation({
    mutationFn: (threadId: string) => deleteThread(threadId),
    onSuccess: (_r, threadId) => {
      resetThread(threadId);
      void qc.invalidateQueries({ queryKey: threadListKey(connectionId) });
    },
  });

  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={() => create.mutate()}
        disabled={create.isPending}
        className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-[13px] text-ink-2 hover:bg-hover disabled:opacity-50"
      >
        <Plus className="size-3.5 text-ink-3" />
        <span>New chat</span>
      </button>

      {isLoading && <div className="px-2 py-1 text-[11.5px] text-ink-3">Loading…</div>}
      {!isLoading && threads?.length === 0 && (
        <div className="px-2 py-1 text-[11.5px] text-ink-3">No chats yet.</div>
      )}

      {threads?.map((t) => {
        const live = streamingThreads[t.id]?.streaming ?? false;
        const active = activeTab === tabIds.chat(t.id);
        return (
          <div
            key={t.id}
            className={cn(
              "group flex h-8 w-full items-center gap-2 rounded-sm px-2 text-[13px] hover:bg-hover",
              active && "bg-sidebar-accent",
            )}
          >
            <button
              type="button"
              onClick={() => {
                setCurrentThread(connectionId, t.id);
                openTab({ id: tabIds.chat(t.id), kind: "chat", threadId: t.id, title: t.title });
              }}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              {live ? <StatusDot status="running" /> : <MessageSquare className="size-3.5 shrink-0 text-ink-3" />}
              <span className="truncate">{t.title}</span>
            </button>
            <span className="shrink-0 font-mono text-[10.5px] text-ink-3 group-hover:hidden">
              {relativeTime(t.updatedAt)}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Delete ${t.title}`}
              className="hidden shrink-0 text-ink-3 hover:text-danger group-hover:inline-flex"
              onClick={() => remove.mutate(t.id)}
            >
              <Trash2 />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
