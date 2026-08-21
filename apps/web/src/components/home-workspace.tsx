import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquare, Moon, Plus, Search, Settings, Sun } from "lucide-react";
import { usePanelRef } from "react-resizable-panels";

import { ThreadList } from "@/components/chat/thread-list";
import { WorkItemDataPane } from "@/components/data/work-item-data-pane";
import { SourcePicker } from "@/components/sources/source-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useGlobalKeybindings } from "@/lib/keybindings";
import { useOpenTab } from "@/lib/nav";
import { usePalette } from "@/lib/palette";
import { toggleTheme } from "@/lib/settings";
import { tabIds, useApp } from "@/lib/store";

const newDraftId = () => `new-${Date.now().toString(36)}`;

export function HomeWorkspace({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const openTab = useOpenTab();
  const openPalette = usePalette((state) => state.setOpen);
  const tabs = useApp((state) => state.tabs);
  const activeTab = useApp((state) => state.activeTab);
  const dark = useApp((state) => state.dark);
  const setGlobalWorkspace = useApp((state) => state.setGlobalWorkspace);
  const conversationPanelRef = usePanelRef();

  useGlobalKeybindings();
  useEffect(() => setGlobalWorkspace(), [setGlobalWorkspace]);

  const active = tabs.find((tab) => tab.id === activeTab);
  const workItemId = active?.kind === "chat" ? active.threadId : "home";
  const workItemTitle = active?.kind === "chat" ? active.title : "New work item";
  const dataFocused = useApp((state) => state.dataWorkspaces[workItemId]?.focused ?? false);
  useEffect(() => {
    if (dataFocused) conversationPanelRef.current?.collapse();
    else conversationPanelRef.current?.expand();
  }, [conversationPanelRef, dataFocused]);
  const newChat = () => {
    const threadId = newDraftId();
    openTab({ id: tabIds.chat(threadId), kind: "chat", threadId, title: "New work item" });
  };

  return (
    <div className="flex h-full bg-canvas">
      <aside className="flex h-full w-[272px] shrink-0 flex-col border-r border-line bg-sidebar">
        <div className="flex h-12 items-center gap-2 px-3">
          <SourcePicker threadId={active?.kind === "chat" ? active.threadId : undefined} />
          <Button variant="ghost" size="icon-sm" aria-label="New work item" onClick={newChat} className="ml-auto">
            <Plus />
          </Button>
        </div>
        <div className="px-3 pb-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value=""
              onClick={() => openPalette(true)}
              readOnly
              placeholder="Search work items"
              className="h-7 bg-field pl-7 pr-9 text-xs"
            />
            <button type="button" onClick={() => openPalette(true)} aria-label="Open command palette" className="absolute right-1 top-1/2 -translate-y-1/2 rounded-xs bg-muted px-1 font-sans text-[10px] font-medium text-muted-foreground hover:text-foreground">⌘K</button>
          </div>
        </div>
        <div className="flex h-8 items-center gap-1.5 px-4 pb-1 text-xs font-medium text-ink-2">
          <MessageSquare className="size-3.5 text-brand" />
          Work items
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
          <ThreadList showNewChat={false} />
        </div>
        <Separator />
        <div className="flex items-center gap-1 p-2">
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Settings" onClick={() => void navigate({ to: "/settings" })} />}><Settings /></TooltipTrigger>
            <TooltipContent>Settings · ⌘,</TooltipContent>
          </Tooltip>
          <Button variant="ghost" size="icon-sm" aria-label="Toggle theme" onClick={toggleTheme} className="ml-auto">{dark ? <Sun /> : <Moon />}</Button>
        </div>
      </aside>

      <ResizablePanelGroup orientation="horizontal" className="min-w-0 flex-1">
        <ResizablePanel
          panelRef={conversationPanelRef}
          defaultSize="52%"
          minSize="30%"
          collapsible
          collapsedSize="0%"
          className="flex min-h-0 flex-col bg-surface"
        >
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3 text-xs">
            <MessageSquare className="size-3.5 text-brand" />
            <span className="truncate font-medium">{workItemTitle}</span>
            <span className="ml-auto text-[10px] uppercase tracking-wide text-ink-3">Conversation</span>
          </div>
          <div className="min-h-0 flex-1">{children}</div>
        </ResizablePanel>
        <ResizableHandle withHandle className={dataFocused ? "pointer-events-none opacity-0" : undefined} />
        <ResizablePanel defaultSize="48%" minSize="30%" className="min-h-0 bg-canvas">
          <WorkItemDataPane key={workItemId} workItemId={workItemId} />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
