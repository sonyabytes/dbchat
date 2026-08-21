import type { Connection, TableMeta } from "@dbchat/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Database, ExternalLink, RefreshCw, TerminalSquare } from "lucide-react";
import { useState } from "react";

import { SchemaTree, useSchemaRefresh } from "@/components/schema/schema-tree";
import { DialectIcon, EnvBadge } from "@/components/shared/primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { tabIds, tabPath, type Tab, useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { connectionListQuery } from "@/rpc/queries";

const draftQuery = (): Tab => {
  const queryId = `draft-${Date.now().toString(36)}`;
  return { id: tabIds.sql(queryId), kind: "sql", queryId, title: "untitled.sql" };
};

function useDatabaseNavigation() {
  const navigate = useNavigate();
  const openTab = useApp((state) => state.openTab);

  const openDatabaseTab = (connectionId: string, tab: Tab) => {
    openTab(tab, connectionId);
    void navigate({ to: tabPath(connectionId, tab) });
  };
  const browse = (connectionId: string) => {
    void navigate({ to: "/c/$connectionId", params: { connectionId } });
  };
  return { browse, openDatabaseTab };
}

function DatabaseSection({
  connection,
  filter,
  initiallyOpen,
  onOpenTable,
  onOpenSql,
}: {
  connection: Connection;
  filter: string;
  initiallyOpen: boolean;
  onOpenTable?: (connection: Connection, table: TableMeta) => void;
  onOpenSql?: (connection: Connection) => void;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const { browse, openDatabaseTab } = useDatabaseNavigation();
  const { refresh, isRefreshing } = useSchemaRefresh(connection.id);
  const searchActive = filter.trim().length > 0;
  const expanded = open || searchActive;
  const openTable = (table: TableMeta) => {
    if (onOpenTable) {
      onOpenTable(connection, table);
      return;
    }
    openDatabaseTab(connection.id, {
      id: tabIds.table(table.schema, table.name),
      kind: "table",
      schema: table.schema,
      table: table.name,
    });
  };

  return (
    <Collapsible open={expanded} onOpenChange={setOpen} className="rounded-md border border-line bg-canvas">
      <div className="flex h-9 items-center gap-0.5 px-1">
        <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start" />}>
          {expanded ? <ChevronDown data-icon="inline-start" /> : <ChevronRight data-icon="inline-start" />}
          <DialectIcon dialect={connection.dialect} />
          <span className="truncate">{connection.name}</span>
          <EnvBadge env={connection.env} />
        </CollapsibleTrigger>
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`Refresh ${connection.name} schema`} onClick={refresh} />}>
            <RefreshCw className={cn(isRefreshing && "animate-spin")} />
          </TooltipTrigger>
          <TooltipContent>Refresh schema</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`New SQL query for ${connection.name}`} onClick={() => onOpenSql ? onOpenSql(connection) : openDatabaseTab(connection.id, draftQuery())} />}>
            <TerminalSquare />
          </TooltipTrigger>
          <TooltipContent>New SQL query</TooltipContent>
        </Tooltip>
        {!onOpenTable ? (
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`Open ${connection.name} workspace`} onClick={() => browse(connection.id)} />}>
              <ExternalLink />
            </TooltipTrigger>
            <TooltipContent>Open database workspace</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <CollapsibleContent className="border-t border-line px-1 py-1">
        <SchemaTree connectionId={connection.id} filter={filter} onOpenTable={openTable} />
      </CollapsibleContent>
    </Collapsible>
  );
}

export function HomeDataBrowser({
  filter,
  onOpenTable,
  onOpenSql,
}: {
  filter: string;
  onOpenTable?: (connection: Connection, table: TableMeta) => void;
  onOpenSql?: (connection: Connection) => void;
}) {
  const { data: connections = [] } = useQuery(connectionListQuery);

  if (connections.length === 0) {
    return (
      <Empty className="h-full px-3">
        <EmptyHeader>
          <EmptyMedia variant="icon"><Database /></EmptyMedia>
          <EmptyTitle>No databases connected</EmptyTitle>
          <EmptyDescription>Use Sources above to connect databases, then browse any of them here.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-1.5">
      <div className="flex h-7 items-center gap-1.5 px-1 text-xs font-medium">
        <Database className="size-3.5 text-brand" />
        <span>Databases</span>
        <Badge variant="secondary">{connections.length}</Badge>
        <span className="ml-auto text-[10px] font-normal text-muted-foreground">expand multiple</span>
      </div>
      {connections.map((connection, index) => (
        <DatabaseSection
          key={connection.id}
          connection={connection}
          filter={filter}
          initiallyOpen={index === 0}
          onOpenTable={onOpenTable}
          onOpenSql={onOpenSql}
        />
      ))}
    </div>
  );
}
