/**
 * Table browser: server-paged data grid + structure tab.
 *
 * Data comes from `table.rows` (offset paging, 100 rows/page, server-side sort and
 * filters) and `schema.table` (columns / PK / FK / indexes, and the row estimate
 * used before the first page reports a total).
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Braces, Columns3, Copy, Download, Filter, Key, Link2, Plus, RefreshCw, Search, Sparkles, Trash2, X } from "lucide-react";
import type { ColumnMeta, ConnectionId, Dialect, FilterOp, FilterSpec, SortSpec } from "@dbchat/contracts";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataGrid, type GridRecord } from "@/components/shared/data-grid";
import { CountBadge, TypePill } from "@/components/shared/primitives";
import { useOpenTab } from "@/lib/nav";
import { useSettings } from "@/lib/settings";
import { tabIds, useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { tableRowsQuery } from "@/rpc/table";
import { connectionListQuery, rpcErrorMessage, rpcErrorTag, schemaTableQuery } from "@/rpc/queries";

const NO_COLUMNS: ReadonlyArray<ColumnMeta> = [];

/* ---------------- SQL / CSV helpers ---------------- */

function quoteIdent(name: string, dialect: Dialect): string {
  return dialect === "mysql" || dialect === "bigquery"
    ? `\`${name.replace(/`/g, "``")}\``
    : `"${name.replace(/"/g, '""')}"`;
}

function quoteLiteral(v: unknown, dialect: Dialect): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return dialect === "sqlite" ? (v ? "1" : "0") : v ? "TRUE" : "FALSE";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  const escaped = dialect === "mysql" ? s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") : s.replace(/'/g, "''");
  return `'${escaped}'`;
}

function toInsert(rows: GridRecord[], columns: string[], schema: string, table: string, dialect: Dialect): string {
  const target = `${quoteIdent(schema, dialect)}.${quoteIdent(table, dialect)}`;
  const cols = columns.map((c) => quoteIdent(c, dialect)).join(", ");
  return rows
    .map((r) => `INSERT INTO ${target} (${cols}) VALUES (${columns.map((c) => quoteLiteral(r[c], dialect)).join(", ")});`)
    .join("\n");
}

function toCsv(rows: GridRecord[], columns: string[]): string {
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\n");
}

function download(filename: string, content: string, mime = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------------- Where builder ---------------- */

const OPS: Array<{ op: FilterOp; label: string; valueless?: boolean; postgresOnly?: boolean }> = [
  { op: "eq", label: "=" },
  { op: "neq", label: "≠" },
  { op: "gt", label: ">" },
  { op: "gte", label: "≥" },
  { op: "lt", label: "<" },
  { op: "lte", label: "≤" },
  { op: "like", label: "LIKE" },
  { op: "ilike", label: "ILIKE", postgresOnly: true },
  { op: "in", label: "IN" },
  { op: "is_null", label: "IS NULL", valueless: true },
  { op: "is_not_null", label: "IS NOT NULL", valueless: true },
];

interface DraftFilter { column: string; op: FilterOp; value: string }

const isValueless = (op: FilterOp) => op === "is_null" || op === "is_not_null";
const numericType = (t: string) => /int|numeric|decimal|float|double|real|serial/i.test(t);
const boolType = (t: string) => /bool/i.test(t);

function coerce(raw: string, type: string): unknown {
  const s = raw.trim();
  if (boolType(type)) return s === "true" || s === "1";
  if (numericType(type) && s !== "" && !Number.isNaN(Number(s))) return Number(s);
  return raw;
}

function toFilterSpecs(drafts: DraftFilter[], columns: ReadonlyArray<ColumnMeta>): FilterSpec[] {
  return drafts
    .filter((d) => d.column && (isValueless(d.op) || d.value.trim() !== ""))
    .map((d) => {
      const type = columns.find((c) => c.name === d.column)?.type ?? "text";
      if (isValueless(d.op)) return { column: d.column, op: d.op };
      if (d.op === "in") return { column: d.column, op: d.op, value: d.value.split(",").map((v) => coerce(v, type)) };
      return { column: d.column, op: d.op, value: coerce(d.value, type) };
    });
}

function WhereBuilder({
  columns, dialect, filters, onApply,
}: {
  columns: ReadonlyArray<ColumnMeta>;
  dialect: Dialect;
  filters: FilterSpec[];
  onApply: (next: FilterSpec[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<DraftFilter[]>([]);
  const ops = OPS.filter((o) => !o.postgresOnly || dialect === "postgres");

  const seed = () =>
    filters.length > 0
      ? filters.map((f) => ({
          column: f.column,
          op: f.op,
          value: Array.isArray(f.value) ? (f.value as unknown[]).join(", ") : f.value === undefined ? "" : String(f.value),
        }))
      : [{ column: columns[0]?.name ?? "", op: "eq" as FilterOp, value: "" }];

  const set = (i: number, patch: Partial<DraftFilter>) =>
    setDrafts((d) => d.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));

  return (
    <Popover
      open={open}
      onOpenChange={(o) => { setOpen(o); if (o) setDrafts(seed()); }}
    >
      <PopoverTrigger render={<Button variant={filters.length > 0 ? "secondary" : "ghost"} size="xs" aria-label="Where — filter rows" />}>
        <Filter /> <span className="hidden @3xl:inline">Where</span>
        {filters.length > 0 && <span className="font-mono text-[10px] text-brand">{filters.length}</span>}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[460px] gap-2">
        <div className="text-[11px] font-medium text-ink-2">Filter rows on the server</div>
        <div className="flex flex-col gap-1.5">
          {drafts.map((d, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Select value={d.column} onValueChange={(v) => set(i, { column: String(v) })}>
                <SelectTrigger className="h-7 w-[38%] font-mono text-[11px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {columns.map((c) => <SelectItem key={c.name} value={c.name}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={d.op} onValueChange={(v) => set(i, { op: v as FilterOp })}>
                <SelectTrigger className="h-7 w-[26%] text-[11px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ops.map((o) => <SelectItem key={o.op} value={o.op}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <Input
                value={d.value}
                disabled={isValueless(d.op)}
                onChange={(e) => set(i, { value: e.target.value })}
                placeholder={d.op === "in" ? "a, b, c" : isValueless(d.op) ? "—" : "value"}
                className="h-7 flex-1 font-mono text-[11px]"
              />
              <Button variant="ghost" size="icon-xs" aria-label="Remove condition" onClick={() => setDrafts((rows) => rows.filter((_, idx) => idx !== i))}>
                <X />
              </Button>
            </div>
          ))}
          {drafts.length === 0 && <div className="py-1 text-[11px] text-ink-3">No conditions.</div>}
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="xs" onClick={() => setDrafts((d) => [...d, { column: columns[0]?.name ?? "", op: "eq", value: "" }])}>
            <Plus /> Add condition
          </Button>
          <Button variant="ghost" size="xs" onClick={() => { setDrafts([]); onApply([]); setOpen(false); }} disabled={filters.length === 0 && drafts.length === 0}>
            <Trash2 /> Clear
          </Button>
          <Button size="xs" className="ml-auto" onClick={() => { onApply(toFilterSpecs(drafts, columns)); setOpen(false); }}>
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ---------------- Structure tab ---------------- */

function Structure({ connectionId, schema, table }: { connectionId: string; schema: string; table: string }) {
  const { data, isPending, error } = useQuery(schemaTableQuery(connectionId as ConnectionId, schema, table));
  if (isPending) return <div className="p-4 text-xs text-ink-3">Loading structure…</div>;
  if (error || !data) return <ErrorBanner error={error} />;
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-surface p-4">
      <div className="max-w-3xl">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-medium">Columns <span className="text-ink-3">({data.columns.length})</span></div>
        </div>
        <div className="rounded-md shadow-hairline">
          {data.columns.map((c, i) => (
            <div key={c.name} className={cn("flex items-center gap-3 px-3 py-2 text-[13px]", i && "border-t border-line")}>
              <span className="w-5 text-center">
                {c.isPrimaryKey ? <Key className="inline size-3 text-warning" /> : c.foreignKey ? <Link2 className="inline size-3 text-brand" /> : null}
              </span>
              <span className="w-40 font-mono">{c.name}</span>
              <TypePill type={c.type} />
              <span className="text-xs text-ink-3">{c.nullable ? "nullable" : "not null"}</span>
              {c.default && <span className="truncate font-mono text-xs text-ink-3">default {c.default}</span>}
              {c.foreignKey && <span className="ml-auto font-mono text-xs text-ink-2">→ {c.foreignKey.table}.{c.foreignKey.column}</span>}
            </div>
          ))}
        </div>

        <div className="mb-2 mt-6 text-sm font-medium">Indexes <span className="text-ink-3">({data.indexes.length})</span></div>
        {data.indexes.length === 0 ? (
          <div className="rounded-md p-3 text-xs text-ink-3 shadow-hairline">No indexes.</div>
        ) : (
          <div className="rounded-md shadow-hairline">
            {data.indexes.map((idx, i) => (
              <div key={idx.name} className={cn("px-3 py-2", i && "border-t border-line")}>
                <div className="flex items-center gap-2 text-[13px]">
                  <span className="font-mono">{idx.name}</span>
                  {idx.unique && <span className="rounded-sm bg-inset px-1 font-mono text-[10px] text-ink-2">unique</span>}
                  <span className="font-mono text-xs text-ink-3">({idx.columns.join(", ")})</span>
                </div>
                <div className="mt-0.5 truncate font-mono text-[11px] text-ink-3">{idx.definition}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ErrorBanner({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="m-3 flex items-start gap-2 rounded-md bg-danger-tint px-3 py-2 text-xs text-danger">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{rpcErrorTag(error)}</div>
        <div className="break-words font-mono text-[11px] opacity-90">{rpcErrorMessage(error)}</div>
      </div>
      {onRetry && <button type="button" className="shrink-0 font-medium hover:underline" onClick={onRetry}>Retry</button>}
    </div>
  );
}

/* ---------------- Screen ---------------- */

export function TableView({
  schema,
  table,
  connectionId: connectionIdProp,
  onAskAboutTable,
}: {
  schema: string;
  table: string;
  connectionId?: string;
  onAskAboutTable?: (context: string) => void;
}) {
  const workspaceConnection = useApp((s) => s.connection);
  const { data: connections = [] } = useQuery(connectionListQuery);
  const connectionId = (connectionIdProp ?? workspaceConnection?.id ?? "") as ConnectionId;
  const connection = workspaceConnection?.id === connectionId
    ? workspaceConnection
    : connections.find((candidate) => candidate.id === connectionId);
  const dialect: Dialect = connection?.dialect ?? "postgres";
  const queryClient = useQueryClient();
  const openTab = useOpenTab();
  const pageSize = useSettings((s) => s.pageSize);

  const [view, setView] = useState<"data" | "structure">("data");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortSpec[]>([]);
  const [filters, setFilters] = useState<FilterSpec[]>([]);
  const [offset, setOffset] = useState(0);
  const [hidden, setHidden] = useState<string[]>([]);
  const [selectedRows, setSelectedRows] = useState<GridRecord[]>([]);

  const detailQuery = useQuery(schemaTableQuery(connectionId, schema, table));
  /* Changing the page size in Settings restarts paging from the top (adjust-during-render). */
  const [lastPageSize, setLastPageSize] = useState(pageSize);
  if (lastPageSize !== pageSize) {
    setLastPageSize(pageSize);
    setOffset(0);
  }

  const rowsQuery = useQuery({ ...tableRowsQuery({ connectionId, schema, table, offset, limit: pageSize, sort, filters }), enabled: connectionId !== "" });

  const page = rowsQuery.data;
  const columns = page?.columns ?? detailQuery.data?.columns ?? NO_COLUMNS;
  const columnNames = useMemo(() => columns.map((c) => c.name), [columns]);
  const total = page?.total ?? detailQuery.data?.table.rowEstimate;
  const pageRows = useMemo<GridRecord[]>(
    () => (page?.rows ?? []).map((r) => Object.fromEntries(columnNames.map((n, i) => [n, r[i]]))),
    [page, columnNames],
  );

  const toggleSort = (column: string, additive: boolean) => {
    setSort((prev) => {
      const current = prev.find((s) => s.column === column);
      const next: SortSpec | null = current ? (current.dir === "asc" ? { column, dir: "desc" } : null) : { column, dir: "asc" };
      if (!additive) return next ? [next] : [];
      const rest = prev.filter((s) => s.column !== column);
      return next ? [...rest, next] : rest;
    });
    setOffset(0);
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard unavailable — ignore */
    }
  };

  const exportRows = (rows: GridRecord[]) =>
    download(`${schema}.${table}${rows.length === pageRows.length ? `.p${Math.floor(offset / pageSize) + 1}` : ".selection"}.csv`, toCsv(rows, columnNames));

  const rowContextMenu = ({ row }: { row: GridRecord }) => {
    const targets = selectedRows.includes(row) ? selectedRows : [row];
    const label = targets.length === 1 ? "row" : `${targets.length} rows`;
    return (
      <ContextMenuContent>
          <ContextMenuItem onClick={() => void copy(JSON.stringify(targets, null, 2))}>
            <Braces /> Copy {label} as JSON
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void copy(toInsert(targets, columnNames, schema, table, dialect))}>
            <Copy /> Copy {label} as INSERT
          </ContextMenuItem>
          <ContextMenuItem onClick={() => exportRows(targets)}>
            <Download /> Export {label} as CSV
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={askAboutTable}>
            <Sparkles /> Ask about this table
          </ContextMenuItem>
        </ContextMenuContent>
    );
  };

  const askAboutTable = () => {
    const context = `${schema}.${table}`;
    if (onAskAboutTable) {
      onAskAboutTable(context);
      return;
    }
    openTab(
      { id: tabIds.chat("home"), kind: "chat", threadId: "home", title: `Ask about ${table}` },
      { context },
    );
  };

  const from = total === 0 ? 0 : offset + 1;
  const to = offset + (page?.rows.length ?? 0);
  const hasNext = total !== undefined ? to < total : (page?.rows.length ?? 0) === pageSize;

  const footer = (
    <div className="flex h-8 shrink-0 items-center gap-3 border-t border-line bg-surface px-3 font-mono text-[11px] text-ink-2">
      <span>
        {rowsQuery.isPending ? "loading…" : `${from.toLocaleString()}–${to.toLocaleString()}`}
        {total !== undefined && <span className="text-ink-3"> of {total.toLocaleString()}{page?.truncated ? "+" : ""}</span>}
      </span>
      {selectedRows.length > 0 && <span className="text-brand-ink">{selectedRows.length} selected</span>}
      {sort.length > 0 && <span className="text-ink-3">order by {sort.map((s) => `${s.column} ${s.dir}`).join(", ")}</span>}
      <span className="ml-auto">page {Math.floor(offset / pageSize) + 1}{total !== undefined ? ` / ${Math.max(1, Math.ceil(total / pageSize)).toLocaleString()}` : ""}</span>
      <button type="button" className="rounded-sm px-1.5 hover:bg-hover disabled:opacity-40" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))}>prev</button>
      <button type="button" className="rounded-sm px-1.5 hover:bg-hover disabled:opacity-40" disabled={!hasNext} onClick={() => setOffset(offset + pageSize)}>next</button>
    </div>
  );

  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="font-mono text-xs text-ink-3">{schema}.</span>
        <span className="-ml-2 font-medium">{table}</span>
        {total !== undefined && <CountBadge n={total} />}
        <Tabs value={view} onValueChange={(v) => setView(v as "data" | "structure")} className="ml-2">
          <TabsList className="h-7">
            <TabsTrigger value="data" className="h-6 px-2 text-xs">Data</TabsTrigger>
            <TabsTrigger value="structure" className="h-6 px-2 text-xs">Structure</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="ml-auto flex items-center gap-1">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter page" className="h-7 w-32 pl-7 text-xs @3xl:w-48" />
          </div>
          <WhereBuilder
            columns={columns}
            dialect={dialect}
            filters={filters}
            onApply={(next) => { setFilters(next); setOffset(0); }}
          />
          <Popover>
            <PopoverTrigger render={<Button variant={hidden.length > 0 ? "secondary" : "ghost"} size="xs" aria-label="Columns — toggle visibility" />}>
              <Columns3 /> <span className="hidden @3xl:inline">Columns</span>
              {hidden.length > 0 && <span className="font-mono text-[10px] text-brand">{columns.length - hidden.length}</span>}
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 gap-1.5">
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] font-medium text-ink-2">Visible columns</span>
                <Button variant="ghost" size="xs" className="ml-auto" onClick={() => setHidden([])} disabled={hidden.length === 0}>Show all</Button>
              </div>
              <div className="max-h-64 overflow-auto">
                {columns.map((c) => {
                  const visible = !hidden.includes(c.name);
                  return (
                    <label key={c.name} className="flex h-7 cursor-pointer items-center gap-2 rounded-sm px-1 text-xs hover:bg-hover">
                      <Checkbox
                        checked={visible}
                        onCheckedChange={() => setHidden((h) => (visible ? [...h, c.name] : h.filter((n) => n !== c.name)))}
                      />
                      <span className="truncate font-mono">{c.name}</span>
                    </label>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>
          <Button
            variant="ghost" size="icon-xs" aria-label="Refresh"
            onClick={() => { void queryClient.invalidateQueries({ queryKey: ["table.rows", connectionId, schema, table] }); void detailQuery.refetch(); }}
          >
            <RefreshCw className={cn(rowsQuery.isFetching && "animate-spin")} />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Export page as CSV" onClick={() => exportRows(pageRows)}><Download /></Button>
          <Button variant="outline" size="xs" onClick={askAboutTable}>
            <Sparkles className="text-brand" />
            <span className="hidden @3xl:inline">Ask about this table</span><span className="@3xl:hidden">Ask</span>
          </Button>
        </div>
      </div>

      {view === "data" ? (
        <div className="flex min-h-0 flex-1 flex-col bg-surface">
          {rowsQuery.error && <ErrorBanner error={rowsQuery.error} onRetry={() => void rowsQuery.refetch()} />}
          {!(rowsQuery.error && !page) && (
            <DataGrid
              manual
              columns={columns}
              rows={pageRows}
              globalFilter={q}
              sort={sort}
              onSortChange={toggleSort}
              hiddenColumns={hidden}
              rowOffset={offset}
              loading={rowsQuery.isFetching}
              resetKey={`${offset}|${JSON.stringify(sort)}|${JSON.stringify(filters)}`}
              onSelectedRowsChange={setSelectedRows}
              rowContextMenu={rowContextMenu}
              footer={footer}
              emptyMessage={filters.length > 0 ? "No rows match these conditions." : "This table is empty."}
              className="min-h-0 flex-1"
            />
          )}
        </div>
      ) : (
        <Structure connectionId={connectionId} schema={schema} table={table} />
      )}
    </div>
  );
}
