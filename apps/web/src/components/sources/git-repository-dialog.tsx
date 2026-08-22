import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FolderGit2, GitBranch, Loader2, PlugZap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { rpcErrorMessage } from "@/rpc/queries";
import { gitRepositoryApi, gitRepositoryKeys } from "@/rpc/git";
import type { GitHubConnectionTest, GitOrigin, GitRepository } from "@dbchat/contracts";

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
  const [origin, setOrigin] = useState<GitOrigin>("github");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [token, setToken] = useState("");
  const [branch, setBranch] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [probe, setProbe] = useState<GitHubConnectionTest | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName("");
    setPath("");
    setRemoteUrl("");
    setToken("");
    setBranch("");
    setProbe(null);
    setError(null);
  };

  const canSave = origin === "github" ? remoteUrl.trim().length > 0 : path.trim().length > 0;

  const test = async () => {
    if (!remoteUrl.trim() || testing) return;
    setTesting(true);
    setError(null);
    setProbe(null);
    try {
      const result = await gitRepositoryApi.testGitHub({ remoteUrl: remoteUrl.trim(), ...(token.trim() ? { token: token.trim() } : {}) });
      setProbe(result);
      if (!name.trim()) setName(`${result.owner}/${result.repo}`);
    } catch (cause) {
      setError(rpcErrorMessage(cause));
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    setError(null);
    try {
      const trimmedBranch = branch.trim();
      const inspection = await gitRepositoryApi.create(
        origin === "github"
          ? {
              origin: "github",
              name: name.trim(),
              remoteUrl: remoteUrl.trim(),
              ...(token.trim() ? { token: token.trim() } : {}),
              ...(trimmedBranch ? { branch: trimmedBranch } : {}),
            }
          : { origin: "local", name: name.trim(), path: path.trim(), ...(trimmedBranch ? { branch: trimmedBranch } : {}) },
      );
      await queryClient.invalidateQueries({ queryKey: gitRepositoryKeys.list });
      onSaved?.(inspection.repository);
      reset();
      onOpenChange(false);
    } catch (cause) {
      setError(rpcErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Connect Git repository</DialogTitle>
          <DialogDescription>
            dbchat reads SQL, dbt metadata, YAML, and Markdown from a pinned commit. It never writes to the repository.
          </DialogDescription>
        </DialogHeader>
        <Tabs value={origin} onValueChange={(value) => { setOrigin(value as GitOrigin); setError(null); setProbe(null); }}>
          <TabsList className="w-full">
            <TabsTrigger value="github" className="flex-1"><GitBranch data-icon="inline-start" /> GitHub</TabsTrigger>
            <TabsTrigger value="local" className="flex-1"><FolderGit2 data-icon="inline-start" /> Local folder</TabsTrigger>
          </TabsList>

          <TabsContent value="github">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="repository-url">Repository</FieldLabel>
                <Input
                  id="repository-url"
                  value={remoteUrl}
                  onChange={(event) => { setRemoteUrl(event.target.value); setProbe(null); }}
                  placeholder="owner/repo or https://github.com/owner/repo"
                  autoFocus
                />
                <FieldDescription>dbchat keeps its own mirror under its data folder and fetches on refresh.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="repository-token">Personal access token</FieldLabel>
                <Input
                  id="repository-token"
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(event) => { setToken(event.target.value); setProbe(null); }}
                  placeholder="Optional for public repositories"
                />
                <FieldDescription>
                  Needs <code>Contents: read</code> (fine-grained) or <code>repo</code> (classic). Stored encrypted on this machine.
                </FieldDescription>
              </Field>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => void test()} disabled={!remoteUrl.trim() || testing}>
                  {testing ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <PlugZap data-icon="inline-start" />}
                  Test connection
                </Button>
                {probe ? (
                  <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
                    <CheckCircle2 className="size-4 shrink-0 text-green-600" />
                    <span className="truncate">
                      {probe.private ? "Private" : "Public"} · default <code>{probe.defaultBranch}</code>
                      {probe.tokenUser ? ` · as ${probe.tokenUser}` : ""}
                    </span>
                  </span>
                ) : null}
              </div>
            </FieldGroup>
          </TabsContent>

          <TabsContent value="local">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="repository-path">Local repository path</FieldLabel>
                <Input id="repository-path" value={path} onChange={(event) => setPath(event.target.value)} placeholder="/Users/me/analytics" autoFocus />
                <FieldDescription>The folder must already be a Git worktree on this machine.</FieldDescription>
              </Field>
            </FieldGroup>
          </TabsContent>
        </Tabs>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="repository-name">Display name</FieldLabel>
            <Input id="repository-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={origin === "github" ? "Defaults to owner/repo" : "Defaults to the folder name"} />
          </Field>
          <Field>
            <FieldLabel htmlFor="repository-branch">Branch, tag, or commit</FieldLabel>
            <Input id="repository-branch" value={branch} onChange={(event) => setBranch(event.target.value)} placeholder={origin === "github" ? (probe ? probe.defaultBranch : "Remote default branch") : "Current branch"} />
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
        </FieldGroup>
        <DialogFooter showCloseButton>
          <Button onClick={() => void save()} disabled={!canSave || saving}>
            {saving ? <Loader2 data-icon="inline-start" className="animate-spin" /> : origin === "github" ? <GitBranch data-icon="inline-start" /> : <FolderGit2 data-icon="inline-start" />}
            {saving ? (origin === "github" ? "Cloning…" : "Inspecting…") : "Connect repository"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
