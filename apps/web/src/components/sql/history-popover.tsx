import { useQuery } from "@tanstack/react-query";
import { Check, Clock, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { relativeTime } from "@/lib/format";
import { historyQuery } from "@/rpc/sql";

/** Recent runs for this connection; click one to load it into the editor. */
export function HistoryPopover({ connectionId, onPick }: { connectionId: string; onPick: (sql: string) => void }) {
  const { data: history, isLoading } = useQuery(historyQuery(connectionId));

  return (
    <Popover>
      <PopoverTrigger render={<Button variant="ghost" size="xs" />}>
        <Clock /> History
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[420px] gap-1 p-1.5">
        <div className="px-1.5 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">
          Query history
        </div>
        <div className="max-h-[320px] overflow-auto">
          {isLoading && <div className="px-1.5 py-2 text-xs text-ink-3">Loading…</div>}
          {!isLoading && (history?.length ?? 0) === 0 && (
            <div className="px-1.5 py-2 text-xs text-ink-3">Nothing run yet on this connection.</div>
          )}
          {history?.map((h) => (
            <button
              key={h.id}
              type="button"
              onClick={() => onPick(h.sql)}
              className="flex w-full flex-col gap-0.5 rounded-sm px-1.5 py-1.5 text-left hover:bg-hover"
            >
              <span className="truncate font-mono text-[11.5px] text-ink">{h.sql.replace(/\s+/g, " ").slice(0, 90)}</span>
              <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-ink-3">
                {h.ok ? <Check className="size-3 text-success" /> : <X className="size-3 text-danger" />}
                {h.rowCount.toLocaleString()} rows · {Math.round(h.durationMs)} ms · {relativeTime(h.ranAt)}
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
