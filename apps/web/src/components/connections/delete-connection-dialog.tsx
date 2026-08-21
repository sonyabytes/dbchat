/** Confirm destructive delete. (No AlertDialog in components/ui — Dialog + danger button.) */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Connection } from "@dbchat/contracts";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useApp } from "@/lib/store";
import { connectionApi, connectionKeys } from "@/rpc/connections";
import { rpcErrorMessage } from "@/rpc/queries";

export function DeleteConnectionDialog({
  connection, open, onOpenChange,
}: {
  connection: Connection | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (!connection) return;
    setBusy(true);
    setError(null);
    try {
      await connectionApi.remove(connection.id);
      useApp.getState().removeConnectionWorkspace(connection.id);
      await queryClient.invalidateQueries({ queryKey: connectionKeys.list });
      queryClient.removeQueries({ queryKey: connectionKeys.connect(connection.id) });
      onOpenChange(false);
    } catch (e) {
      setError(rpcErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]" role="alertdialog">
        <DialogHeader>
          <DialogTitle>Delete “{connection?.name}”?</DialogTitle>
          <DialogDescription>
            This permanently removes the stored credentials, saved queries, query history, and chats for this
            connection from dbchat. The database itself is untouched.
          </DialogDescription>
        </DialogHeader>
        {error && <div className="rounded-md bg-danger-tint px-3 py-2 text-xs text-danger">{error}</div>}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="destructive" size="sm" disabled={busy} onClick={() => void confirm()}>
            {busy ? "Deleting…" : "Delete connection"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
