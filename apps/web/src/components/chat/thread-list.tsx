import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, MessageSquare, Plus, Trash2, X } from "lucide-react";

import { StatusDot } from "@/components/shared/primitives";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useChat } from "@/lib/chat-store";
import { relativeTime } from "@/lib/format";
import { useCloseTab, useOpenTab } from "@/lib/nav";
import { tabIds, useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { deleteThread, threadListKey, threadListQuery } from "@/rpc/chat";

const draftId = () => `new-${Date.now().toString(36)}`;

/** Global conversations, independent of whichever databases are currently attached. */
export function ThreadList({ showNewChat = true }: { showNewChat?: boolean }) {
  const { data: threads, isLoading } = useQuery(threadListQuery);
  const activeTab = useApp((state) => state.activeTab);
  const openTab = useOpenTab();
  const closeTab = useCloseTab();
  const openTabs = useApp((state) => state.tabs);
  const queryClient = useQueryClient();
  const streamingThreads = useChat((state) => state.threads);
  const resetThread = useChat((state) => state.reset);
  const setCurrentThread = useChat((state) => state.setCurrentThread);

  const remove = useMutation({
    mutationFn: (threadId: string) => deleteThread(threadId),
    onSuccess: (_result, threadId) => {
      resetThread(threadId);
      void queryClient.invalidateQueries({ queryKey: threadListKey });
    },
  });

  const newChat = () => {
    const threadId = draftId();
    openTab({ id: tabIds.chat(threadId), kind: "chat", threadId, title: "New chat" });
  };

  const open = (thread: { id: string; title: string }) => {
    setCurrentThread("global", thread.id);
    openTab({ id: tabIds.chat(thread.id), kind: "chat", threadId: thread.id, title: thread.title });
  };

  return (
    <div className="flex flex-col gap-0.5">
      {showNewChat ? (
        <button type="button" onClick={newChat} className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-[13px] text-ink-2 hover:bg-hover">
          <Plus className="size-3.5 text-ink-3" />
          <span>New chat</span>
        </button>
      ) : null}

      {isLoading ? <div className="px-2 py-1 text-xs text-ink-3">Loading…</div> : null}
      {!isLoading && threads?.length === 0 ? <div className="px-2 py-1 text-xs text-ink-3">No work items yet.</div> : null}

      {threads?.map((thread) => {
        const live = streamingThreads[thread.id]?.streaming ?? false;
        const tabId = tabIds.chat(thread.id);
        const active = activeTab === tabId;
        const isOpen = openTabs.some((tab) => tab.id === tabId);
        return (
          <ContextMenu key={thread.id}>
            <ContextMenuTrigger
              className={cn(
                "group flex h-8 w-full items-center gap-2 rounded-sm px-2 text-[13px] hover:bg-hover",
                active && "bg-sidebar-accent",
              )}
            >
              <button type="button" onClick={() => open(thread)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                {live ? <StatusDot status="running" /> : <MessageSquare className="size-3.5 shrink-0 text-ink-3" />}
                <span className="truncate">{thread.title}</span>
              </button>
              <span className="shrink-0 font-mono text-[10.5px] text-ink-3 group-hover:hidden">{relativeTime(thread.updatedAt)}</span>
              <Button variant="ghost" size="icon-xs" aria-label={`Delete ${thread.title}`} className="hidden shrink-0 text-ink-3 hover:text-danger group-hover:inline-flex" onClick={() => remove.mutate(thread.id)}>
                <Trash2 />
              </Button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={() => open(thread)}>
                <ExternalLink />
                Open
              </ContextMenuItem>
              <ContextMenuItem onClick={() => void navigator.clipboard.writeText(thread.title)}>
                <Copy />
                Copy title
              </ContextMenuItem>
              {isOpen && (
                <ContextMenuItem onClick={() => closeTab(tabId)}>
                  <X />
                  Close tab
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" disabled={live} onClick={() => remove.mutate(thread.id)}>
                <Trash2 />
                Delete
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
    </div>
  );
}
