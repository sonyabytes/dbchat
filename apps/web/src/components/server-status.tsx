/**
 * Server reachability banner.
 *
 * Polls `server.health` every 5s. The RPC socket reconnects on its own
 * (`retryTransientErrors`), so a failed poll only means "not right now" — we show
 * a banner instead of letting individual screens throw.
 */
import { RPC } from "@dbchat/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, WifiOff } from "lucide-react";
import { useEffect, useRef } from "react";

import { callRpc } from "@/rpc/client";

const HEALTH_KEY = ["server.health", "poll"] as const;
const HEALTH_TIMEOUT_MS = 3_000;

export function useServerHealth() {
  const query = useQuery({
    queryKey: HEALTH_KEY,
    queryFn: async () => {
      // Hard deadline: a dead socket queues requests instead of rejecting, and the
      // abort interrupts the fiber so polls never pile up.
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), HEALTH_TIMEOUT_MS);
      try {
        return await callRpc((c) => c[RPC.serverHealth](), { signal: ctl.signal });
      } finally {
        clearTimeout(timer);
      }
    },
    refetchInterval: 5_000,
    refetchIntervalInBackground: true,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  return { ...query, down: query.isError };
}

export function ServerStatusBanner() {
  const { down } = useServerHealth();
  const qc = useQueryClient();
  const wasDown = useRef(false);

  /* Coming back up: refetch everything the screens are showing. */
  useEffect(() => {
    if (down) {
      wasDown.current = true;
      return;
    }
    if (wasDown.current) {
      wasDown.current = false;
      void qc.invalidateQueries();
    }
  }, [down, qc]);

  if (!down) return null;
  return (
    <div
      role="status"
      data-testid="server-down-banner"
      className="flex h-8 shrink-0 items-center justify-center gap-2 bg-danger-tint px-3 text-xs font-medium text-danger"
    >
      <WifiOff className="size-3.5" />
      <span>Server unreachable — retrying…</span>
      <Loader2 className="size-3 animate-spin opacity-70" />
    </div>
  );
}
