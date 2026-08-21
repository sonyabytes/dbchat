import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Database, Loader2, Moon, MoreHorizontal, Pencil, Plug, PlugZap, Plus, Search, Settings as SettingsIcon, Sun, Trash2 } from "lucide-react";
import type { Connection, ConnectionStatus } from "@dbchat/contracts";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { ConnectionFormDialog } from "@/components/connections/connection-form-dialog";
import { DeleteConnectionDialog } from "@/components/connections/delete-connection-dialog";
import { DialectIcon, EnvBadge, Eyebrow, StatusDot } from "@/components/shared/primitives";
import { relativeTime } from "@/lib/format";
import { usePalette } from "@/lib/palette";
import { toggleTheme } from "@/lib/settings";
import { useApp } from "@/lib/store";
import { connectionApi, connectionConnectQuery, connectionKeys } from "@/rpc/connections";
import { connectionListQuery, rpcErrorMessage } from "@/rpc/queries";

type RowState = { state: ConnectionStatus["state"] | "connecting"; latencyMs?: number; error?: string };

function target(c: Connection) {
  return c.dialect === "sqlite" ? c.database : `${c.user}@${c.host}:${c.port}/${c.database}`;
}

function ConnectionRow({
  c, status, onOpen, onEdit, onDelete, onDisconnect,
}: {
  c: Connection;
  status: RowState;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onDisconnect: () => void;
}) {
  const connecting = status.state === "connecting";
  return (
    <div className="group rounded-md transition-colors hover:bg-hover">
      <div className="flex w-full items-center gap-3 px-3 py-2.5">
        <button type="button" onClick={onOpen} disabled={connecting} className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left disabled:cursor-default">
          <span className="size-2 shrink-0 rounded-full" style={{ background: c.color }} />
          <DialectIcon dialect={c.dialect} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="font-medium">{c.name}</span>
              <EnvBadge env={c.env} />
            </span>
            <span className="block truncate font-mono text-[11.5px] text-ink-3">{target(c)}</span>
          </span>
          <span className="flex shrink-0 items-center gap-2 text-[11.5px] text-ink-3">
            {connecting ? <Loader2 className="size-3 animate-spin text-brand" /> : <StatusDot status={status.state as "connected" | "idle" | "error"} />}
            <span className="w-16 text-right">
              {connecting ? "connecting" : status.state === "connected" && status.latencyMs !== undefined ? `${Math.round(status.latencyMs)}ms` : relativeTime(c.lastUsedAt)}
            </span>
          </span>
          <span className="hidden shrink-0 text-xs text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 sm:inline">Open →</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`Actions for ${c.name}`} />}>
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={onOpen}><PlugZap /> Connect &amp; open</DropdownMenuItem>
            <DropdownMenuItem onClick={onEdit}><Pencil /> Edit…</DropdownMenuItem>
            <DropdownMenuItem onClick={onDisconnect} disabled={status.state !== "connected"}><Plug /> Disconnect</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}><Trash2 /> Delete…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {status.state === "error" && status.error && (
        <div className="mx-3 mb-2 flex items-start gap-2 rounded-md bg-danger-tint px-2.5 py-1.5 text-[11.5px] text-danger">
          <span className="min-w-0 flex-1 break-words">{status.error}</span>
          <button type="button" className="shrink-0 font-medium hover:underline" onClick={onOpen}>Retry</button>
        </div>
      )}
    </div>
  );
}

function ConnectionRowSkeleton() {
  return (
    <div className="flex w-full items-center gap-3 rounded-md px-3 py-2.5">
      <Skeleton className="size-2 rounded-full" />
      <Skeleton className="size-4 rounded-sm" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <Skeleton className="h-3.5 w-32" />
        <Skeleton className="h-3 w-56" />
      </div>
      <Skeleton className="h-3 w-16" />
    </div>
  );
}

export function ConnectionsScreen() {
  const dark = useApp((s) => s.dark);
  const openPalette = usePalette((s) => s.setOpen);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [statuses, setStatuses] = useState<Record<string, RowState>>({});
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Connection | null>(null);
  const [deleting, setDeleting] = useState<Connection | null>(null);

  const { data: connections, isPending, error, refetch } = useQuery(connectionListQuery);

  const statusOf = (c: Connection): RowState => {
    const local = statuses[c.id];
    if (local) return local;
    const cached = queryClient.getQueryData(connectionKeys.connect(c.id)) as ConnectionStatus | undefined;
    return cached ? { state: cached.state, ...(cached.latencyMs !== undefined ? { latencyMs: cached.latencyMs } : {}) } : { state: "idle" };
  };

  /** Connect first; only navigate into the workspace once the driver is live. */
  const open = async (c: Connection) => {
    setStatuses((s) => ({ ...s, [c.id]: { state: "connecting" } }));
    try {
      const status = await queryClient.fetchQuery(connectionConnectQuery(c.id));
      if (status.state === "error") {
        setStatuses((s) => ({ ...s, [c.id]: { state: "error", error: status.error ?? "Could not connect" } }));
        return;
      }
      setStatuses((s) => ({ ...s, [c.id]: { state: "connected", ...(status.latencyMs !== undefined ? { latencyMs: status.latencyMs } : {}) } }));
      void queryClient.invalidateQueries({ queryKey: connectionKeys.list });
      void navigate({ to: "/c/$connectionId/chat/$threadId", params: { connectionId: c.id, threadId: "home" } });
    } catch (e) {
      setStatuses((s) => ({ ...s, [c.id]: { state: "error", error: rpcErrorMessage(e) } }));
    }
  };

  const disconnect = async (c: Connection) => {
    try {
      await connectionApi.disconnect(c.id);
    } catch {
      /* already gone — fall through to the idle state */
    }
    queryClient.removeQueries({ queryKey: connectionKeys.connect(c.id) });
    setStatuses((s) => ({ ...s, [c.id]: { state: "idle" } }));
  };

  const list = (connections ?? []).filter((c) => {
    const needle = q.toLowerCase();
    return !needle || c.name.toLowerCase().includes(needle) || target(c).toLowerCase().includes(needle);
  });
  const recent = list.slice(0, 2);
  const rest = list.slice(2);

  const row = (c: Connection) => (
    <ConnectionRow
      key={c.id}
      c={c}
      status={statusOf(c)}
      onOpen={() => void open(c)}
      onEdit={() => { setEditing(c); setFormOpen(true); }}
      onDelete={() => setDeleting(c)}
      onDisconnect={() => void disconnect(c)}
    />
  );

  return (
    <div className="flex h-full flex-col">
      <header data-app-drag="inset" className="flex h-12 items-center gap-2 px-4">
        <Database className="size-4 text-ink-2" />
        <span className="font-semibold tracking-tight">dbchat</span>
        <span className="text-ink-3">/</span>
        <span className="text-ink-2">Connections</span>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" onClick={() => void navigate({ to: "/settings" })} aria-label="Settings"><SettingsIcon /></Button>
          <Button variant="ghost" size="icon-sm" onClick={toggleTheme} aria-label="Toggle theme">{dark ? <Sun /> : <Moon />}</Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 pb-16 pt-10">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Where are we working today?</h1>
          <p className="mt-1 text-ink-2">Pick a database, then chat, browse tables, or write SQL.</p>
        </div>

        <div className="mb-3 flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search connections" className="pl-8" />
            <button
              type="button"
              onClick={() => openPalette(true)}
              aria-label="Open command palette"
              className="absolute right-2 top-1/2 -translate-y-1/2"
            >
              <Kbd className="hover:text-ink">⌘K</Kbd>
            </button>
          </div>
          <Button size="sm" onClick={() => { setEditing(null); setFormOpen(true); }}><Plus /> New connection</Button>
        </div>

        <div className="rounded-lg bg-surface p-1.5 shadow-card">
          {isPending && (
            <>
              <Eyebrow className="px-3 pb-1 pt-2">Recent</Eyebrow>
              <ConnectionRowSkeleton /><ConnectionRowSkeleton />
              <Eyebrow className="px-3 pb-1 pt-3">All</Eyebrow>
              <ConnectionRowSkeleton /><ConnectionRowSkeleton />
            </>
          )}
          {error && !isPending && (
            <div className="p-8 text-center text-sm text-ink-3">
              Can’t reach the dbchat server. <button type="button" className="text-brand hover:underline" onClick={() => void refetch()}>Retry</button>
            </div>
          )}
          {recent.length > 0 && <Eyebrow className="px-3 pb-1 pt-2">Recent</Eyebrow>}
          {recent.map(row)}
          {rest.length > 0 && <Eyebrow className="px-3 pb-1 pt-3">All</Eyebrow>}
          {rest.map(row)}
          {!isPending && !error && list.length === 0 && (
            <div className="p-8 text-center text-sm text-ink-3">
              {q ? <>No connections match “{q}”.</> : <>No connections yet — add one to get started.</>}
            </div>
          )}
        </div>

        <p className="mt-4 text-center text-xs text-ink-3">Credentials are encrypted at rest on this machine and never sent to the model. Tip: <span className="font-mono">“connect to postgres on localhost”</span></p>
      </main>

      <ConnectionFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        connection={editing}
        onSaved={(c, isNew) => { setEditing(null); if (isNew) void open(c); }}
      />
      <DeleteConnectionDialog connection={deleting} open={deleting !== null} onOpenChange={(o) => { if (!o) setDeleting(null); }} />
    </div>
  );
}
