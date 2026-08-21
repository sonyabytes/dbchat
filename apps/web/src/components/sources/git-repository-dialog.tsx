import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FolderGit2, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { rpcErrorMessage } from "@/rpc/queries";
import { gitRepositoryApi, gitRepositoryKeys } from "@/rpc/git";
import type { GitRepository } from "@dbchat/contracts";

export function GitRepositoryDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (repository: GitRepository) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [branch, setBranch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!path.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const inspection = await gitRepositoryApi.create({ name: name.trim(), path: path.trim(), ...(branch.trim() ? { branch: branch.trim() } : {}) });
      await queryClient.invalidateQueries({ queryKey: gitRepositoryKeys.list });
      onSaved?.(inspection.repository);
      setName("");
      setPath("");
      setBranch("");
      onOpenChange(false);
    } catch (cause) {
      setError(rpcErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Connect Git repository</DialogTitle>
          <DialogDescription>
            dbchat reads SQL, dbt metadata, YAML, and Markdown from a pinned commit. It never modifies the worktree.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="repository-path">Local repository path</FieldLabel>
            <Input id="repository-path" value={path} onChange={(event) => setPath(event.target.value)} placeholder="/Users/me/analytics" autoFocus />
            <FieldDescription>The folder must already be a Git worktree on this machine.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="repository-name">Display name</FieldLabel>
            <Input id="repository-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Defaults to the folder name" />
          </Field>
          <Field>
            <FieldLabel htmlFor="repository-branch">Branch, tag, or commit</FieldLabel>
            <Input id="repository-branch" value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="Current branch" />
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
        </FieldGroup>
        <DialogFooter showCloseButton>
          <Button onClick={() => void save()} disabled={!path.trim() || saving}>
            {saving ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <FolderGit2 data-icon="inline-start" />}
            {saving ? "Inspecting…" : "Connect repository"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
