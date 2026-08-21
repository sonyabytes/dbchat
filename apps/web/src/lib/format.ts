/**
 * Leftovers from the prototype. The fixture data is gone (everything is served by
 * the RPC layer now); what remains is still imported:
 *  - `relativeTime` — connections list, thread list, query history
 *  - `Column` / `Row` / `Dialect` — the loose grid shapes `shared/primitives` adapts to
 */
export type { Dialect } from "@dbchat/contracts";

export function relativeTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 2 * 86400) return "yesterday";
  if (s < 14 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return `${Math.floor(s / (7 * 86400))}w ago`;
}

/** Loose column shape the DataGrid accepts alongside contract `ColumnMeta`. */
export interface Column {
  name: string;
  type: string;
  nullable?: boolean;
  pk?: boolean;
  fk?: string;
}

export type Row = Record<string, string | number | boolean | null>;
