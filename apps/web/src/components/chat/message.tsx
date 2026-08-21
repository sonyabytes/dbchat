import type { MessagePart } from "@dbchat/contracts";
import { Check, Copy, RotateCcw } from "lucide-react";
import { lazy, Suspense, useState } from "react";

import { ThinkingState, ToolChip } from "@/components/shared/primitives";
import { Button } from "@/components/ui/button";
import type { UiMessage } from "@/lib/chat-store";

import { ApprovalCard } from "./approval-card";
// react-markdown + remark-gfm (~120 kB) load on first assistant message, not at startup.
const Markdown = lazy(() => import("./markdown").then((m) => ({ default: m.Markdown })));
import { ResultGrid } from "./result-grid";

type ToolPart = Extract<MessagePart, { _tag: "ToolCall" }>;

const TOOL_LABELS: Record<string, string> = {
  list_schemas: "schemas",
  describe_table: "describe",
  sample_rows: "sample",
  run_sql: "select",
  explain: "explain",
  propose_write: "propose write",
  open_in_editor: "open editor",
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Chip label/detail derived from the tool's input + output. */
export function toolMeta(p: ToolPart): { label: string; detail?: string; icon: "sql" | "table" | "schema" | "ai" } {
  const name = p.name.replace(/^mcp__[^_]*__/, "");
  const label = TOOL_LABELS[name] ?? name.replace(/_/g, " ");
  const icon: "sql" | "table" | "schema" | "ai" = /schema|describe|table/.test(name)
    ? "schema"
    : /sql|query|explain|write|run|select/.test(name)
      ? "sql"
      : "ai";

  const input = asRecord(p.input);
  const output = asRecord(p.output);
  const bits: string[] = [];

  const target = input.table ?? input.tables ?? input.name ?? input.schema;
  if (typeof target === "string") bits.push(target);
  else if (Array.isArray(target)) bits.push(target.filter((t) => typeof t === "string").join(", "));

  const rowsRaw = output.rowCount ?? output.rows ?? output.count;
  const rowCount = typeof rowsRaw === "number" ? rowsRaw : Array.isArray(rowsRaw) ? rowsRaw.length : undefined;
  if (rowCount !== undefined) bits.push(`${rowCount.toLocaleString()} ${rowCount === 1 ? "row" : "rows"}`);
  else if (typeof output.columns === "number") bits.push(`${output.columns} cols`);
  // Only fall back to a SQL preview when there is nothing more useful to show.
  if (bits.length === 0 && typeof input.sql === "string") bits.push(input.sql.replace(/\s+/g, " ").slice(0, 40));

  if (p.status !== "running" && p.durationMs !== undefined) bits.push(`${Math.round(p.durationMs)} ms`);

  return { label, icon, ...(bits.length ? { detail: bits.join(" · ") } : {}) };
}

function thinkingSteps(text: string): string[] {
  const lines = text
    .split(/\n+/)
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
  if (lines.length > 1) return lines;
  const single = lines[0] ?? "";
  if (single.length < 90) return single ? [single] : [];
  return single
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Highlight `@schema.table` mentions inside a user message. */
function renderMentions(text: string) {
  return text.split(/(@[\w.]+)/g).map((chunk, i) =>
    chunk.startsWith("@") && chunk.length > 1 ? (
      <span key={i} className="rounded-sm bg-brand-tint px-1 font-mono text-[12px] text-brand-ink">
        {chunk}
      </span>
    ) : (
      <span key={i}>{chunk}</span>
    ),
  );
}

type Block =
  | { kind: "tools"; parts: ToolPart[] }
  | { kind: "part"; part: MessagePart; last: boolean };

function toBlocks(parts: MessagePart[]): Block[] {
  const out: Block[] = [];
  parts.forEach((part, i) => {
    const last = i === parts.length - 1;
    if (part._tag === "ToolCall") {
      const prev = out[out.length - 1];
      if (prev && prev.kind === "tools") prev.parts.push(part);
      else out.push({ kind: "tools", parts: [part] });
      return;
    }
    out.push({ kind: "part", part, last });
  });
  return out;
}

export function ChatMessage({
  message,
  streaming,
  connectionName,
  env,
  modelLabel,
  onOpenSql,
  onRetry,
  onApprove,
}: {
  message: UiMessage;
  streaming: boolean;
  connectionName?: string;
  env?: string;
  /** Model that produced this turn — resolved by the caller from the catalog. */
  modelLabel?: string;
  onOpenSql?: (sql: string) => void;
  onRetry?: () => void;
  onApprove?: (approvalId: string, approve: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);

  if (message.role === "user") {
    const text = message.parts
      .filter((p): p is Extract<MessagePart, { _tag: "Text" }> => p._tag === "Text")
      .map((p) => p.text)
      .join("\n");
    return (
      <div className="flex justify-end">
        <div className="max-w-[78%] whitespace-pre-wrap rounded-lg bg-inset px-3.5 py-2.5 text-sm shadow-hairline">
          {renderMentions(text)}
        </div>
      </div>
    );
  }

  const blocks = toBlocks(message.parts);
  const plain = message.parts
    .filter((p): p is Extract<MessagePart, { _tag: "Text" }> => p._tag === "Text")
    .map((p) => p.text)
    .join("\n\n");
  const copy = () => {
    void navigator.clipboard?.writeText(plain);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  const tokens = message.usage ? message.usage.inputTokens + message.usage.outputTokens : undefined;

  return (
    <div className="flex flex-col gap-3">
      {blocks.length === 0 && streaming && <ThinkingState live title="Working…" steps={[]} />}

      {blocks.map((b, i) => {
        if (b.kind === "tools") {
          return (
            <div key={i} className="flex flex-wrap gap-1.5">
              {b.parts.map((t) => {
                const meta = toolMeta(t);
                return <ToolChip key={t.id} icon={meta.icon} label={meta.label} detail={meta.detail} status={t.status} />;
              })}
            </div>
          );
        }
        const p = b.part;
        switch (p._tag) {
          case "Thinking":
            return (
              <ThinkingState
                key={i}
                live={streaming && b.last}
                title={streaming && b.last ? "Thinking…" : "Reasoning"}
                steps={thinkingSteps(p.text)}
              />
            );
          case "Text":
            return p.text.trim() ? (
              <div
                key={i}
                className={
                  streaming && b.last
                    ? "[&_p:last-of-type]:after:ml-px [&_p:last-of-type]:after:animate-[caret_1s_steps(1)_infinite] [&_p:last-of-type]:after:text-brand [&_p:last-of-type]:after:content-['▍']"
                    : undefined
                }
              >
                <Suspense fallback={<p className="whitespace-pre-wrap">{p.text}</p>}>
                  <Markdown onOpenSql={onOpenSql}>{p.text}</Markdown>
                </Suspense>
              </div>
            ) : null;
          case "ResultTable":
            return (
              <ResultGrid key={i} columns={p.columns} rows={p.rows} sql={p.sql} {...(onOpenSql ? { onOpenInEditor: onOpenSql } : {})} />
            );
          case "Approval":
            return (
              <ApprovalCard
                key={i}
                part={p}
                {...(connectionName ? { connectionName } : {})}
                {...(env ? { env } : {})}
                {...(onOpenSql ? { onOpenInEditor: onOpenSql } : {})}
                onDecide={(approve) => onApprove?.(p.id, approve)}
              />
            );
          default:
            return null;
        }
      })}

      {!streaming && blocks.length > 0 && (
        <div className="flex items-center gap-1 text-ink-3">
          <Button variant="ghost" size="icon-xs" aria-label="Copy message" onClick={copy}>
            {copied ? <Check className="text-success" /> : <Copy />}
          </Button>
          {onRetry && (
            <Button variant="ghost" size="icon-xs" aria-label="Retry" onClick={onRetry}>
              <RotateCcw />
            </Button>
          )}
          <span className="ml-1 text-[11px]">
            {modelLabel ?? "Claude"}
            {tokens !== undefined && ` · ${Intl.NumberFormat("en", { notation: "compact" }).format(tokens)} tokens`}
            {message.usage?.costUsd !== undefined && ` · $${message.usage.costUsd.toFixed(3)}`}
          </span>
        </div>
      )}
    </div>
  );
}
