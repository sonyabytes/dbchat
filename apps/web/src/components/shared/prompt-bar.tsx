import { ArrowUp, AtSign, Paperclip, Slash, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ModelPicker } from "@/components/chat/model-picker";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

export interface MentionTable {
  schema: string;
  name: string;
  detail?: string;
}

export function PromptBar({
  placeholder = "Ask about your data, or describe a query…",
  compact = false,
  onSend,
  streaming = false,
  onStop,
  tables = [],
  context,
  autoFocus = false,
  disabled = false,
  model,
  modelLabel,
  onModelChange,
}: {
  placeholder?: string;
  compact?: boolean;
  onSend?: (text: string) => void;
  streaming?: boolean;
  onStop?: () => void;
  tables?: MentionTable[];
  context?: { label: string; onRemove?: () => void } | null;
  autoFocus?: boolean;
  disabled?: boolean;
  /** Selected model id; omit (with `onModelChange`) to hide the picker. */
  model?: string | undefined;
  modelLabel?: string | undefined;
  onModelChange?: (modelId: string) => void;
}) {
  const [value, setValue] = useState("");
  const [mention, setMention] = useState<string | null>(null);
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);

  const matches =
    mention === null
      ? []
      : tables.filter((t) => `${t.schema}.${t.name}`.toLowerCase().includes(mention.toLowerCase())).slice(0, 5);
  const chips = tables.slice(0, 3).map((t) => ({
    label: t.schema === "public" ? t.name : `${t.schema}.${t.name}`,
    insert: `${t.schema}.${t.name}`,
  }));

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const send = () => {
    if (!value.trim() || disabled) return;
    onSend?.(value.trim());
    setValue("");
    setMention(null);
  };

  const accept = (t: MentionTable) => {
    setValue((v) => v.replace(/@[\w.]*$/, `@${t.schema}.${t.name} `));
    setMention(null);
    ref.current?.focus();
  };

  return (
    <div
      className={cn(
        "relative rounded-lg bg-surface shadow-card focus-within:shadow-raised focus-within:ring-2 focus-within:ring-brand/30",
        compact ? "p-2" : "p-2.5",
      )}
    >
      {matches.length > 0 && (
        <div className="absolute inset-x-2 bottom-full z-20 mb-2 rounded-md bg-surface p-1 shadow-overlay">
          {matches.map((t, i) => (
            <button
              key={`${t.schema}.${t.name}`}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                accept(t);
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-hover",
                i === hi && "bg-hover",
              )}
            >
              <span className="font-mono text-ink-3">{t.schema}.</span>
              <span className="font-medium">{t.name}</span>
              {t.detail && <span className="ml-auto font-mono text-[10.5px] text-ink-3">{t.detail}</span>}
            </button>
          ))}
        </div>
      )}

      {context && (
        <div className="mb-1.5 flex items-center gap-1.5 px-1">
          <span className="inline-flex h-5 items-center gap-1 rounded-sm bg-brand-tint px-1.5 font-mono text-[11px] text-brand-ink">
            {context.label}
            {context.onRemove && (
              <button
                type="button"
                aria-label="Remove context"
                onClick={context.onRemove}
                className="text-brand-ink/70 hover:text-brand-ink"
              >
                <X className="size-3" />
              </button>
            )}
          </span>
          <span className="text-[11px] text-ink-3">in context</span>
        </div>
      )}

      <textarea
        ref={ref}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          const m = /@([\w.]*)$/.exec(e.target.value);
          setMention(m ? (m[1] ?? "") : null);
          setHi(0);
        }}
        onKeyDown={(e) => {
          if (matches.length > 0) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHi((h) => (h + 1) % matches.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setHi((h) => (h - 1 + matches.length) % matches.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              const pick = matches[hi];
              if (pick) accept(pick);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setMention(null);
              return;
            }
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
            return;
          }
          if (e.key === "Escape" && streaming) {
            e.preventDefault();
            onStop?.();
          }
        }}
        placeholder={placeholder}
        rows={compact ? 1 : 2}
        className="w-full resize-none bg-transparent px-1.5 py-1 text-sm outline-none placeholder:text-ink-3"
      />

      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Mention table"
          onClick={() => {
            setValue((v) => `${v}@`);
            setMention("");
            ref.current?.focus();
          }}
        >
          <AtSign />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Slash command">
          <Slash />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Attach">
          <Paperclip />
        </Button>
        {!compact && chips.length > 0 && (
          <div className="ml-1 flex min-w-0 items-center gap-1 overflow-hidden border-l border-line pl-2">
            {chips.map((c) => (
              <button
                key={c.insert}
                type="button"
                onClick={() => setValue((v) => `${v}@${c.insert} `)}
                className="truncate rounded-sm bg-inset px-1.5 py-0.5 font-mono text-[11px] text-ink-2 hover:bg-hover-2"
              >
                @{c.label}
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {onModelChange && (
            <span className="hidden items-center gap-1 whitespace-nowrap text-[11px] text-ink-3 sm:flex">
              <ModelPicker
                {...(model ? { value: model } : {})}
                label={modelLabel ?? "Model"}
                onChange={onModelChange}
              />
              <span className="text-ink-3">·</span> read-only
            </span>
          )}
          {streaming ? (
            <>
              <Kbd className="hidden sm:inline-flex">esc</Kbd>
              <Button size="icon-sm" variant="secondary" aria-label="Stop" onClick={onStop}>
                <Square />
              </Button>
            </>
          ) : (
            <>
              <Kbd className="hidden sm:inline-flex">↵</Kbd>
              <Button size="icon-sm" aria-label="Send" onClick={send} disabled={!value.trim() || disabled}>
                <ArrowUp />
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
