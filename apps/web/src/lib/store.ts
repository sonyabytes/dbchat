import { create } from "zustand";
import type { Connection } from "@dbchat/contracts";

/** A tab mirrors an opened workspace route. `id` is stable per route target. */
export type Tab =
  | { id: string; kind: "table"; schema: string; table: string }
  | { id: string; kind: "sql"; queryId: string; title: string }
  | { id: string; kind: "chat"; threadId: string; title: string };

export const tabIds = {
  table: (schema: string, table: string) => `table:${schema}.${table}`,
  sql: (queryId: string) => `sql:${queryId}`,
  chat: (threadId: string) => `chat:${threadId}`,
};

/** Route path for a tab inside a connection workspace. */
export function tabPath(connectionId: string, t: Tab): string {
  const base = `/c/${encodeURIComponent(connectionId)}`;
  if (t.kind === "table") return `${base}/t/${encodeURIComponent(t.schema)}/${encodeURIComponent(t.table)}`;
  if (t.kind === "sql") return `${base}/sql/${encodeURIComponent(t.queryId)}`;
  return `${base}/chat/${encodeURIComponent(t.threadId)}`;
}

interface AppState {
  /** Connection of the active workspace (set by the /c/$connectionId layout route). */
  connection: Connection | null;
  /** Which connection the current tab set belongs to; opening a tab for another connection starts fresh. */
  tabsConnectionId: string | null;
  tabs: Tab[];
  activeTab: string | null;
  rightPanel: "chat" | "schema" | null;
  dark: boolean;
  setConnection: (c: Connection | null) => void;
  /** Add (if missing) and activate. Does NOT navigate — use `useOpenTab` from lib/nav. */
  openTab: (t: Tab, connectionId: string) => void;
  /** Rename a sql/chat tab in place (thread titles arrive after the first message). */
  renameTab: (id: string, title: string) => void;
  /** Remove a tab; returns the tab that should become active (or null). */
  closeTab: (id: string) => Tab | null;
  setActive: (id: string | null) => void;
  resetTabs: () => void;
  setRightPanel: (p: AppState["rightPanel"]) => void;
  /** Resolved theme mirror — written by `lib/settings.ts`, read by CodeMirror. */
  setDark: (d: boolean) => void;
}

export const useApp = create<AppState>((set, get) => ({
  connection: null,
  tabsConnectionId: null,
  tabs: [],
  activeTab: null,
  rightPanel: "chat",
  dark: document.documentElement.classList.contains("dark"),
  setConnection: (c) => set({ connection: c }),
  openTab: (t, connectionId) => {
    const tabs = get().tabsConnectionId === connectionId ? get().tabs : [];
    if (get().tabsConnectionId !== connectionId) set({ tabsConnectionId: connectionId, tabs: [] });
    const existing = tabs.find((x) => x.id === t.id);
    if (!existing) set({ tabs: [...tabs, t], activeTab: t.id });
    else if (existing !== t && JSON.stringify(existing) !== JSON.stringify(t)) set({ tabs: tabs.map((x) => (x.id === t.id ? t : x)), activeTab: t.id });
    else set({ activeTab: t.id });
  },
  renameTab: (id, title) =>
    set((s) => {
      const t = s.tabs.find((x) => x.id === id);
      if (!t || t.kind === "table" || t.title === title || !title) return s;
      return { tabs: s.tabs.map((x) => (x.id === id ? { ...x, title } : x)) };
    }),
  closeTab: (id) => {
    const { tabs, activeTab } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    const nextActive = activeTab === id ? (next[idx - 1] ?? next[0] ?? null) : (next.find((t) => t.id === activeTab) ?? null);
    set({ tabs: next, activeTab: nextActive?.id ?? null });
    return activeTab === id ? nextActive : null;
  },
  setActive: (id) => set({ activeTab: id }),
  resetTabs: () => set({ tabs: [], activeTab: null, tabsConnectionId: null }),
  setRightPanel: (p) => set({ rightPanel: p }),
  setDark: (d) => set({ dark: d }),
}));
