import type { Connection, TableMeta } from "@dbchat/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { Check, ChevronDown, Database, Maximize2, Minimize2, PanelsTopLeft, Search, Table2, TerminalSquare, X } from "lucide-react";

import { HomeDataBrowser } from "@/components/data/home-data-browser";
import { TableView } from "@/components/screens/table-view";
import { DialectIcon, EnvBadge } from "@/components/shared/primitives";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { dataTabIds, type DataTab, useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { connectionListQuery } from "@/rpc/queries";

const SqlEditor = lazy(() => import("@/components/screens/sql-editor").then((module) => ({ default: module.SqlEditor })));
const EMPTY_DATA_TABS: DataTab[] = [];

const dataTabTitle = (tab: DataTab) => tab.kind === "table" ? tab.table : tab.title;
const draftQueryId = () => `draft-${Date.now().toString(36)}`;

export function WorkItemDataPane({ workItemId }: { workItemId: string }) {
  const navigate = useNavigate();
  const workspace = useApp((state) => state.dataWorkspaces[workItemId]);
  const tabs = workspace?.tabs ?? EMPTY_DATA_TABS;
  const activeTabId = workspace?.activeTab ?? null;
  const filter = workspace?.explorerFilter ?? "";
  const focused = workspace?.focused ?? false;
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const openDataTab = useApp((state) => state.openDataTab);
  const closeDataTab = useApp((state) => state.closeDataTab);
  const setActiveDataTab = useApp((state) => state.setActiveDataTab);
  const setDataExplorerFilter = useApp((state) => state.setDataExplorerFilter);
  const setDataWorkspaceFocused = useApp((state) => state.setDataWorkspaceFocused);
  const { data: connections = [] } = useQuery(connectionListQuery);

  const openTable = (connection: Connection, table: TableMeta) => {
    openDataTab(workItemId, {
      id: dataTabIds.table(connection.id, table.schema, table.name),
      kind: "table",
      connectionId: connection.id,
      schema: table.schema,
      table: table.name,
    });
  };

  const openSql = (connection: Connection, initialSql?: string) => {
    const queryId = draftQueryId();
    openDataTab(workItemId, {
      id: dataTabIds.sql(connection.id, queryId),
      kind: "sql",
      connectionId: connection.id,
      queryId,
      title: "untitled.sql",
      ...(initialSql ? { initialSql } : {}),
    });
  };

  const askChat = (search: { context?: string; sql?: string }) => {
    void navigate({
      to: "/chat/$threadId",
      params: { threadId: workItemId },
      search,
    });
  };

  const replaceWithSavedQuery = (tab: Extract<DataTab, { kind: "sql" }>, queryId: string, title: string) => {
    openDataTab(workItemId, {
      id: dataTabIds.sql(tab.connectionId, queryId),
      kind: "sql",
      connectionId: tab.connectionId,
      queryId,
      title,
    });
    if (tab.queryId.startsWith("draft-") || tab.queryId === "new") closeDataTab(workItemId, tab.id);
  };

  return (
    <section aria-label="Data workspace" className="@container flex h-full min-h-0 flex-col bg-canvas">
      <div className="flex h-10 min-w-0 shrink-0 items-end gap-0.5 overflow-hidden border-b border-line px-2">
        <div role="tablist" aria-label="Open data windows" className="flex min-w-0 flex-1 items-end gap-0.5 overflow-hidden">
          <button
            type="button"
            role="tab"
            aria-selected={activeTabId === null}
            onClick={() => setActiveDataTab(workItemId, null)}
            className={cn(
              "mb-1 flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs",
              activeTabId === null ? "bg-surface text-ink shadow-hairline" : "text-ink-2 hover:bg-hover",
            )}
          >
            <Database className="size-3.5" />
            Explorer
          </button>
          {tabs.map((tab) => {
            const selected = tab.id === activeTabId;
            const Icon = tab.kind === "table" ? Table2 : TerminalSquare;
            const connection = connections.find((candidate) => candidate.id === tab.connectionId);
            return (
              <div
                key={tab.id}
                className={cn(
                  "group mb-1 h-7 min-w-0 flex-1 basis-28 cursor-default items-center gap-1.5 rounded-md px-2 text-xs",
                  selected
                    ? "flex bg-surface text-ink shadow-hairline"
                    : "hidden text-ink-2 hover:bg-hover @3xl:flex",
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setActiveDataTab(workItemId, tab.id)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                >
                  <Icon className="size-3.5 shrink-0 text-ink-3" />
                  <span className="truncate">{dataTabTitle(tab)}</span>
                  {connection ? <span className="truncate text-[10px] text-ink-3">{connection.name}</span> : null}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${dataTabTitle(tab)}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeDataTab(workItemId, tab.id);
                  }}
                  className="ml-auto rounded-sm p-0.5 text-ink-3 opacity-0 hover:bg-hover-2 hover:text-ink group-hover:opacity-100"
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="xs" className="mb-1 shrink-0" disabled={connections.length === 0 && tabs.length === 0} />}>
            <PanelsTopLeft data-icon="inline-start" /> Windows <ChevronDown data-icon="inline-end" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            {tabs.length > 0 ? (
              <>
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Open windows</DropdownMenuLabel>
                  {tabs.map((tab) => {
                    const Icon = tab.kind === "table" ? Table2 : TerminalSquare;
                    const connection = connections.find((candidate) => candidate.id === tab.connectionId);
                    return (
                      <DropdownMenuItem key={tab.id} onClick={() => setActiveDataTab(workItemId, tab.id)}>
                        <Icon />
                        <span className="min-w-0 flex-1 truncate">{dataTabTitle(tab)}</span>
                        {connection ? <span className="max-w-20 truncate text-[10px] text-ink-3">{connection.name}</span> : null}
                        {tab.id === activeTabId ? <Check className="text-brand" /> : null}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuGroup>
                {connections.length > 0 ? <DropdownMenuSeparator /> : null}
              </>
            ) : null}
            {connections.length > 0 ? (
              <DropdownMenuGroup>
                <DropdownMenuLabel>New SQL editor</DropdownMenuLabel>
                {connections.map((connection) => (
                  <DropdownMenuItem key={connection.id} onClick={() => openSql(connection)}>
                    <DialectIcon dialect={connection.dialect} />
                    <span className="min-w-0 flex-1 truncate">{connection.name}</span>
                    <EnvBadge env={connection.env} />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={(
              <Button
                variant={focused ? "secondary" : "ghost"}
                size="icon-sm"
                className="mb-1"
                aria-label={focused ? "Return to split view" : "Focus data workspace"}
                onClick={() => setDataWorkspaceFocused(workItemId, !focused)}
              />
            )}
          >
            {focused ? <Minimize2 /> : <Maximize2 />}
          </TooltipTrigger>
          <TooltipContent>{focused ? "Return to conversation and data" : "Use the full workspace for data"}</TooltipContent>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 bg-surface">
        {!activeTab ? (
          <div className="flex h-full min-h-0 flex-col bg-canvas p-3">
            <div className="mb-3 flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={filter}
                  onChange={(event) => setDataExplorerFilter(workItemId, event.target.value)}
                  placeholder="Find a table or column"
                  className="h-8 bg-field pl-7 text-xs"
                />
              </div>
              <span className="hidden shrink-0 text-[11px] text-muted-foreground @2xl:inline">Open tables and SQL beside this conversation</span>
            </div>
            <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
              <HomeDataBrowser filter={filter} onOpenTable={openTable} onOpenSql={openSql} />
            </div>
          </div>
        ) : activeTab.kind === "table" ? (
          <TableView
            key={`${workItemId}:${activeTab.id}`}
            connectionId={activeTab.connectionId}
            schema={activeTab.schema}
            table={activeTab.table}
            onAskAboutTable={(context) => askChat({ context })}
          />
        ) : (
          <Suspense fallback={<Skeleton className="m-3 h-[calc(100%-1.5rem)]" />}>
            <SqlEditor
              key={`${workItemId}:${activeTab.id}`}
              connectionId={activeTab.connectionId}
              queryId={activeTab.queryId}
              initialSql={activeTab.initialSql}
              onOpenChat={(sql) => askChat({ sql })}
              onOpenQuery={(queryId, title) => replaceWithSavedQuery(activeTab, queryId, title)}
            />
          </Suspense>
        )}
      </div>
    </section>
  );
}
