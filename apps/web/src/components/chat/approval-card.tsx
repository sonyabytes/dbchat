import type { MessagePart } from "@dbchat/contracts";
import { AlertTriangle, Check, Loader2, ShieldAlert, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type ApprovalPart = Extract<MessagePart, { _tag: "Approval" }>;

/** Write approval gate — the model proposed a statement, the user decides. */
export function ApprovalCard({
  part,
  connectionName,
  env,
  onDecide,
  onOpenInEditor,
}: {
  part: ApprovalPart;
  connectionName?: string;
  env?: string;
  onDecide: (approve: boolean) => void;
  onOpenInEditor?: (sql: string) => void;
}) {
  const [typed, setTyped] = useState("");
  const isProd = env === "prod";
  /* On production the approve button unlocks only after the connection name is typed. */
  const gated = isProd && Boolean(connectionName) && typed.trim() !== connectionName;
  const pending = part.status === "pending";
  const running = part.status === "approved";
  const done = part.status === "executed";
  const failed = part.status === "failed";
  const rejected = part.status === "rejected";

  return (
    <div
      className={cnRing(part.status)}
      data-approval-status={part.status}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-6 items-center justify-center rounded-sm bg-warning-tint">
          {done ? (
            <Check className="size-3.5 text-success" />
          ) : failed ? (
            <TriangleAlert className="size-3.5 text-danger" />
          ) : running ? (
            <Loader2 className="size-3.5 animate-spin text-brand" />
          ) : (
            <AlertTriangle className="size-3.5 text-warning" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            {done
              ? "Write executed"
              : failed
                ? "Write failed"
                : rejected
                  ? "Write rejected"
                  : running
                    ? "Running in transaction…"
                    : <>Approve write to <span className="font-mono">{connectionName ?? "this database"}</span>?</>}
          </div>
          <p className="mt-0.5 text-xs text-ink-2">
            {part.rowEstimate !== undefined ? (
              <>
                This statement modifies <b>{part.rowEstimate.toLocaleString()}</b> rows. A transaction wraps it; nothing
                commits until it succeeds.
              </>
            ) : (
              <>This statement modifies data. A transaction wraps it; nothing commits until it succeeds.</>
            )}
          </p>
          {isProd && pending && (
            <p className="mt-2 flex items-start gap-1.5 rounded-sm bg-danger-tint px-2 py-1.5 text-[11.5px] font-medium text-danger">
              <ShieldAlert className="mt-px size-3.5 shrink-0" />
              <span>
                <span className="font-mono uppercase tracking-wide">Production</span> — this commits against live data.
                There is no undo.
              </span>
            </p>
          )}
          <pre className="mt-2 overflow-x-auto rounded-sm bg-inset px-2.5 py-2 font-mono text-xs">{part.sql}</pre>
          {isProd && pending && connectionName && (
            <label className="mt-2.5 block">
              <span className="text-[11.5px] text-ink-2">
                Type <span className="font-mono text-ink">{connectionName}</span> to enable the write.
              </span>
              <Input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={connectionName}
                aria-label="Confirm connection name"
                data-testid="approval-name-gate"
                className="mt-1 h-7 font-mono text-xs"
              />
            </label>
          )}
          <div className="mt-2.5 flex items-center gap-1.5">
            {pending ? (
              <>
                <Button size="xs" disabled={gated} onClick={() => onDecide(true)}>
                  <ShieldCheck /> Run in transaction
                </Button>
                {onOpenInEditor && (
                  <Button size="xs" variant="outline" onClick={() => onOpenInEditor(part.sql)}>
                    Edit first
                  </Button>
                )}
                <Button size="xs" variant="ghost" onClick={() => onDecide(false)}>
                  <X /> Reject
                </Button>
              </>
            ) : (
              <span className="text-[11px] text-ink-2">
                {done ? "Committed." : failed ? "Rolled back." : rejected ? "Nothing ran." : "Executing…"}
              </span>
            )}
            <span className="ml-auto font-mono text-[11px] text-ink-3">{env ? `${env} · write` : "write"}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function cnRing(status: ApprovalPart["status"]): string {
  const ring =
    status === "executed"
      ? "ring-success/30"
      : status === "failed"
        ? "ring-danger/30"
        : status === "rejected"
          ? "ring-line-strong"
          : "ring-warning/30";
  return `rounded-lg bg-surface p-3.5 shadow-raised ring-1 ${ring}`;
}
