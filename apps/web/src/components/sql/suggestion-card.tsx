import { Check, Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";

/** Inline completion proposed by `sql.suggest` — Tab accepts, Esc dismisses. */
export function SuggestionCard({
  text,
  reason,
  onAccept,
  onDismiss,
}: {
  text: string;
  reason: string;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="absolute bottom-3 right-3 z-10 w-[360px] rounded-md bg-surface p-3 shadow-overlay">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
        <Sparkles className="size-3.5 text-brand" /> Suggested filter
      </div>
      <pre className="overflow-x-auto rounded-sm bg-inset px-2 py-1.5 font-mono text-xs text-ink">{text}</pre>
      <p className="mt-1.5 text-xs text-ink-2">{reason}</p>
      <div className="mt-2 flex gap-1.5">
        <Button size="xs" onClick={onAccept}>
          <Check /> Accept <Kbd className="ml-1 bg-primary-foreground/15 text-primary-foreground">Tab</Kbd>
        </Button>
        <Button size="xs" variant="ghost" onClick={onDismiss}>
          <X /> Dismiss
        </Button>
      </div>
    </div>
  );
}
