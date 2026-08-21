/**
 * Result grid shared by the table view, the SQL editor and chat result cards.
 *
 * Accepts either record rows (`{ col: value }`) or tuple rows (`RowsPage.rows`),
 * and either the prototype column shape (`{ pk, fk }`) or contract `ColumnMeta`.
 * In "manual" mode (table view) sorting/paging are owned by the caller and the
 * server; otherwise it keeps the original client-side sort + pagination.
 * Rows are virtualised with TanStack Virtual; header + row-number column stay sticky.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  type ColumnDef, type SortingState, type VisibilityState,
  flexRender, getCoreRowModel, getFilteredRowModel, getPaginationRowModel, getSortedRowModel, useReactTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ChevronsUpDown, Key, Link2 } from "lucide-react";
import type { ColumnMeta, SortSpec } from "@dbchat/contracts";

import { cn } from "@/lib/utils";
import { TypePill } from "./primitives";

export type GridColumn =
  | { name: string; type: string; nullable?: boolean; pk?: boolean; fk?: string }
  | ColumnMeta;
export type GridRow = Record<string, unknown> | ReadonlyArray<unknown>;
export type GridRecord = Record<string, unknown>;

interface NormalColumn { name: string; type: string; nullable: boolean; pk: boolean; fk?: string }

function normalizeColumns(columns: ReadonlyArray<GridColumn>): NormalColumn[] {
  const seen = new Set<string>();
  return columns.map((raw) => {
    const c = raw as Record<string, unknown>;
    const fkObj = c["foreignKey"] as { table: string; column: string } | undefined;
    let name = String(c["name"] ?? "");
    while (seen.has(name)) name = `${name}_`;
    seen.add(name);
    const fk = fkObj ? `${fkObj.table}.${fkObj.column}` : typeof c["fk"] === "string" ? (c["fk"] as string) : undefined;
    return {
      name,
      type: String(c["type"] ?? ""),
      nullable: Boolean(c["nullable"]),
      pk: Boolean(c["isPrimaryKey"] ?? c["pk"]),
      ...(fk ? { fk } : {}),
    };
  });
}

const ENUM_LIKE = ["paid", "unpaid", "free", "pro", "team", "enterprise", "active", "cancelled", "pending", "failed"];
const NUMERIC_TYPE = /^(?:bigint|bigserial|decimal|double(?: precision)?|float\d*|int(?:eger)?\d*|mediumint|money|numeric|real|serial\d*|smallint|tinyint)(?:\s|\(|$)/i;

function isNumericType(type: string): boolean {
  return NUMERIC_TYPE.test(type);
}

export function CellValue({ v, type }: { v: unknown; type?: string }) {
  if (v === null || v === undefined) return <span className="font-mono text-[11px] italic text-ink-3">NULL</span>;
  if (typeof v === "boolean") return <span className={cn("font-mono text-[11px]", v ? "text-success" : "text-ink-3")}>{String(v)}</span>;
  if (typeof v === "number") return <span className="font-mono tabular-nums">{v.toLocaleString()}</span>;
  if (typeof v === "object") {
    const json = JSON.stringify(v);
    return <span className="block truncate font-mono text-xs text-ink-2" title={json}>{json}</span>;
  }
  const s = String(v);
  if (type?.startsWith("timestamp") || type === "date" || type === "datetime") {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      return <span className="font-mono text-xs tabular-nums text-ink-2">{d.toISOString().slice(0, 16).replace("T", " ")}</span>;
    }
  }
  if (type === "uuid") return <span className="font-mono text-xs text-ink-2" title={s}>{s.slice(0, 8)}…</span>;
  // pg returns bigint/numeric as strings to stay lossless — keep them looking numeric.
  if (/bigint|int8|numeric|decimal/i.test(type ?? "") && s !== "" && !Number.isNaN(Number(s)))
    return <span className="font-mono tabular-nums">{Number(s).toLocaleString()}</span>;
  if (type?.endsWith("enum") || (type === "text" && ENUM_LIKE.includes(s)))
    return <span className="rounded-sm bg-inset px-1.5 py-0.5 font-mono text-[11px]">{s}</span>;
  return <span className="block truncate" title={s}>{s}</span>;
}

export interface DataGridProps {
  columns: ReadonlyArray<GridColumn>;
  rows: ReadonlyArray<GridRow>;
  globalFilter?: string;
  pageSize?: number;
  dense?: boolean;
  className?: string;
  /** Back-compat: number of selected rows. */
  onSelectionChange?: (n: number) => void;
  /** Selected rows as records, in page order. */
  onSelectedRowsChange?: (rows: GridRecord[]) => void;
  /** Changing this clears the selection (new page / sort / filter). */
  resetKey?: string;
  /** Server-owned sort + paging: caller renders the footer and handles header clicks. */
  manual?: boolean;
  sort?: ReadonlyArray<SortSpec>;
  onSortChange?: (column: string, additive: boolean) => void;
  hiddenColumns?: ReadonlyArray<string>;
  footer?: ReactNode;
  loading?: boolean;
  emptyMessage?: string;
  /** Row numbers start at `rowOffset + 1`. */
  rowOffset?: number;
}

export function DataGrid({
  columns, rows, globalFilter = "", pageSize = 50, dense = false, className,
  onSelectionChange, onSelectedRowsChange, resetKey, manual = false, sort, onSortChange,
  hiddenColumns, footer, loading = false, emptyMessage = "No rows.", rowOffset = 0,
}: DataGridProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  const cols = useMemo(() => normalizeColumns(columns), [columns]);
  const numericColumns = useMemo(
    () => new Set(cols.filter((column) => isNumericType(column.type)).map((column) => column.name)),
    [cols],
  );

  const data = useMemo<GridRecord[]>(
    () =>
      rows.map((r) =>
        Array.isArray(r)
          ? Object.fromEntries(cols.map((c, i) => [c.name, (r as ReadonlyArray<unknown>)[i]]))
          : (r as GridRecord),
      ),
    [rows, cols],
  );

  // Clear the selection whenever the underlying page changes.
  useEffect(() => {
    setSelected(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [resetKey]);

  const sortFor = (name: string) => sort?.find((s) => s.column === name);

  const defs = useMemo<ColumnDef<GridRecord>[]>(
    () =>
      cols.map((c) => ({
        id: c.name,
        accessorFn: (row) => row[c.name],
        header: () => (
          <div className="flex items-center gap-1.5">
            {c.pk && <Key className="size-3 text-warning" />}
            {c.fk && <Link2 className="size-3 text-brand" />}
            <span className="font-medium">{c.name}</span>
            <TypePill type={c.type} />
          </div>
        ),
        cell: ({ getValue }) => <CellValue v={getValue()} type={c.type} />,
      })),
    [cols],
  );

  const columnVisibility = useMemo<VisibilityState>(
    () => Object.fromEntries((hiddenColumns ?? []).map((n) => [n, false])),
    [hiddenColumns],
  );

  const table = useReactTable({
    data,
    columns: defs,
    state: { sorting, globalFilter, columnVisibility },
    onSortingChange: setSorting,
    manualSorting: manual,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    ...(manual ? {} : { getSortedRowModel: getSortedRowModel(), getPaginationRowModel: getPaginationRowModel() }),
    initialState: { pagination: { pageSize } },
  });

  const modelRows = table.getRowModel().rows;

  // Notify the caller after render, never inside a state updater.
  useEffect(() => {
    onSelectionChange?.(selected.size);
    onSelectedRowsChange?.(modelRows.filter((r) => selected.has(r.index)).map((r) => r.original));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const rowPx = dense ? 30 : 34;
  const virtualizer = useVirtualizer({
    count: modelRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowPx,
    overscan: 14,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0]!.start : 0;
  const paddingBottom = virtualRows.length > 0 ? virtualizer.getTotalSize() - virtualRows[virtualRows.length - 1]!.end : 0;

  const toggle = (index: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const toggleAll = () =>
    setSelected((prev) =>
      modelRows.length > 0 && prev.size === modelRows.length ? new Set<number>() : new Set(modelRows.map((r) => r.index)),
    );

  const headers = table.getHeaderGroups()[0]?.headers ?? [];
  const rowH = dense ? "h-[30px]" : "h-[34px]";

  return (
    <div className={cn("relative flex min-h-0 flex-col", className)}>
      <div ref={scrollRef} className={cn("min-h-0 flex-1 overflow-auto", loading && "opacity-60")}>
        <table className="w-max min-w-full border-separate border-spacing-0 text-[13px]">
          <thead className="sticky top-0 z-10 bg-inset">
            <tr>
              <th className="sticky left-0 z-20 w-11 border-b border-r border-line-strong bg-inset p-0">
                <button
                  type="button"
                  onClick={toggleAll}
                  aria-label="Select all rows on this page"
                  className={cn(
                    "h-8 w-full font-mono text-[10.5px] text-ink-3 transition-opacity hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/40",
                    selected.size > 0 ? "opacity-100" : "opacity-0 hover:opacity-100",
                  )}
                >
                  {selected.size > 0 && selected.size === modelRows.length ? "✓" : "#"}
                </button>
              </th>
              {headers.map((h) => {
                const name = h.column.id;
                const server = sortFor(name);
                const dir = manual ? server?.dir : h.column.getIsSorted() || undefined;
                const order = manual && sort && sort.length > 1 ? sort.findIndex((s) => s.column === name) : -1;
                const numeric = numericColumns.has(name);
                return (
                  <th
                    key={h.id}
                    className={cn(
                      "group h-8 whitespace-nowrap border-b border-r border-line-strong px-3 font-normal last:border-r-0",
                      numeric ? "text-right" : "text-left",
                    )}
                  >
                    <button
                      type="button"
                      onClick={(e) => (manual ? onSortChange?.(name, e.shiftKey) : h.column.getToggleSortingHandler()?.(e))}
                      title={manual ? "Click to sort · shift-click to add" : undefined}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
                        numeric && "justify-end",
                      )}
                    >
                      {flexRender(h.column.columnDef.header, h.getContext())}
                      <span className={cn("flex items-center gap-0.5 text-ink-3", !numeric && "ml-auto")}>
                        {order >= 0 && <span className="font-mono text-[9px] text-brand">{order + 1}</span>}
                        {dir === "asc" ? <ArrowUp className="size-3 text-brand" />
                          : dir === "desc" ? <ArrowDown className="size-3 text-brand" />
                          : <ChevronsUpDown className="size-3 opacity-0 group-hover:opacity-100" />}
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {paddingTop > 0 && <tr style={{ height: paddingTop }} aria-hidden />}
            {virtualRows.map((v) => {
              const r = modelRows[v.index]!;
              const sel = selected.has(r.index);
              const striped = v.index % 2 === 1;
              return (
                <tr key={r.id} className={cn("group", rowH, sel ? "bg-brand-tint" : striped ? "bg-inset hover:bg-hover" : "bg-surface hover:bg-hover")}>
                  <td
                    className={cn(
                      "sticky left-0 z-10 border-b border-r border-line px-0 text-center",
                      sel ? "bg-brand-tint" : striped ? "bg-inset group-hover:bg-hover" : "bg-surface group-hover:bg-hover",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => toggle(r.index)}
                      aria-label={`${sel ? "Deselect" : "Select"} row ${rowOffset + r.index + 1}`}
                      className="h-full w-full font-mono text-[10.5px] tabular-nums text-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/40"
                    >
                      {sel ? "✓" : rowOffset + r.index + 1}
                    </button>
                  </td>
                  {r.getVisibleCells().map((c) => (
                    <td
                      key={c.id}
                      className={cn(
                        "max-w-[320px] whitespace-nowrap border-b border-r border-line px-3 last:border-r-0",
                        numericColumns.has(c.column.id) && "text-right",
                      )}
                    >
                      {flexRender(c.column.columnDef.cell, c.getContext())}
                    </td>
                  ))}
                </tr>
              );
            })}
            {paddingBottom > 0 && <tr style={{ height: paddingBottom }} aria-hidden />}
          </tbody>
        </table>
        {modelRows.length === 0 && !loading && (
          <div className="flex h-24 items-center justify-center text-xs text-ink-3">{emptyMessage}</div>
        )}
      </div>

      {footer ?? (
        <div className="flex h-8 shrink-0 items-center gap-3 border-t border-line-strong bg-inset/70 px-3 font-mono text-[11px] text-ink-2">
          <span>{table.getFilteredRowModel().rows.length.toLocaleString()} rows</span>
          {selected.size > 0 && <span className="text-brand-ink">{selected.size} selected</span>}
          <span className="ml-auto">page {table.getState().pagination.pageIndex + 1} / {Math.max(1, table.getPageCount())}</span>
          <button type="button" className="rounded-sm px-1.5 hover:bg-hover disabled:opacity-40" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>prev</button>
          <button type="button" className="rounded-sm px-1.5 hover:bg-hover disabled:opacity-40" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>next</button>
        </div>
      )}
    </div>
  );
}
