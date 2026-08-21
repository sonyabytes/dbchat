import { Check, Copy, Maximize2, TerminalSquare } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

/** Fenced ```sql block inside an assistant message. */
export function SqlBlock({ code, onOpen }: { code: string; onOpen?: (sql: string) => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="overflow-hidden rounded-md bg-surface shadow-hairline">
      <div className="flex h-7 items-center gap-2 border-b border-line px-2.5 text-[11px] text-ink-3">
        <TerminalSquare className="size-3" /> sql
        <div className="ml-auto flex items-center gap-0.5">
          <Button variant="ghost" size="icon-xs" aria-label="Copy SQL" onClick={copy}>
            {copied ? <Check className="text-success" /> : <Copy />}
          </Button>
          {onOpen && (
            <Button variant="ghost" size="icon-xs" aria-label="Open in editor" onClick={() => onOpen(code)}>
              <Maximize2 />
            </Button>
          )}
        </div>
      </div>
      <pre className="overflow-x-auto px-3 py-2.5 font-mono text-xs leading-relaxed text-ink">{code}</pre>
    </div>
  );
}
