import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Connection } from "@dbchat/contracts";

/** A tab mirrors an opened workspace route. `id` is stable per route target. */
export type Tab =
  | { id: string; kind: "table"; schema: string; table: string }
  | { id: string; kind: "sql"; queryId: string; title: string }
  | { id: string; kind: "chat"; threadId: string; title: string };

/** A data surface opened beside a work item's conversation. */
export type DataTab =
  | { id: string; kind: "table"; connectionId: string; schema: string; table: string }
  | { id: string; kind: "sql"; connectionId: string; queryId: string; title: string; initialSql?: string };

export const tabIds = {
  table: (schema: string, table: string) => `table:${schema}.${table}`,
  sql: (queryId: string) => `sql:${queryId}`,
  chat: (threadId: string) => `chat:${threadId}`,
};

export const dataTabIds = {
  table: (connectionId: string, schema: string, table: string) => `data:${connectionId}:table:${schema}.${table}`,
  sql: (connectionId: string, queryId: string) => `data:${connectionId}:sql:${queryId}`,
};

export const GLOBAL_WORKSPACE_ID = "global";

/** Route path for a tab inside a connection workspace. */
export function tabPath(connectionId: string, t: Tab): string {
  if (t.kind === "chat") return `/chat/${encodeURIComponent(t.threadId)}`;
  const base = `/c/${encodeURIComponent(connectionId)}`;
  if (t.kind === "table") return `${base}/t/${encodeURIComponent(t.schema)}/${encodeURIComponent(t.table)}`;
  return `${base}/sql/${encodeURIComponent(t.queryId)}`;
}

interface ConnectionWorkspace {
  tabs: Tab[];
  activeTab: string | null;
}

interface DataWorkspace {
  tabs: DataTab[];
  activeTab: string | null;
  /** Explorer and layout preferences belong to this work item, not the app globally. */
  explorerFilter?: string;
  focused?: boolean;
}

const emptyWorkspace = (): ConnectionWorkspace => ({ tabs: [], activeTab: null });
const emptyDataWorkspace = (): DataWorkspace => ({ tabs: [], activeTab: null });

interface AppState {
  /** Connection of the active workspace (set by the /c/$connectionId layout route). */
  connection: Connection | null;
  /** Which connection the projected `tabs` / `activeTab` values belong to. */
  tabsConnectionId: string | null;
  tabs: Tab[];
  activeTab: string | null;
  /** Lightweight workspace state retained independently for each connection. */
  workspaces: Record<string, ConnectionWorkspace>;
  /** Unsaved SQL buffers, keyed by connection and query/tab id. */
  sqlDrafts: Record<string, Record<string, string>>;
  /** Table and SQL surfaces retained independently for each work item. */
  dataWorkspaces: Record<string, DataWorkspace>;
  rightPanel: "chat" | "schema" | null;
  dark: boolean;
  setConnection: (c: Connection | null) => void;
  setGlobalWorkspace: () => void;
  /** Add (if missing) and activate. Does NOT navigate — use `useOpenTab` from lib/nav. */
  openTab: (t: Tab, connectionId: string) => void;
  /** Rename a sql/chat tab in place (thread titles arrive after the first message). */
  renameTab: (id: string, title: string) => void;
  /** Remove a tab; returns the tab that should become active (or null). */
  closeTab: (id: string) => Tab | null;
  setActive: (id: string | null) => void;
  resetTabs: () => void;
  restorableTab: (connectionId: string) => Tab | null;
  setSqlDraft: (connectionId: string, queryId: string, sql: string) => void;
  getSqlDraft: (connectionId: string, queryId: string) => string | undefined;
  clearSqlDraft: (connectionId: string, queryId: string) => void;
  openDataTab: (workItemId: string, tab: DataTab) => void;
  closeDataTab: (workItemId: string, tabId: string) => void;
  setActiveDataTab: (workItemId: string, tabId: string | null) => void;
  setDataExplorerFilter: (workItemId: string, filter: string) => void;
  setDataWorkspaceFocused: (workItemId: string, focused: boolean) => void;
  moveDataWorkspace: (fromWorkItemId: string, toWorkItemId: string) => void;
  removeDataWorkspace: (workItemId: string) => void;
  removeConnectionWorkspace: (connectionId: string) => void;
  setRightPanel: (p: AppState["rightPanel"]) => void;
  /** Resolved theme mirror — written by `lib/settings.ts`, read by CodeMirror. */
  setDark: (d: boolean) => void;
}

export const useApp = create<AppState>()(
  persist(
    (set, get) => ({
      connection: null,
      tabsConnectionId: null,
      tabs: [],
      activeTab: null,
      workspaces: {},
      sqlDrafts: {},
      dataWorkspaces: {},
      rightPanel: null,
      dark: document.documentElement.classList.contains("dark"),
      setConnection: (c) => {
        if (!c) {
          set({ connection: null });
          return;
        }
        const workspace = get().workspaces[c.id] ?? emptyWorkspace();
        set({
          connection: c,
          tabsConnectionId: c.id,
          tabs: workspace.tabs,
          activeTab: workspace.activeTab,
        });
      },
      setGlobalWorkspace: () => {
        const workspace = get().workspaces[GLOBAL_WORKSPACE_ID] ?? emptyWorkspace();
        set({
          connection: null,
          tabsConnectionId: GLOBAL_WORKSPACE_ID,
          tabs: workspace.tabs.filter((tab) => tab.kind === "chat"),
          activeTab: workspace.tabs.some((tab) => tab.id === workspace.activeTab && tab.kind === "chat")
            ? workspace.activeTab
            : workspace.tabs.find((tab) => tab.kind === "chat")?.id ?? null,
        });
      },
      openTab: (t, connectionId) => {
        const state = get();
        const workspace =
          state.tabsConnectionId === connectionId
            ? { tabs: state.tabs, activeTab: state.activeTab }
            : (state.workspaces[connectionId] ?? emptyWorkspace());
        const existing = workspace.tabs.find((x) => x.id === t.id);
        const tabs = existing
          ? workspace.tabs.map((x) => (x.id === t.id && JSON.stringify(x) !== JSON.stringify(t) ? t : x))
          : [...workspace.tabs, t];
        const next = { tabs, activeTab: t.id };
        set({
          tabsConnectionId: connectionId,
          tabs: next.tabs,
          activeTab: next.activeTab,
          workspaces: { ...state.workspaces, [connectionId]: next },
        });
      },
      renameTab: (id, title) =>
        set((s) => {
          const t = s.tabs.find((x) => x.id === id);
          if (!t || t.kind === "table" || t.title === title || !title || !s.tabsConnectionId) return s;
          const tabs = s.tabs.map((x) => (x.id === id ? { ...x, title } : x));
          return {
            tabs,
            workspaces: {
              ...s.workspaces,
              [s.tabsConnectionId]: { tabs, activeTab: s.activeTab },
            },
          };
        }),
      closeTab: (id) => {
        const { tabs, activeTab, tabsConnectionId, workspaces } = get();
        const idx = tabs.findIndex((t) => t.id === id);
        const next = tabs.filter((t) => t.id !== id);
        const nextActive =
          activeTab === id
            ? (next[idx - 1] ?? next[0] ?? null)
            : (next.find((t) => t.id === activeTab) ?? null);
        const activeTabId = nextActive?.id ?? null;
        set({
          tabs: next,
          activeTab: activeTabId,
          ...(tabsConnectionId
            ? { workspaces: { ...workspaces, [tabsConnectionId]: { tabs: next, activeTab: activeTabId } } }
            : {}),
        });
        return activeTab === id ? nextActive : null;
      },
      setActive: (id) =>
        set((s) => ({
          activeTab: id,
          ...(s.tabsConnectionId
            ? {
                workspaces: {
                  ...s.workspaces,
                  [s.tabsConnectionId]: { tabs: s.tabs, activeTab: id },
                },
              }
            : {}),
        })),
      resetTabs: () =>
        set((s) => {
          if (!s.tabsConnectionId) return { tabs: [], activeTab: null };
          return {
            tabs: [],
            activeTab: null,
            workspaces: { ...s.workspaces, [s.tabsConnectionId]: emptyWorkspace() },
          };
        }),
      restorableTab: (connectionId) => {
        const workspace = get().workspaces[connectionId];
        if (!workspace) return null;
        return workspace.tabs.find((t) => t.id === workspace.activeTab) ?? workspace.tabs[0] ?? null;
      },
      setSqlDraft: (connectionId, queryId, sql) =>
        set((s) => ({
          sqlDrafts: {
            ...s.sqlDrafts,
            [connectionId]: { ...s.sqlDrafts[connectionId], [queryId]: sql },
          },
        })),
      getSqlDraft: (connectionId, queryId) => get().sqlDrafts[connectionId]?.[queryId],
      clearSqlDraft: (connectionId, queryId) =>
        set((s) => {
          const connectionDrafts = s.sqlDrafts[connectionId];
          if (!connectionDrafts || !(queryId in connectionDrafts)) return s;
          const { [queryId]: _removed, ...remaining } = connectionDrafts;
          const { [connectionId]: _connectionDrafts, ...otherDrafts } = s.sqlDrafts;
          return {
            sqlDrafts:
              Object.keys(remaining).length > 0
                ? { ...otherDrafts, [connectionId]: remaining }
                : otherDrafts,
          };
        }),
      openDataTab: (workItemId, tab) =>
        set((s) => {
          const workspace = s.dataWorkspaces[workItemId] ?? emptyDataWorkspace();
          const existing = workspace.tabs.find((candidate) => candidate.id === tab.id);
          const tabs = existing
            ? workspace.tabs.map((candidate) => candidate.id === tab.id ? tab : candidate)
            : [...workspace.tabs, tab];
          return {
            dataWorkspaces: {
              ...s.dataWorkspaces,
              [workItemId]: { ...workspace, tabs, activeTab: tab.id },
            },
          };
        }),
      closeDataTab: (workItemId, tabId) =>
        set((s) => {
          const workspace = s.dataWorkspaces[workItemId];
          if (!workspace) return s;
          const index = workspace.tabs.findIndex((tab) => tab.id === tabId);
          if (index === -1) return s;
          const tabs = workspace.tabs.filter((tab) => tab.id !== tabId);
          const activeTab = workspace.activeTab === tabId
            ? (tabs[index - 1] ?? tabs[0])?.id ?? null
            : workspace.activeTab;
          return {
            dataWorkspaces: {
              ...s.dataWorkspaces,
              [workItemId]: { ...workspace, tabs, activeTab },
            },
          };
        }),
      setActiveDataTab: (workItemId, tabId) =>
        set((s) => {
          const workspace = s.dataWorkspaces[workItemId] ?? emptyDataWorkspace();
          if (workspace.activeTab === tabId) return s;
          return {
            dataWorkspaces: {
              ...s.dataWorkspaces,
              [workItemId]: { ...workspace, activeTab: tabId },
            },
          };
        }),
      setDataExplorerFilter: (workItemId, filter) =>
        set((s) => {
          const workspace = s.dataWorkspaces[workItemId] ?? emptyDataWorkspace();
          if ((workspace.explorerFilter ?? "") === filter) return s;
          return {
            dataWorkspaces: {
              ...s.dataWorkspaces,
              [workItemId]: { ...workspace, explorerFilter: filter },
            },
          };
        }),
      setDataWorkspaceFocused: (workItemId, focused) =>
        set((s) => {
          const workspace = s.dataWorkspaces[workItemId] ?? emptyDataWorkspace();
          if ((workspace.focused ?? false) === focused) return s;
          return {
            dataWorkspaces: {
              ...s.dataWorkspaces,
              [workItemId]: { ...workspace, focused },
            },
          };
        }),
      moveDataWorkspace: (fromWorkItemId, toWorkItemId) =>
        set((s) => {
          if (fromWorkItemId === toWorkItemId || !s.dataWorkspaces[fromWorkItemId]) return s;
          const { [fromWorkItemId]: workspace, ...remaining } = s.dataWorkspaces;
          return { dataWorkspaces: { ...remaining, [toWorkItemId]: workspace! } };
        }),
      removeDataWorkspace: (workItemId) =>
        set((s) => {
          if (!s.dataWorkspaces[workItemId]) return s;
          const { [workItemId]: _removed, ...dataWorkspaces } = s.dataWorkspaces;
          return { dataWorkspaces };
        }),
      removeConnectionWorkspace: (connectionId) =>
        set((s) => {
          const { [connectionId]: _workspace, ...workspaces } = s.workspaces;
          const { [connectionId]: _drafts, ...sqlDrafts } = s.sqlDrafts;
          const dataWorkspaces = Object.fromEntries(
            Object.entries(s.dataWorkspaces).map(([workItemId, workspace]) => {
              const tabs = workspace.tabs.filter((tab) => tab.connectionId !== connectionId);
              const activeTab = tabs.some((tab) => tab.id === workspace.activeTab)
                ? workspace.activeTab
                : tabs[0]?.id ?? null;
              return [workItemId, { ...workspace, tabs, activeTab }];
            }),
          );
          if (s.tabsConnectionId !== connectionId) return { workspaces, sqlDrafts, dataWorkspaces };
          return { workspaces, sqlDrafts, dataWorkspaces, tabsConnectionId: null, tabs: [], activeTab: null };
        }),
      setRightPanel: (p) => set({ rightPanel: p }),
      setDark: (d) => set({ dark: d }),
    }),
    {
      name: "dbchat.workspaces",
      version: 1,
      partialize: (state) => ({
        workspaces: state.workspaces,
        sqlDrafts: state.sqlDrafts,
        dataWorkspaces: state.dataWorkspaces,
      }),
    },
  ),
);
