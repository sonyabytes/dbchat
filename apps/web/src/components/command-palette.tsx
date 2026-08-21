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
import { useMemo } from "react";

import { useSchemaRefresh } from "@/components/schema/schema-tree";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { DialectIcon, EnvBadge } from "@/components/shared/primitives";
import { useConnectionId, useOpenTab } from "@/lib/nav";
import { usePalette } from "@/lib/palette";
import { toggleTheme } from "@/lib/settings";
import { tabIds, useApp } from "@/lib/store";
import { threadListQuery } from "@/rpc/chat";
import { connectionListQuery, schemaListQuery } from "@/rpc/queries";
import { savedQueriesQuery } from "@/rpc/sql";

/** Big schemas would choke cmdk's list; the search still reaches everything below this. */
const MAX_TABLES = 400;

const compact = (n: number) => Intl.NumberFormat("en", { notation: "compact" }).format(n);
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
        .flatMap((s) => s.tables.map((t) => ({ schema: t.schema || s.name, name: t.name, rows: t.rowEstimate })))
        .slice(0, MAX_TABLES),
    [schemas],
  );

  const run = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={(o) => setOpen(o)}
      title={tablesOnly ? "Open table" : "Command palette"}
      description={tablesOnly ? "Pick a table to open in a new tab" : "Jump to a table, chat, query or connection"}
      className="sm:max-w-xl"
    >
      <Command loop className="bg-transparent p-0">
      <CommandInput placeholder={tablesOnly ? "Search tables…" : "Search tables, chats, queries, actions…"} autoFocus />
      <CommandList className="max-h-[420px]">
        <CommandEmpty>No matches.</CommandEmpty>

        {inWorkspace && tables.length > 0 && (
          <CommandGroup heading="Tables">
            {tables.map((t) => (
              <CommandItem
                key={`${t.schema}.${t.name}`}
                value={`table ${t.schema}.${t.name}`}
                onSelect={() =>
                  run(() => openTab({ id: tabIds.table(t.schema, t.name), kind: "table", schema: t.schema, table: t.name }))
                }
              >
                <Table2 className="text-ink-3" />
                <span className="min-w-0 flex-1 truncate font-mono">
                  <span className="text-ink-3">{t.schema}.</span>
                  {t.name}
                </span>
                {t.rows > 0 && (
                  <span className="shrink-0 font-mono text-[10px] text-ink-3">{compact(t.rows)} rows</span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {inWorkspace && !tablesOnly && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Chats">
              <CommandItem
                value="new chat"
                onSelect={() =>
                  run(() => {
                    const threadId = newId("new");
                    openTab({ id: tabIds.chat(threadId), kind: "chat", threadId, title: "New chat" });
                  })
                }
              >
                <Plus className="text-ink-3" />
                New chat
                <CommandShortcut>⌘N</CommandShortcut>
              </CommandItem>
              {(threads ?? []).map((t) => (
                <CommandItem
                  key={t.id}
                  value={`chat ${t.title}`}
                  onSelect={() => run(() => openTab({ id: tabIds.chat(t.id), kind: "chat", threadId: t.id, title: t.title }))}
                >
                  <MessageSquare className="text-brand" />
                  <span className="truncate">{t.title}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {inWorkspace && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Queries">
              <CommandItem
                value="new sql query"
                onSelect={() =>
                  run(() => {
                    const queryId = newId("draft");
                    openTab({ id: tabIds.sql(queryId), kind: "sql", queryId, title: "untitled.sql" });
                  })
                }
              >
                <Plus className="text-ink-3" />
                New SQL
                <CommandShortcut>⌘T</CommandShortcut>
              </CommandItem>
              {(saved ?? []).map((s) => (
                <CommandItem
                  key={s.id}
                  value={`query ${s.name}`}
                  onSelect={() =>
                    run(() => openTab({ id: tabIds.sql(s.id), kind: "sql", queryId: s.id, title: `${s.name}.sql` }))
                  }
                >
                  <TerminalSquare className="text-ink-3" />
                  <span className="truncate">{s.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {!tablesOnly && (<>
        {inWorkspace && <CommandSeparator />}
        <CommandGroup heading="Connections">
          {(connections ?? []).length === 0 && (
            <CommandItem value="no connections" disabled>
              <Database className="text-ink-3" />
              No connections yet
            </CommandItem>
          )}
          {(connections ?? []).map((c) => (
            <CommandItem
              key={c.id}
              value={`connection ${c.name} ${c.database} ${c.host}`}
              onSelect={() =>
                run(() =>
                  void navigate({
                    to: "/c/$connectionId/chat/$threadId",
                    params: { connectionId: c.id, threadId: "home" },
                    search: {},
                  }),
                )
              }
            >
              <DialectIcon dialect={c.dialect} className="size-4 text-[9px]" />
              <span className="truncate">{c.name}</span>
              <EnvBadge env={c.env} />
              <span className="ml-auto max-w-[45%] shrink-0 truncate font-mono text-[10px] text-ink-3">{c.database}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading="Actions">
          <CommandItem value="action toggle theme dark light appearance" onSelect={() => run(toggleTheme)}>
            {dark ? <Sun className="text-ink-3" /> : <Moon className="text-ink-3" />}
            Toggle theme
          </CommandItem>
          {inWorkspace && (
            <CommandItem
              value="action toggle chat panel side"
              onSelect={() => run(() => setRightPanel(rightPanel ? null : "chat"))}
            >
              <PanelRight className="text-ink-3" />
              Toggle chat panel
              <CommandShortcut>⌘J</CommandShortcut>
            </CommandItem>
          )}
          {inWorkspace && (
            <CommandItem value="action refresh schema introspection" onSelect={() => run(refresh)}>
              <RefreshCw className="text-ink-3" />
              Refresh schema
            </CommandItem>
          )}
          <CommandItem value="action settings preferences" onSelect={() => run(() => void navigate({ to: "/settings" }))}>
            <SettingsIcon className="text-ink-3" />
            Settings
            <CommandShortcut>⌘,</CommandShortcut>
          </CommandItem>
        </CommandGroup>
        </>)}
      </CommandList>
      </Command>
    </CommandDialog>
  );
}
