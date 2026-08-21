/**
 * Router-level fallbacks: a crash page and a 404 page, plus the "this connection
 * doesn't exist" page the workspace shows. All three keep the app chrome usable
 * so a bad URL never leaves a blank screen.
 */
import { Link } from "@tanstack/react-router";
import { Compass, RotateCw, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { rpcErrorMessage } from "@/rpc/queries";

function Shell({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center px-6 py-10">
      <div className="w-full max-w-md rounded-lg bg-surface p-6 text-center shadow-card">
        <span className="mx-auto mb-3 flex size-9 items-center justify-center rounded-md bg-inset text-ink-2">{icon}</span>
        <h1 className="text-base font-semibold tracking-tight">{title}</h1>
        {children}
      </div>
    </div>
  );
}

/** Root `errorComponent` — any uncaught render/loader error lands here. */
export function RouteErrorPage({ error, reset }: { error: unknown; reset?: () => void }) {
  const message = rpcErrorMessage(error);
  return (
    <Shell icon={<TriangleAlert className="size-4 text-danger" />} title="Something broke">
      <p className="mt-1 text-xs text-ink-2">This screen failed to render. The rest of the app is still fine.</p>
      <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-danger-tint px-3 py-2 text-left font-mono text-[11px] text-danger">
        {message}
      </pre>
      <div className="mt-4 flex items-center justify-center gap-2">
        <Button
          size="sm"
          onClick={() => {
            reset?.();
            window.location.reload();
          }}
        >
          <RotateCw /> Reload
        </Button>
        <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/" />}>
          All connections
        </Button>
      </div>
    </Shell>
  );
}

/** Root `notFoundComponent`. */
export function NotFoundPage() {
  return (
    <Shell icon={<Compass className="size-4 text-ink-2" />} title="Page not found">
      <p className="mt-1 text-xs text-ink-2">That URL doesn’t match anything in dbchat.</p>
      <div className="mt-4 flex items-center justify-center gap-2">
        <Button size="sm" nativeButton={false} render={<Link to="/" />}>
          All connections
        </Button>
        <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/settings" />}>
          Settings
        </Button>
      </div>
    </Shell>
  );
}

/** Shown by the workspace when `/c/$connectionId` points at a connection that is gone. */
export function ConnectionNotFound({ connectionId }: { connectionId: string }) {
  return (
    <Shell icon={<Compass className="size-4 text-ink-2" />} title="Connection not found">
      <p className="mt-1 text-xs text-ink-2">
        No connection with id <span className="font-mono text-ink">{connectionId}</span>. It may have been deleted.
      </p>
      <div className="mt-4 flex items-center justify-center gap-2">
        <Button size="sm" nativeButton={false} render={<Link to="/" />}>
          All connections
        </Button>
      </div>
    </Shell>
  );
}
