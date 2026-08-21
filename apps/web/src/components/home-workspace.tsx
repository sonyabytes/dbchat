import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Database, MessageSquare, Moon, PanelRight, Plus, Search, Settings, Sun, X } from "lucide-react";

import { ThreadList } from "@/components/chat/thread-list";
import { HomeDataBrowser, HomeTabActions } from "@/components/data/home-data-browser";
import { ChatView } from "@/components/screens/chat";
import { SourcePicker } from "@/components/sources/source-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useGlobalKeybindings } from "@/lib/keybindings";
import { useCloseTab, useOpenTab } from "@/lib/nav";
import { usePalette } from "@/lib/palette";
import { toggleTheme } from "@/lib/settings";
import { tabIds, useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

const newDraftId = () => `new-${Date.now().toString(36)}`;

export function HomeWorkspace({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const openTab = useOpenTab();
  const closeTab = useCloseTab();
  const openPalette = usePalette((state) => state.setOpen);
  const tabs = useApp((state) => state.tabs);
  const activeTab = useApp((state) => state.activeTab);
  const rightPanel = useApp((state) => state.rightPanel);
  const setRightPanel = useApp((state) => state.setRightPanel);
  const dark = useApp((state) => state.dark);
  const setGlobalWorkspace = useApp((state) => state.setGlobalWorkspace);
  const [sidebarSection, setSidebarSection] = useState<"chats" | "databases">("chats");
  const [databaseFilter, setDatabaseFilter] = useState("");

  useGlobalKeybindings();
  useEffect(() => setGlobalWorkspace(), [setGlobalWorkspace]);

  const active = tabs.find((tab) => tab.id === activeTab);
  const secondary = [...tabs].reverse().find((tab) => tab.kind === "chat" && tab.id !== activeTab);
  const showSplit = rightPanel === "chat" && Boolean(secondary);
  const newChat = () => {
    const threadId = newDraftId();
    openTab({ id: tabIds.chat(threadId), kind: "chat", threadId, title: "New chat" });
  };

  return (
    <div className="flex h-full bg-canvas">
      <aside className="flex h-full w-[272px] shrink-0 flex-col border-r border-line bg-sidebar">
        <div className="flex h-12 items-center gap-2 px-3">
          <SourcePicker threadId={active?.kind === "chat" ? active.threadId : undefined} />
          <Button variant="ghost" size="icon-sm" aria-label="New chat" onClick={newChat} className="ml-auto">
            <Plus />
          </Button>
        </div>
        <div className="px-3 pb-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={sidebarSection === "databases" ? databaseFilter : ""}
              onChange={(event) => sidebarSection === "databases" && setDatabaseFilter(event.target.value)}
              onClick={() => sidebarSection === "chats" && openPalette(true)}
              readOnly={sidebarSection === "chats"}
              placeholder={sidebarSection === "chats" ? "Search conversations" : "Find table or column"}
              className="h-7 bg-field pl-7 pr-9 text-xs"
            />
            {sidebarSection === "chats" ? (
              <button type="button" onClick={() => openPalette(true)} aria-label="Open command palette" className="absolute right-1 top-1/2 -translate-y-1/2 rounded-xs bg-muted px-1 font-sans text-[10px] font-medium text-muted-foreground hover:text-foreground">⌘K</button>
            ) : null}
          </div>
        </div>
        <div className="flex h-8 items-center px-3 pb-1">
          <ToggleGroup value={[sidebarSection]} onValueChange={(value) => {
            const next = value[0];
            if (next === "chats" || next === "databases") setSidebarSection(next);
          }} size="sm" spacing={1}>
            <ToggleGroupItem value="chats" aria-label="Show conversations">
              <MessageSquare data-icon="inline-start" /> Chats
            </ToggleGroupItem>
            <ToggleGroupItem value="databases" aria-label="Show all databases">
              <Database data-icon="inline-start" /> Databases
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
          {sidebarSection === "chats" ? (
            <ThreadList showNewChat={false} />
          ) : (
            <HomeDataBrowser filter={databaseFilter} />
          )}
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

      <div className="flex min-w-0 flex-1 flex-col">
        <div role="tablist" className="flex h-10 shrink-0 items-end gap-0.5 border-b border-line bg-canvas px-2">
          {tabs.filter((tab) => tab.kind === "chat").map((tab) => {
            const selected = tab.id === activeTab;
            return (
              <div key={tab.id} role="tab" aria-selected={selected} onClick={() => openTab(tab)}
                className={cn("group flex h-8 max-w-[220px] cursor-default items-center gap-1.5 rounded-t-md px-2.5 text-xs", selected ? "bg-surface text-ink shadow-hairline" : "text-ink-2 hover:bg-hover")}>
                <MessageSquare className="size-3.5 text-brand" />
                <span className="truncate">{tab.title}</span>
                <button type="button" className="ml-0.5 rounded-sm p-0.5 text-ink-3 opacity-0 group-hover:opacity-100" aria-label={`Close ${tab.title}`} onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }}><X className="size-3" /></button>
              </div>
            );
          })}
          <HomeTabActions
            onNewChat={newChat}
            onBrowseDatabases={() => setSidebarSection("databases")}
            databasesActive={sidebarSection === "databases"}
          />
          <Tooltip>
            <TooltipTrigger render={<Button variant={showSplit ? "secondary" : "ghost"} size="icon-xs" aria-label="Toggle split chat" onClick={() => setRightPanel(showSplit ? null : "chat")} className="mb-1 ml-auto" />}><PanelRight /></TooltipTrigger>
            <TooltipContent>Split chat view</TooltipContent>
          </Tooltip>
        </div>

        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          <ResizablePanel defaultSize={showSplit ? 62 : 100} minSize={30} className="bg-surface">
            {children}
          </ResizablePanel>
          {showSplit ? (
            <>
              <ResizableHandle />
              <ResizablePanel defaultSize={38} minSize={24} className="flex min-h-0 flex-col bg-canvas">
                <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3 text-xs">
                  <MessageSquare className="size-3.5 text-brand" />
                  <span className="truncate font-medium">{secondary?.kind === "chat" ? secondary.title : "New chat"}</span>
                </div>
                <div className="min-h-0 flex-1"><ChatView compact threadId={secondary?.kind === "chat" ? secondary.threadId : "home"} /></div>
              </ResizablePanel>
            </>
          ) : null}
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
