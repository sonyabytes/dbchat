import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

import { type Tab, tabPath, useApp } from "./store";

/** Current connection id from the /c/$connectionId route subtree. */
export function useConnectionId(): string {
  const params = useParams({ strict: false }) as { connectionId?: string };
  return params.connectionId ?? "";
}

/**
 * Opens a tab in the store AND navigates to its route.
 * `search` is optional and passed through to the route (e.g. `{ context: "public.users" }`).
 */
export function useOpenTab() {
  const navigate = useNavigate();
  const connectionId = useConnectionId();
  const openTab = useApp((s) => s.openTab);
  return useCallback(
    (t: Tab, search?: Record<string, string>) => {
      openTab(t, connectionId);
      void navigate({ to: tabPath(connectionId, t), ...(search ? { search: search as never } : {}) });
    },
    [navigate, connectionId, openTab],
  );
}

/** Leaf routes call this so a directly-visited URL shows up as a tab. */
export function useRegisterTab(t: Tab) {
  const openTab = useApp((s) => s.openTab);
  const connectionId = useConnectionId();
  useEffect(() => {
    openTab(t, connectionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.id, connectionId, "title" in t ? t.title : ""]);
}

/** Closes a tab and navigates to whichever tab becomes active (or the connection index). */
export function useCloseTab() {
  const navigate = useNavigate();
  const connectionId = useConnectionId();
  const closeTab = useApp((s) => s.closeTab);
  const activeTab = useApp((s) => s.activeTab);
  return useCallback(
    (id: string) => {
      const wasActive = activeTab === id;
      const next = closeTab(id);
      if (!wasActive) return;
      void navigate({ to: next ? tabPath(connectionId, next) : `/c/${encodeURIComponent(connectionId)}` });
    },
    [navigate, connectionId, closeTab, activeTab],
  );
}
