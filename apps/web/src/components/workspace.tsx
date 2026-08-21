import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Outlet, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Download, Loader2, MessageSquare, Moon, PanelRight, Plus, RefreshCw, Search, Settings, Sun, Table2, TerminalSquare, X } from "lucide-react";
import type { ConnectionId } from "@dbchat/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCloseTab, useConnectionId, useOpenTab } from "@/lib/nav";
import { useGlobalKeybindings } from "@/lib/keybindings";
import { usePalette } from "@/lib/palette";
import { toggleTheme } from "@/lib/settings";
import { tabIds, useApp, type Tab } from "@/lib/store";
import { connectionListQuery } from "@/rpc/queries";
import { createThread, threadListKey, threadListQuery } from "@/rpc/chat";
import { useChat } from "@/lib/chat-store";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { connectionConnectQuery } from "@/rpc/connections";
import { cn } from "@/lib/utils";
import { ConnectionNotFound } from "@/components/error-states";
import { ProdConfirmDialog } from "@/components/prod-confirm";
import { DialectIcon, EnvBadge, StatusDot } from "@/components/shared/primitives";
import { SchemaTree, useSchemaRefresh } from "@/components/schema/schema-tree";
import { ThreadList } from "@/components/chat/thread-list";
import { ChatView } from "@/components/screens/chat";

/* ---------------- Sidebar: schema explorer + threads ---------------- */
function CheckForUpdatesButton() {
  const [checking, setChecking] = useState(false);
  const desktop = window.dbchat;
  if (!desktop?.canCheckForUpdates) return null;

  const check = async () => {
    setChecking(true);
    try {
      await desktop.checkForUpdates();
    } catch (error) {
      console.error("Could not open the update checker", error);
    } finally {
      setChecking(false);
    }
  };

  return (
    <Button variant="outline" onClick={() => void check()} disabled={checking} aria-live="polite" className="mb-1 w-full justify-start">
      {checking ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Download data-icon="inline-start" />}
      {checking ? "Checking…" : "Check for updates"}
    </Button>
  );
}

function Sidebar() {
  const { connection, dark } = useApp();
  const openTab = useOpenTab();
  const navigate = useNavigate();
  const openPalette = usePalette((s) => s.setOpen);
  const back = () => void navigate({ to: "/" });
  const [q, setQ] = useState("");
  const [section, setSection] = useState<"schema" | "chats">("schema");
  const connectionId = useConnectionId();
  const { data: status } = useQuery({ ...connectionConnectQuery(connectionId as ConnectionId), enabled: connectionId !== "" });
  const { refresh, isRefreshing } = useSchemaRefresh(connectionId);
  if (!connection) return null;

  return (
    <aside data-app-sidebar className="flex h-full w-[272px] shrink-0 flex-col border-r border-line bg-sidebar">
      <div className="flex h-12 items-center gap-2 px-3">
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-xs" onClick={back} aria-label="All connections" />}><ArrowLeft /></TooltipTrigger>
          <TooltipContent>All connections</TooltipContent>
        </Tooltip>
        <DialectIcon dialect={connection.dialect} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[13px] font-medium leading-tight"><span className="truncate">{connection.name}</span><EnvBadge env={connection.env} /></div>
          <div className="flex items-center gap-1.5 font-mono text-[10.5px] text-ink-3">
            <StatusDot status={status?.state ?? "idle"} />
            <span className="truncate">
              {connection.database || connection.dialect}
              {status?.latencyMs !== undefined ? ` · ${Math.round(status.latencyMs)}ms` : ""}
            </span>
          </div>
        </div>
      </div>

      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={section === "schema" ? "Find table or column" : "Search chats"} className="h-7 bg-field pl-7 pr-9 text-xs" />
          <button type="button" onClick={() => openPalette(true)} aria-label="Open command palette" className="absolute right-1 top-1/2 -translate-y-1/2 rounded-xs bg-muted px-1 font-sans text-[10px] font-medium text-ink-3 hover:text-ink">⌘K</button>
        </div>
      </div>

      <div className="flex items-center gap-1 px-3 pb-1">
        {(["schema", "chats"] as const).map((s) => (
          <button key={s} type="button" onClick={() => setSection(s)}
            className={cn("rounded-sm px-2 py-1 text-[11.5px] font-medium capitalize", section === s ? "bg-sidebar-accent text-ink" : "text-ink-2 hover:bg-hover")}>{s}</button>
        ))}
        <div className="ml-auto flex items-center gap-0.5">
          {section === "schema" ? (
            <>
              <Button variant="ghost" size="icon-xs" aria-label="Refresh schema" onClick={refresh}>
                <RefreshCw className={cn(isRefreshing && "animate-spin")} />
              </Button>
              <Button variant="ghost" size="icon-xs" aria-label="New SQL" onClick={() => { const queryId = `draft-${Date.now().toString(36)}`; openTab({ id: tabIds.sql(queryId), kind: "sql", queryId, title: "untitled.sql" }); }}><TerminalSquare /></Button>
            </>
          ) : (
            <Button variant="ghost" size="icon-xs" aria-label="New chat" onClick={() => { const threadId = `new-${Date.now().toString(36)}`; openTab({ id: tabIds.chat(threadId), kind: "chat", threadId, title: "New chat" }); }}><Plus /></Button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {section === "schema" ? <SchemaTree connectionId={connectionId} filter={q} /> : <ThreadList connectionId={connection.id} />}
      </div>

      <div className="border-t border-line p-2">
        <CheckForUpdatesButton />
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Command palette" onClick={() => openPalette(true)} />}><Search /></TooltipTrigger>
            <TooltipContent>Command palette · ⌘K</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Settings" onClick={() => void navigate({ to: "/settings" })} />}><Settings /></TooltipTrigger>
            <TooltipContent>Settings · ⌘,</TooltipContent>
          </Tooltip>
          <Button variant="ghost" size="icon-sm" aria-label="Toggle theme" onClick={toggleTheme} className="ml-auto">{dark ? <Sun /> : <Moon />}</Button>
        </div>
      </div>
    </aside>
  );
}

/* ---------------- New tab menu ---------------- */
function NewTabMenu() {
  const connectionId = useConnectionId();
  const openTab = useOpenTab();
  const openPalette = usePalette((s) => s.setOpen);
  const qc = useQueryClient();
  const setCurrentThread = useChat((s) => s.setCurrentThread);
  const newChat = useMutation({
    mutationFn: () => createThread(connectionId),
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: threadListKey(connectionId) });
      setCurrentThread(connectionId, t.id);
      openTab({ id: tabIds.chat(t.id), kind: "chat", threadId: t.id, title: t.title });
    },
  });
  const newSql = () => { const queryId = `draft-${Date.now().toString(36)}`; openTab({ id: tabIds.sql(queryId), kind: "sql", queryId, title: "untitled.sql" }); };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" className="mb-1" aria-label="New tab" title="New tab" />}>
        <Plus />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuItem onClick={() => newChat.mutate()} disabled={newChat.isPending}>
          <MessageSquare className="text-brand" /> New chat <DropdownMenuShortcut>⌘N</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={newSql}>
          <TerminalSquare /> New SQL query <DropdownMenuShortcut>⌘T</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => openPalette(true, "tables")}>
          <Table2 /> Open table… <DropdownMenuShortcut>⌘K</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ---------------- Tab strip ---------------- */
function tabIcon(t: Tab) {
  return t.kind === "table" ? Table2 : t.kind === "sql" ? TerminalSquare : MessageSquare;
}
function tabTitle(t: Tab) {
  return t.kind === "table" ? t.table : t.title;
}

function TabStrip() {
  const { tabs, activeTab, rightPanel, setRightPanel } = useApp();
  const openTab = useOpenTab();
  const closeTab = useCloseTab();
  const setActive = (id: string) => { const t = tabs.find((x) => x.id === id); if (t) openTab(t); };
  return (
    <div data-app-drag className="flex h-10 shrink-0 items-end gap-0.5 border-b border-line bg-canvas px-2">
      {tabs.map((t) => {
        const Icon = tabIcon(t);
        const active = t.id === activeTab;
        return (
          <div key={t.id} role="tab" aria-selected={active} onClick={() => setActive(t.id)}
            className={cn("group relative flex h-8 max-w-[200px] cursor-default items-center gap-1.5 rounded-t-md px-2.5 text-[12.5px]",
              active ? "bg-surface text-ink shadow-[0_0_0_1px_var(--line)] [clip-path:inset(-2px_-2px_0_-2px)]" : "text-ink-2 hover:bg-hover")}>
            <Icon className={cn("size-3.5", t.kind === "chat" ? "text-brand" : "text-ink-3")} />
            <span className="truncate">{tabTitle(t)}</span>
            <button type="button" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }} aria-label="Close tab"
              className="ml-0.5 rounded-sm p-0.5 text-ink-3 opacity-0 hover:bg-hover-2 hover:text-ink group-hover:opacity-100"><X className="size-3" /></button>
          </div>
        );
      })}
      <NewTabMenu />
      <div className="ml-auto mb-1 flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger render={<Button variant={rightPanel ? "secondary" : "ghost"} size="icon-xs" aria-label="Toggle chat panel" onClick={() => setRightPanel(rightPanel ? null : "chat")} />}><PanelRight /></TooltipTrigger>
          <TooltipContent>Chat side panel</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

/* ---------------- Shell ---------------- */
export function Workspace() {
  const { tabs, activeTab, rightPanel, setConnection } = useApp();
  const connectionId = useConnectionId();
  const { data: connections, isPending: connectionsPending } = useQuery(connectionListQuery);
  const connection = connections?.find((c) => c.id === connectionId) ?? null;
  // Opening a workspace URL directly connects too (idempotent on the server).
  useQuery({ ...connectionConnectQuery(connectionId as ConnectionId), enabled: connection !== null });

  useGlobalKeybindings();

  // Keep the store's active connection in sync with the route (tabs are scoped per connection in the store).
  useEffect(() => { setConnection(connection); return () => setConnection(null); }, [connection, setConnection]);

  // Chat tabs are opened before the thread has a title; adopt it as soon as the list refetches.
  const { data: threads } = useQuery(threadListQuery(connectionId));
  useEffect(() => {
    if (!threads) return;
    const { tabs: current, renameTab } = useApp.getState();
    for (const t of current) {
      if (t.kind !== "chat") continue;
      const server = threads.find((x) => x.id === t.threadId);
      if (server) renameTab(t.id, server.title);
    }
  }, [threads]);

  const tab = tabs.find((t) => t.id === activeTab);
  const showRight = rightPanel === "chat" && tab?.kind !== "chat";
  const isProd = connection?.env === "prod";

  if (!connection) {
    return connectionsPending
      ? <div className="flex h-full items-center justify-center text-sm text-ink-3">Connecting…</div>
      : <ConnectionNotFound connectionId={connectionId} />;
  }

  return (
    <div className={cn("flex h-full", isProd && "border-t-2 border-danger")} data-env={connection.env}>
      <ProdConfirmDialog connection={connection} />
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TabStrip />
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          <ResizablePanel defaultSize={showRight ? 62 : 100} minSize={30} className="bg-surface">
            <Outlet />
          </ResizablePanel>
          {showRight && (
            <>
              <ResizableHandle />
              <ResizablePanel defaultSize={38} minSize={24} className="flex min-h-0 flex-col bg-canvas">
                <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3 text-xs">
                  <MessageSquare className="size-3.5 text-brand" />
                  <span className="font-medium">Chat</span>
                  <span className="text-ink-3">· context: {tab?.kind === "table" ? `${tab.schema}.${tab.table}` : "editor"}</span>
                </div>
                <div className="min-h-0 flex-1"><ChatView compact /></div>
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
