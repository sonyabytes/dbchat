import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { GitRepository } from "@dbchat/contracts";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { threadListKey } from "@/rpc/chat";
import { gitRepositoryApi, gitRepositoryKeys } from "@/rpc/git";
import { rpcErrorMessage } from "@/rpc/queries";

export function DeleteGitRepositoryDialog({ repository, open, onOpenChange }: {
  repository: GitRepository | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    if (!repository || busy) return;
    setBusy(true);
    setError(null);
    try {
      await gitRepositoryApi.remove(repository.id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: gitRepositoryKeys.list }),
        queryClient.invalidateQueries({ queryKey: threadListKey }),
      ]);
      onOpenChange(false);
    } catch (cause) {
      setError(rpcErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]" role="alertdialog">
        <DialogHeader>
          <DialogTitle>Disconnect “{repository?.name}”?</DialogTitle>
          <DialogDescription>The repository is removed from dbchat and detached from conversations. Files and Git history are untouched.</DialogDescription>
        </DialogHeader>
        {error ? <p className="text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="destructive" disabled={busy} onClick={() => void remove()}>{busy ? "Disconnecting…" : "Disconnect"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
