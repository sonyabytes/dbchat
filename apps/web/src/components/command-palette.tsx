/**
 * ⌘K command palette.
 *
 * Mounted once in the root route so it is available everywhere. Inside a
 * connection workspace it lists tables / chats / saved queries / connections /
 * actions; on the connections screen only the sections that make sense there
 * (connections + theme + settings) are rendered.
 */
import type { ConnectionId } from "@dbchat/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Database,
  MessageSquare,
  Moon,
  PanelRight,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
  Sun,
  Table2,
  TerminalSquare,
} from "lucide-react";
import { useCallback, useMemo } from "react";

import { useSchemaRefresh } from "@/components/schema/schema-tree";
import { VirtualCommand, type VirtualCommandSection } from "@/components/shared/virtual-command";
import { CommandDialog, CommandShortcut } from "@/components/ui/command";
import { DialectIcon, EnvBadge } from "@/components/shared/primitives";
import { useConnectionId, useOpenTab } from "@/lib/nav";
import { usePalette } from "@/lib/palette";
import { toggleTheme } from "@/lib/settings";
import { tabIds, useApp } from "@/lib/store";
import { threadListQuery } from "@/rpc/chat";
import { connectionListQuery, schemaListQuery } from "@/rpc/queries";
import { savedQueriesQuery } from "@/rpc/sql";

const compactFormatter = Intl.NumberFormat("en", { notation: "compact" });
const compact = (n: number) => compactFormatter.format(n);
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}`;

export function CommandPalette() {
  const open = usePalette((s) => s.open);
  const setOpen = usePalette((s) => s.setOpen);
  const mode = usePalette((s) => s.mode);
  const tablesOnly = mode === "tables";
  const connectionId = useConnectionId();
  const inWorkspace = connectionId !== "";
  const navigate = useNavigate();
  const openTab = useOpenTab();
  const dark = useApp((s) => s.dark);
  const rightPanel = useApp((s) => s.rightPanel);
  const setRightPanel = useApp((s) => s.setRightPanel);
  const { refresh } = useSchemaRefresh(connectionId);

  const { data: connections } = useQuery(connectionListQuery);
  const { data: schemas } = useQuery({
    ...schemaListQuery(connectionId as ConnectionId),
    enabled: open && inWorkspace,
  });
  const { data: threads } = useQuery({ ...threadListQuery(connectionId), enabled: open && inWorkspace });
  const { data: saved } = useQuery({ ...savedQueriesQuery(connectionId), enabled: open && inWorkspace });

  const tables = useMemo(
    () =>
      (schemas ?? [])
        .flatMap((s) => s.tables.map((t) => ({ schema: t.schema || s.name, name: t.name, rows: t.rowEstimate }))),
    [schemas],
  );

  const run = useCallback((fn: () => void) => {
    setOpen(false);
    fn();
  }, [setOpen]);

  const sections = useMemo<VirtualCommandSection[]>(() => {
    const result: VirtualCommandSection[] = [];

    if (inWorkspace && tables.length > 0) {
      result.push({
        id: "tables",
        heading: "Tables",
        items: tables.map((t) => ({
          id: `table:${t.schema}.${t.name}`,
          search: `table ${t.schema}.${t.name}`,
          onSelect: () => run(() => openTab({ id: tabIds.table(t.schema, t.name), kind: "table", schema: t.schema, table: t.name })),
          render: () => (
            <>
              <Table2 className="text-ink-3" />
              <span className="min-w-0 flex-1 truncate font-mono">
                <span className="text-ink-3">{t.schema}.</span>
                {t.name}
              </span>
              {t.rows > 0 && <span className="shrink-0 font-mono text-[10px] text-ink-3">{compact(t.rows)} rows</span>}
            </>
          ),
        })),
      });
    }

    if (inWorkspace && !tablesOnly) {
      result.push({
        id: "chats",
        heading: "Chats",
        items: [
          {
            id: "chat:new",
            search: "new chat",
            onSelect: () => run(() => {
              const threadId = newId("new");
              openTab({ id: tabIds.chat(threadId), kind: "chat", threadId, title: "New chat" });
            }),
            render: () => <><Plus className="text-ink-3" />New chat<CommandShortcut>⌘N</CommandShortcut></>,
          },
          ...(threads ?? []).map((t) => ({
            id: `chat:${t.id}`,
            search: `chat ${t.title}`,
            onSelect: () => run(() => openTab({ id: tabIds.chat(t.id), kind: "chat", threadId: t.id, title: t.title })),
            render: () => <><MessageSquare className="text-brand" /><span className="truncate">{t.title}</span></>,
          })),
        ],
      });
    }

    if (inWorkspace && !tablesOnly) {
      result.push({
        id: "queries",
        heading: "Queries",
        items: [
          {
            id: "query:new",
            search: "new sql query",
            onSelect: () => run(() => {
              const queryId = newId("draft");
              openTab({ id: tabIds.sql(queryId), kind: "sql", queryId, title: "untitled.sql" });
            }),
            render: () => <><Plus className="text-ink-3" />New SQL<CommandShortcut>⌘T</CommandShortcut></>,
          },
          ...(saved ?? []).map((s) => ({
            id: `query:${s.id}`,
            search: `query ${s.name}`,
            onSelect: () => run(() => openTab({ id: tabIds.sql(s.id), kind: "sql", queryId: s.id, title: `${s.name}.sql` })),
            render: () => <><TerminalSquare className="text-ink-3" /><span className="truncate">{s.name}</span></>,
          })),
        ],
      });
    }

    if (!tablesOnly) {
      result.push({
        id: "connections",
        heading: "Connections",
        items: (connections ?? []).length === 0
          ? [{
              id: "connection:none",
              search: "no connections",
              onSelect: () => undefined,
              disabled: true,
              render: () => <><Database className="text-ink-3" />No connections yet</>,
            }]
          : (connections ?? []).map((c) => ({
              id: `connection:${c.id}`,
              search: `connection ${c.name} ${c.database} ${c.host}`,
              onSelect: () => run(() => void navigate({
                to: "/c/$connectionId/chat/$threadId",
                params: { connectionId: c.id, threadId: "home" },
                search: {},
              })),
              render: () => (
                <>
                  <DialectIcon dialect={c.dialect} className="size-4 text-[9px]" />
                  <span className="truncate">{c.name}</span>
                  <EnvBadge env={c.env} />
                  <span className="ml-auto max-w-[45%] shrink-0 truncate font-mono text-[10px] text-ink-3">{c.database}</span>
                </>
              ),
            })),
      });

      result.push({
        id: "actions",
        heading: "Actions",
        items: [
          {
            id: "action:theme",
            search: "action toggle theme dark light appearance",
            onSelect: () => run(toggleTheme),
            render: () => <>{dark ? <Sun className="text-ink-3" /> : <Moon className="text-ink-3" />}Toggle theme</>,
          },
          ...(inWorkspace ? [
            {
              id: "action:panel",
              search: "action toggle chat panel side",
              onSelect: () => run(() => setRightPanel(rightPanel ? null : "chat")),
              render: () => <><PanelRight className="text-ink-3" />Toggle chat panel<CommandShortcut>⌘J</CommandShortcut></>,
            },
            {
              id: "action:refresh",
              search: "action refresh schema introspection",
              onSelect: () => run(refresh),
              render: () => <><RefreshCw className="text-ink-3" />Refresh schema</>,
            },
          ] : []),
          {
            id: "action:settings",
            search: "action settings preferences",
            onSelect: () => run(() => void navigate({ to: "/settings" })),
            render: () => <><SettingsIcon className="text-ink-3" />Settings<CommandShortcut>⌘,</CommandShortcut></>,
          },
        ],
      });
    }

    return result;
  }, [connections, dark, inWorkspace, navigate, openTab, refresh, rightPanel, run, saved, setRightPanel, tables, tablesOnly, threads]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={(o) => setOpen(o)}
      title={tablesOnly ? "Open table" : "Command palette"}
      description={tablesOnly ? "Pick a table to open in a new tab" : "Jump to a table, chat, query or connection"}
      className="sm:max-w-xl"
    >
      <VirtualCommand
        sections={sections}
        placeholder={tablesOnly ? "Search tables…" : "Search tables, chats, queries, actions…"}
      />
    </CommandDialog>
  );
}
