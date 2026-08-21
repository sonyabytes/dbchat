import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Check, ChevronRight, Database, Loader2, Table2, TerminalSquare, Sparkles, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { Column as GridColumn, Dialect, Row as GridRow } from "@/lib/format";
import type { ColumnMeta, Row as ContractRow } from "@dbchat/contracts";

/* ---------- Dialect / env chips ---------- */
export function DialectIcon({ dialect, className }: { dialect: Dialect; className?: string }) {
  const label = dialect === "postgres" ? "PG" : dialect === "mysql" ? "My" : "Lite";
  const tone = dialect === "postgres" ? "bg-brand-tint text-brand-ink" : dialect === "mysql" ? "bg-warning-tint text-warning" : "bg-inset text-ink-2";
  return (
    <span className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-sm font-mono text-[10px] font-semibold", tone, className)}>
      {label}
    </span>
  );
}

export function EnvBadge({ env }: { env: "local" | "staging" | "prod" }) {
  const tone = env === "prod" ? "bg-danger-tint text-danger" : env === "staging" ? "bg-warning-tint text-warning" : "bg-success-tint text-success";
  return <span className={cn("rounded-sm px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide", tone)}>{env}</span>;
}

export function StatusDot({ status }: { status: "connected" | "idle" | "error" | "running" }) {
  const tone = status === "connected" ? "bg-success" : status === "error" ? "bg-danger" : status === "running" ? "bg-brand" : "bg-ink-3";
  return (
    <span className="relative inline-flex size-2">
      {status === "running" && <span className="absolute inset-0 animate-ping rounded-full bg-brand/60" />}
      <span className={cn("size-2 rounded-full", tone)} />
    </span>
  );
}

/* ---------- Type pill for columns ---------- */
export function TypePill({ type }: { type: string }) {
  return <span className="rounded-sm bg-inset px-1 font-mono text-[10.5px] text-ink-2">{type}</span>;
}

/* ---------- Tool chip (Beautiful UI "tool-chips") ---------- */
export function ToolChip({
  icon, label, detail, status = "done", onClick,
}: { icon?: "sql" | "table" | "schema" | "ai"; label: string; detail?: string; status?: "running" | "done" | "error"; onClick?: () => void }) {
  const Icon = icon === "table" ? Table2 : icon === "schema" ? Database : icon === "ai" ? Sparkles : TerminalSquare;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group inline-flex h-7 max-w-full items-center gap-1.5 rounded-sm bg-surface pl-1.5 pr-2 text-xs shadow-hairline transition-colors hover:bg-hover",
        status === "error" && "text-danger",
      )}
    >
      {status === "running" ? <Loader2 className="size-3.5 animate-spin text-brand" /> : <Icon className="size-3.5 text-ink-2" />}
      <span className="font-medium">{label}</span>
      {detail && <span className="truncate font-mono text-ink-3">{detail}</span>}
      {status === "done" && <Check className="size-3 text-success" />}
    </button>
  );
}

/* ---------- Thinking state ---------- */
export function ThinkingState({ title, steps, live = false }: { title: string; steps: string[]; live?: boolean }) {
  const [open, setOpen] = useState(live);
  return (
    <div className="rounded-md bg-surface shadow-hairline">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs">
        <ChevronRight className={cn("size-3.5 text-ink-3 transition-transform", open && "rotate-90")} />
        <span className={cn("font-medium", live ? "shimmer-text" : "text-ink-2")}>{title}</span>
        {!live && <span className="ml-auto font-mono text-[10.5px] text-ink-3">{steps.length} steps</span>}
      </button>
      {open && (
        <ol className="space-y-1.5 border-t border-line px-3 py-2 text-xs text-ink-2">
          {steps.map((s, i) => (
            <li key={i} className="flex gap-2">
              <span className="font-mono text-ink-3">{String(i + 1).padStart(2, "0")}</span>
              <span className={cn(live && i === steps.length - 1 && "stream-caret")}>{s}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/* ---------- Section label ---------- */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3", className)}>{children}</div>;
}

export function CountBadge({ n }: { n: number }) {
  return <Badge variant="secondary" className="h-4 rounded-sm px-1 font-mono text-[10px] tabular-nums">{Intl.NumberFormat("en", { notation: "compact" }).format(n)}</Badge>;
}

/* ---------- Contract row/column adapters (arrays → DataGrid's record shape) ---------- */

/** ColumnMeta[] → DataGrid columns (dedupes repeated names so keys stay unique). */
export function gridColumns(columns: readonly ColumnMeta[]): GridColumn[] {
  const seen = new Map<string, number>();
  return columns.map((c) => {
    const n = seen.get(c.name) ?? 0;
    seen.set(c.name, n + 1);
    return {
      name: n === 0 ? c.name : `${c.name}_${n}`,
      type: c.type,
      nullable: c.nullable,
      pk: c.isPrimaryKey,
      ...(c.foreignKey ? { fk: `${c.foreignKey.table}.${c.foreignKey.column}` } : {}),
    };
  });
}

/** Positional rows → objects keyed by the (deduped) column names. */
export function gridRows(columns: readonly ColumnMeta[], rows: readonly ContractRow[]): GridRow[] {
  const names = gridColumns(columns).map((c) => c.name);
  return rows.map((r) => {
    const o: GridRow = {};
    names.forEach((name, i) => {
      const v = r[i];
      o[name] =
        v === null || v === undefined
          ? null
          : typeof v === "string" || typeof v === "number" || typeof v === "boolean"
            ? v
            : JSON.stringify(v);
    });
    return o;
  });
}

/** Inline error strip used by chat + sql. */
export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-md bg-danger-tint px-3 py-2 text-xs text-danger shadow-hairline">
      <TriangleAlert className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{message}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="shrink-0 rounded-sm px-1 text-danger/70 hover:text-danger">
          dismiss
        </button>
      )}
    </div>
  );
}
