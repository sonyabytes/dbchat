/**
 * First-open confirm for `env === "prod"` connections.
 *
 * Shown once per connection per browser session (see `lib/prod-guard.ts`); the
 * "Don't ask again this session" checkbox mutes it for every prod connection
 * until the tab is closed.
 */
import type { Connection } from "@dbchat/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useProdGuard } from "@/lib/prod-guard";

export function ProdConfirmDialog({ connection }: { connection: Connection | null }) {
  const navigate = useNavigate();
  const acknowledge = useProdGuard((s) => s.acknowledge);
  const acknowledged = useProdGuard((s) => s.acknowledged);
  const muted = useProdGuard((s) => s.muted);
  const [dontAsk, setDontAsk] = useState(false);

  const isProd = connection?.env === "prod";
  const open = Boolean(isProd && connection && !muted && !acknowledged.has(connection.id));

  /* Fresh checkbox per connection (adjust-during-render, no effect needed). */
  const [lastId, setLastId] = useState(connection?.id ?? "");
  if (lastId !== (connection?.id ?? "")) {
    setLastId(connection?.id ?? "");
    setDontAsk(false);
  }

  if (!connection) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) acknowledge(connection.id, dontAsk);
      }}
    >
      <DialogContent
        showCloseButton={false}
        data-testid="prod-confirm"
        className="sm:max-w-md ring-danger/40"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-danger">
            <ShieldAlert className="size-4" />
            You’re connecting to production
          </DialogTitle>
          <DialogDescription className="text-ink-2">
            <span className="font-mono text-ink">{connection.name}</span> is marked{" "}
            <span className="font-mono uppercase text-danger">prod</span>. AI stays read-only; writes require approval
            and run inside a transaction you have to confirm.
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-1 rounded-md bg-danger-tint px-3 py-2 text-[11.5px] text-danger">
          <li>· Agent queries run in a READ ONLY transaction.</li>
          <li>· Every write is proposed, never executed automatically.</li>
          <li>· Approving a write asks you to type the connection name first.</li>
        </ul>

        <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-2">
          <Checkbox checked={dontAsk} onCheckedChange={(v) => setDontAsk(v === true)} />
          Don’t ask again this session
        </label>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              acknowledge(connection.id, dontAsk);
              void navigate({ to: "/" });
            }}
          >
            Back to connections
          </Button>
          <Button size="sm" onClick={() => acknowledge(connection.id, dontAsk)}>
            I understand
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
