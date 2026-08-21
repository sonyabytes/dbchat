/**
 * Sidebar schema explorer.
 *
 * `schema.list` gives schemas + tables (with row estimates) up front; a table's
 * columns are fetched lazily with `schema.table` the first time it is expanded.
 * The search box filters table names always, and column names for any table whose
 * detail is cached — plus, for expanded schemas, it warms a bounded number of
 * details (50) so column search is useful without introspecting the whole database.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConnectionId, TableDetail, TableMeta } from "@dbchat/contracts";
import { ChevronDown, ChevronRight, Database, Key, Link2, Table2 } from "lucide-react";

import { CountBadge, TypePill } from "@/components/shared/primitives";
import { Skeleton } from "@/components/ui/skeleton";
import { useOpenTab } from "@/lib/nav";
import { tabIds, useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { refreshSchema, schemaListQuery, schemaTableQuery } from "@/rpc/queries";

const COLUMN_SEARCH_LIMIT = 50;
const key = (t: TableMeta) => `${t.schema}.${t.name}`;

/** Refresh introspection on the server, then drop every cached schema query. */
export function useSchemaRefresh(connectionId: string) {
  const queryClient = useQueryClient();
  const [isRefreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      await refreshSchema(connectionId as ConnectionId);
      await queryClient.invalidateQueries({ queryKey: ["schema.list", connectionId] });
      await queryClient.invalidateQueries({ queryKey: ["schema.table", connectionId] });
    } finally {
      setRefreshing(false);
    }
  };
  return { refresh: () => void refresh(), isRefreshing };
}

/** Column names of `table` that match `needle`, for details already in the cache. */
function useColumnMatches(connectionId: string, tables: TableMeta[], needle: string) {
  const queryClient = useQueryClient();
  const [tick, setTick] = useState(0);
  const warmed = useRef(new Set<string>());

  useEffect(() => {
    if (needle.length < 2) return;
    const timer = setTimeout(() => {
      const todo = tables.filter((t) => !warmed.current.has(key(t))).slice(0, COLUMN_SEARCH_LIMIT);
      if (todo.length === 0) return;
      for (const t of todo) warmed.current.add(key(t));
      void Promise.all(
        todo.map((t) =>
          queryClient.ensureQueryData(schemaTableQuery(connectionId as ConnectionId, t.schema, t.name)).catch(() => null),
        ),
      ).then(() => setTick((n) => n + 1));
    }, 300);
    return () => clearTimeout(timer);
  }, [needle, connectionId, tables, queryClient]);

  return useMemo(() => {
    const out = new Map<string, string[]>();
    if (needle.length < 1) return out;
    for (const t of tables) {
      const detail = queryClient.getQueryData<TableDetail>(["schema.table", connectionId, t.schema, t.name]);
      if (!detail) continue;
      const hits = detail.columns.filter((c) => c.name.toLowerCase().includes(needle)).map((c) => c.name);
      if (hits.length > 0) out.set(key(t), hits);
    }
    return out;
    // `tick` re-runs this after a warm-up batch resolves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needle, tables, connectionId, queryClient, tick]);
}

function ColumnList({ connectionId, table, highlight }: { connectionId: string; table: TableMeta; highlight: Set<string> }) {
  const { data, isPending, error } = useQuery(schemaTableQuery(connectionId as ConnectionId, table.schema, table.name));
  if (isPending) {
    return (
      <div className="ml-7 space-y-1 border-l border-line py-1 pl-2.5">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-3 w-32" />)}
      </div>
    );
  }
  if (error || !data) {
    return <div className="ml-7 border-l border-line py-1 pl-2.5 text-[11px] text-danger">Could not load columns</div>;
  }
  return (
    <div className="ml-7 border-l border-line">
      {data.columns.map((c) => (
        <div
          key={c.name}
          className={cn(
            "flex h-6 items-center gap-1.5 pl-2.5 pr-2 text-xs text-ink-2",
            highlight.has(c.name) && "rounded-sm bg-brand-tint text-brand-ink",
          )}
        >
          <span className="w-3">
            {c.isPrimaryKey ? <Key className="size-2.5 text-warning" /> : c.foreignKey ? <Link2 className="size-2.5 text-brand" /> : null}
          </span>
          <span className="truncate font-mono">{c.name}</span>
          <span className="ml-auto max-w-[52%] shrink-0 truncate" title={c.type}><TypePill type={c.type} /></span>
        </div>
      ))}
    </div>
  );
}

export function SchemaTree({
  connectionId,
  filter,
  onOpenTable,
}: {
  connectionId: string;
  filter: string;
  onOpenTable?: (table: TableMeta) => void;
}) {
  const activeTab = useApp((s) => s.activeTab);
  const openTab = useOpenTab();
  const { data: schemas, isPending, error, refetch } = useQuery(schemaListQuery(connectionId as ConnectionId));
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [openTables, setOpenTables] = useState<Record<string, boolean>>({});

  const needle = filter.trim().toLowerCase();
  const allTables = useMemo(() => (schemas ?? []).flatMap((s) => s.tables as TableMeta[]), [schemas]);
  const columnMatches = useColumnMatches(connectionId, allTables, needle);

  const groups = useMemo(() => {
    return (schemas ?? [])
      .map((s) => ({
        name: s.name,
        tables: (s.tables as TableMeta[]).filter(
          (t) => !needle || t.name.toLowerCase().includes(needle) || columnMatches.has(key(t)),
        ),
        total: s.tables.length,
      }))
      .filter((s) => s.tables.length > 0);
  }, [schemas, needle, columnMatches]);

  if (isPending) {
    return (
      <div className="space-y-1.5 px-1.5 py-2">
        {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className={cn("h-4", i % 3 === 0 ? "w-24" : "w-36")} />)}
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-2 py-6 text-center text-xs text-ink-3">
        Could not read the schema.{" "}
        <button type="button" className="text-brand hover:underline" onClick={() => void refetch()}>Retry</button>
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="px-2 py-6 text-center text-xs text-ink-3">
        {needle ? (
          <>Nothing matches “{filter}”.</>
        ) : (
          <>
            <p>No tables in this database yet.</p>
            <button type="button" className="mt-1 text-brand hover:underline" onClick={() => void refetch()}>
              Re-introspect
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {groups.map((schema) => {
        const isOpen = !collapsed[schema.name];
        return (
          <div key={schema.name}>
            <button
              type="button"
              onClick={() => setCollapsed((s) => ({ ...s, [schema.name]: isOpen }))}
              className="flex h-6 w-full items-center gap-1 rounded-sm px-1.5 text-[11.5px] text-ink-2 hover:bg-hover"
            >
              {isOpen ? <ChevronDown className="size-3 text-ink-3" /> : <ChevronRight className="size-3 text-ink-3" />}
              <Database className="size-3 text-ink-3" /> <span className="font-mono">{schema.name}</span>
              <span className="ml-auto font-mono text-[10px] text-ink-3">{schema.tables.length}</span>
            </button>
            {isOpen && schema.tables.map((t) => {
              const id = tabIds.table(t.schema, t.name);
              const k = key(t);
              const hits = columnMatches.get(k);
              const expanded = openTables[k] || (needle.length > 0 && Boolean(hits));
              return (
                <div key={k}>
                  <div className={cn("group flex h-7 items-center gap-1 rounded-sm pl-4 pr-1.5 text-[13px] hover:bg-hover", activeTab === id && "bg-sidebar-accent font-medium")}>
                    <button
                      type="button"
                      aria-label={expanded ? `Collapse ${t.name}` : `Expand ${t.name}`}
                      className="shrink-0 text-ink-3"
                      onClick={() => setOpenTables((s) => ({ ...s, [k]: !expanded }))}
                    >
                      {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                    </button>
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-1.5"
                      onClick={() => onOpenTable
                        ? onOpenTable(t)
                        : openTab({ id, kind: "table", schema: t.schema, table: t.name })}
                    >
                      <Table2 className="size-3.5 shrink-0 text-ink-3" />
                      <span className="truncate">{t.name}</span>
                      <span className="ml-auto opacity-60 group-hover:opacity-100"><CountBadge n={t.rowEstimate} /></span>
                    </button>
                  </div>
                  {expanded && <ColumnList connectionId={connectionId} table={t} highlight={new Set(hits ?? [])} />}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
