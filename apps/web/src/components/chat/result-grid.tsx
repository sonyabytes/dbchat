import type { ColumnMeta, Row } from "@dbchat/contracts";
import { BarChart3, Maximize2, Table2 } from "lucide-react";
import { useState } from "react";

import { DataGrid } from "@/components/shared/data-grid";
import { gridColumns, gridRows } from "@/components/shared/primitives";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** Result table card used by chat turns (and the SQL editor's expand view). */
export function ResultGrid({
  columns,
  rows,
  sql,
  pageSize = 6,
  className,
  onOpenInEditor,
}: {
  columns: readonly ColumnMeta[];
  rows: readonly Row[];
  sql?: string;
  pageSize?: number;
  className?: string;
  onOpenInEditor?: (sql: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const cols = gridColumns(columns);
  const data = gridRows(columns, rows);

  return (
    <>
      <div className="overflow-hidden rounded-md bg-surface shadow-hairline">
        <div className="flex h-7 items-center gap-2 border-b border-line px-2.5 text-[11px] text-ink-3">
          <Table2 className="size-3" /> {rows.length.toLocaleString()} {rows.length === 1 ? "row" : "rows"}
          <div className="ml-auto flex items-center gap-0.5">
            {sql && onOpenInEditor && (
              <Button variant="ghost" size="icon-xs" aria-label="Open in editor" onClick={() => onOpenInEditor(sql)}>
                <BarChart3 />
              </Button>
            )}
            <Button variant="ghost" size="icon-xs" aria-label="Expand" onClick={() => setExpanded(true)}>
              <Maximize2 />
            </Button>
          </div>
        </div>
        <DataGrid dense pageSize={pageSize} columns={cols} rows={data} className={cn("max-h-[260px]", className)} />
      </div>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="flex h-[76vh] max-w-[min(1100px,calc(100%-4rem))] flex-col gap-3 sm:max-w-[min(1100px,calc(100%-4rem))]">
          <DialogHeader>
            <DialogTitle>Result · {rows.length.toLocaleString()} {rows.length === 1 ? "row" : "rows"}</DialogTitle>
          </DialogHeader>
          {sql && <pre className="max-h-24 overflow-auto rounded-sm bg-inset px-2.5 py-2 font-mono text-xs">{sql}</pre>}
          <div className="min-h-0 flex-1 overflow-hidden rounded-md shadow-hairline">
            <DataGrid dense pageSize={50} columns={cols} rows={data} className="h-full" />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
