/** `dbchat · <connection> · <tab>` — kept in sync with the store from the root route. */
import { useEffect } from "react";

import { useApp } from "./store";

export function useDocumentTitle(): void {
  const connection = useApp((s) => s.connection);
  const tabs = useApp((s) => s.tabs);
  const activeTab = useApp((s) => s.activeTab);

  useEffect(() => {
    // Outside a workspace (connections list, settings) the tab set is stale — show just the app name.
    const tab = connection ? tabs.find((t) => t.id === activeTab) : undefined;
    const tabLabel = tab ? (tab.kind === "table" ? `${tab.schema}.${tab.table}` : tab.title) : undefined;
    document.title = ["dbchat", connection?.name, tabLabel].filter(Boolean).join(" · ");
  }, [connection, tabs, activeTab]);
}
