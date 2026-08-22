import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, FolderGit2, GitBranch, Pencil, Plus, RefreshCw, Settings2, Trash2 } from "lucide-react";
import type { Connection, GitRepository, SourceRef } from "@dbchat/contracts";

import { ConnectionFormDialog } from "@/components/connections/connection-form-dialog";
import { DeleteConnectionDialog } from "@/components/connections/delete-connection-dialog";
import { GitRepositoryDialog } from "@/components/sources/git-repository-dialog";
import { DeleteGitRepositoryDialog } from "@/components/sources/delete-git-repository-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { isDraftThread } from "@/lib/chat-store";
import { useSources } from "@/lib/source-store";
import { cn } from "@/lib/utils";
import { setThreadSources, threadListKey, threadListQuery } from "@/rpc/chat";
import { gitRepositoryApi, gitRepositoryKeys, gitRepositoryListQuery } from "@/rpc/git";
import { connectionListQuery } from "@/rpc/queries";

const sameSource = (left: SourceRef, right: SourceRef) => left.kind === right.kind && left.id === right.id;

export function SourcePicker({ threadId, compact = false }: { threadId?: string; compact?: boolean }) {
  const queryClient = useQueryClient();
  const [connectionDialog, setConnectionDialog] = useState(false);
  const [editing, setEditing] = useState<Connection | null>(null);
  const [deleting, setDeleting] = useState<Connection | null>(null);
  const [gitDialog, setGitDialog] = useState(false);
  const [deletingRepository, setDeletingRepository] = useState<GitRepository | null>(null);
  const [refreshing, setRefreshing] = useState<GitRepository["id"] | null>(null);
  const { data: connections = [] } = useQuery(connectionListQuery);
  const { data: repositories = [] } = useQuery(gitRepositoryListQuery);
  const { data: threads = [] } = useQuery(threadListQuery);
  const draftSources = useSources((state) => state.draftSources);
  const setDraftSources = useSources((state) => state.setDraftSources);
  const draft = !threadId || isDraftThread(threadId);
  const thread = draft ? undefined : threads.find((candidate) => candidate.id === threadId);
  const selected = draft ? draftSources : (thread?.sources ?? []);

  const save = useMutation({
    mutationFn: (sources: ReadonlyArray<SourceRef>) => threadId && !draft ? setThreadSources(threadId, sources) : Promise.resolve(undefined),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: threadListKey }),
  });

  const update = (sources: ReadonlyArray<SourceRef>) => {
    if (draft) setDraftSources(sources);
    else save.mutate(sources);
  };
  const toggle = (source: SourceRef) => {
    update(selected.some((candidate) => sameSource(candidate, source))
      ? selected.filter((candidate) => !sameSource(candidate, source))
      : [...selected, source]);
  };
  const attachConnection = (connection: Connection) => {
    const source: SourceRef = { kind: "database", id: connection.id };
    if (!selected.some((candidate) => sameSource(candidate, source))) update([...selected, source]);
  };
  /** Refresh failures are persisted server-side as `status`, so the list re-render is the error surface. */
  const refresh = async (repository: GitRepository) => {
    setRefreshing(repository.id);
    try {
      await gitRepositoryApi.refresh(repository.id);
    } catch {
      // status/statusMessage on the row explain what happened.
    } finally {
      await queryClient.invalidateQueries({ queryKey: gitRepositoryKeys.list });
      setRefreshing(null);
    }
  };

  const attachRepository = (repository: GitRepository) => {
    const source: SourceRef = { kind: "git", id: repository.id };
    if (!selected.some((candidate) => sameSource(candidate, source))) update([...selected, source]);
  };

  const labels = selected.map((source) => source.kind === "database"
    ? connections.find((connection) => connection.id === source.id)?.name
    : repositories.find((repository) => repository.id === source.id)?.name,
  ).filter(Boolean);

  return (
    <>
      <Popover>
        <PopoverTrigger render={<Button variant={selected.length > 0 ? "secondary" : "outline"} size={compact ? "xs" : "sm"} />}>
          <Settings2 data-icon="inline-start" />
          Sources
          {selected.length > 0 ? <Badge variant="secondary">{selected.length}</Badge> : null}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 gap-3">
          <PopoverHeader>
            <PopoverTitle>Conversation sources</PopoverTitle>
            <PopoverDescription>Select databases to query and repositories to use as model context.</PopoverDescription>
          </PopoverHeader>

          <FieldGroup className="max-h-80 overflow-auto pr-1">
            <FieldSet>
              <FieldLegend variant="label">Databases</FieldLegend>
              {connections.length === 0 ? <p className="text-muted-foreground">No database connections yet.</p> : null}
              {connections.map((connection) => {
                const source: SourceRef = { kind: "database", id: connection.id };
                const checked = selected.some((candidate) => sameSource(candidate, source));
                return (
                  <div key={connection.id} className="flex items-center gap-1">
                    <Field orientation="horizontal" className="min-w-0 flex-1">
                      <Checkbox id={`source-${connection.id}`} checked={checked} onCheckedChange={() => toggle(source)} disabled={save.isPending} />
                      <FieldLabel htmlFor={`source-${connection.id}`}>
                        <Database />
                        <FieldContent>
                          <span>{connection.name}</span>
                          <span className="font-mono text-muted-foreground">{connection.database || connection.dialect}</span>
                        </FieldContent>
                      </FieldLabel>
                    </Field>
                    <Button variant="ghost" size="icon-xs" aria-label={`Edit ${connection.name}`} onClick={() => { setEditing(connection); setConnectionDialog(true); }}><Pencil /></Button>
                    <Button variant="ghost" size="icon-xs" aria-label={`Delete ${connection.name}`} onClick={() => setDeleting(connection)}><Trash2 /></Button>
                  </div>
                );
              })}
              <Button variant="ghost" size="sm" onClick={() => setConnectionDialog(true)}>
                <Plus data-icon="inline-start" /> Connect database
              </Button>
            </FieldSet>

            <Separator />

            <FieldSet>
              <FieldLegend variant="label">Git repositories</FieldLegend>
              {repositories.length === 0 ? <p className="text-muted-foreground">No repositories connected yet.</p> : null}
              {repositories.map((repository) => {
                const source: SourceRef = { kind: "git", id: repository.id };
                const checked = selected.some((candidate) => sameSource(candidate, source));
                return (
                  <div key={repository.id} className="flex items-center gap-1">
                    <Field orientation="horizontal" className="min-w-0 flex-1">
                      <Checkbox id={`source-${repository.id}`} checked={checked} onCheckedChange={() => toggle(source)} disabled={save.isPending} />
                      <FieldLabel htmlFor={`source-${repository.id}`}>
                        {repository.origin === "github" ? <GitBranch /> : <FolderGit2 />}
                        <FieldContent className="min-w-0">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate">{repository.name}</span>
                            <GitStatusDot repository={repository} />
                          </span>
                          <span className="truncate font-mono text-muted-foreground">{repository.branch} · {repository.headCommit.slice(0, 8)}{repository.lastFetchedAt ? ` · fetched ${relativeTime(repository.lastFetchedAt)}` : ""}</span>
                        </FieldContent>
                      </FieldLabel>
                    </Field>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`${repository.origin === "github" ? "Fetch" : "Refresh"} ${repository.name}`}
                      disabled={refreshing === repository.id}
                      onClick={() => void refresh(repository)}
                    >
                      <RefreshCw className={refreshing === repository.id ? "animate-spin" : undefined} />
                    </Button>
                    <Button variant="ghost" size="icon-xs" aria-label={`Remove ${repository.name}`} onClick={() => setDeletingRepository(repository)}>
                      <Trash2 />
                    </Button>
                  </div>
                );
              })}
              <Button variant="ghost" size="sm" onClick={() => setGitDialog(true)}>
                <Plus data-icon="inline-start" /> Connect Git repository
              </Button>
            </FieldSet>
          </FieldGroup>

          <p className={cn("text-muted-foreground", labels.length === 0 && "italic")}>
            {labels.length > 0 ? `Using ${labels.join(", ")}` : "This chat currently has no external data context."}
          </p>
        </PopoverContent>
      </Popover>

      <ConnectionFormDialog open={connectionDialog} onOpenChange={(open) => { setConnectionDialog(open); if (!open) setEditing(null); }} connection={editing} onSaved={attachConnection} />
      <DeleteConnectionDialog connection={deleting} open={deleting !== null} onOpenChange={(open) => { if (!open) setDeleting(null); }} />
      <GitRepositoryDialog open={gitDialog} onOpenChange={setGitDialog} onSaved={attachRepository} />
      <DeleteGitRepositoryDialog repository={deletingRepository} open={deletingRepository !== null} onOpenChange={(open) => { if (!open) setDeletingRepository(null); }} />
    </>
  );
}

const STATUS_LABEL: Record<GitRepository["status"], string> = {
  connected: "Connected",
  unauthorized: "Token rejected",
  "not-found": "Repository not found",
  offline: "Remote unreachable",
  error: "Sync failed",
};

function GitStatusDot({ repository }: { repository: GitRepository }) {
  if (repository.origin !== "github") return null;
  const ok = repository.status === "connected";
  const title = repository.statusMessage ?? STATUS_LABEL[repository.status];
  return (
    <span
      role="img"
      aria-label={STATUS_LABEL[repository.status]}
      title={title}
      className={cn("size-1.5 shrink-0 rounded-full", ok ? "bg-green-500" : "bg-destructive")}
    />
  );
}

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
