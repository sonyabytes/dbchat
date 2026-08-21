import { beforeEach, describe, expect, test } from "bun:test";

import { type Tab, tabIds, tabPath, useApp } from "./store.ts";

const sql = (id: string, title = `${id}.sql`): Extract<Tab, { kind: "sql" }> => ({ id: tabIds.sql(id), kind: "sql", queryId: id, title });
const chat = (id: string, title = "New chat"): Extract<Tab, { kind: "chat" }> => ({ id: tabIds.chat(id), kind: "chat", threadId: id, title });
const table = (schema: string, name: string): Extract<Tab, { kind: "table" }> => ({ id: tabIds.table(schema, name), kind: "table", schema, table: name });

beforeEach(() => {
  localStorage.clear();
  useApp.setState({ connection: null, tabsConnectionId: null, tabs: [], activeTab: null, workspaces: {}, sqlDrafts: {} });
});

describe("tabIds / tabPath", () => {
  test("ids are stable per route target", () => {
    expect(tabIds.table("public", "users")).toBe("table:public.users");
    expect(tabIds.sql("q1")).toBe("sql:q1");
    expect(tabIds.chat("t1")).toBe("chat:t1");
  });

  test("paths are url-encoded", () => {
    expect(tabPath("c 1", table("public", "my table"))).toBe("/c/c%201/t/public/my%20table");
    expect(tabPath("c1", sql("q/1"))).toBe("/c/c1/sql/q%2F1");
    expect(tabPath("c1", chat("t1"))).toBe("/c/c1/chat/t1");
  });
});

describe("openTab", () => {
  test("appends and activates new tabs; re-opening only activates", () => {
    const { openTab } = useApp.getState();
    openTab(sql("a"), "c1");
    openTab(sql("b"), "c1");
    expect(useApp.getState().tabs.map((t) => t.id)).toEqual(["sql:a", "sql:b"]);
    expect(useApp.getState().activeTab).toBe("sql:b");

    openTab(sql("a"), "c1");
    expect(useApp.getState().tabs).toHaveLength(2);
    expect(useApp.getState().activeTab).toBe("sql:a");
  });

  test("replaces a tab in place when its content changed", () => {
    const { openTab } = useApp.getState();
    openTab(chat("t1", "New chat"), "c1");
    openTab(chat("t1", "Users by signup month"), "c1");
    expect(useApp.getState().tabs).toEqual([chat("t1", "Users by signup month")]);
  });

  test("switching connection projects that connection's own tab set", () => {
    const { openTab } = useApp.getState();
    openTab(sql("a"), "c1");
    openTab(sql("b"), "c2");
    expect(useApp.getState().tabsConnectionId).toBe("c2");
    expect(useApp.getState().tabs.map((t) => t.id)).toEqual(["sql:b"]);
    expect(useApp.getState().workspaces.c1?.tabs).toEqual([sql("a")]);
  });
});

describe("renameTab", () => {
  test("renames sql/chat tabs, ignores table tabs and empty titles", () => {
    const { openTab, renameTab } = useApp.getState();
    openTab(chat("t1"), "c1");
    openTab(table("public", "users"), "c1");
    renameTab("chat:t1", "Revenue");
    renameTab("table:public.users", "nope");
    renameTab("chat:t1", "");
    const [c, t] = useApp.getState().tabs;
    expect(c).toMatchObject({ kind: "chat", title: "Revenue" });
    expect(t).toEqual(table("public", "users"));
  });
});

describe("closeTab", () => {
  test("closing the active tab activates its left neighbour and returns it", () => {
    const { openTab, closeTab } = useApp.getState();
    openTab(sql("a"), "c1");
    openTab(sql("b"), "c1");
    openTab(sql("c"), "c1");
    expect(closeTab("sql:c")).toEqual(sql("b"));
    expect(useApp.getState().activeTab).toBe("sql:b");
  });

  test("closing the first active tab falls through to the new first", () => {
    const { openTab, closeTab, setActive } = useApp.getState();
    openTab(sql("a"), "c1");
    openTab(sql("b"), "c1");
    setActive("sql:a");
    expect(closeTab("sql:a")).toEqual(sql("b"));
    expect(useApp.getState().activeTab).toBe("sql:b");
  });

  test("closing an inactive tab keeps the active one and returns null", () => {
    const { openTab, closeTab } = useApp.getState();
    openTab(sql("a"), "c1");
    openTab(sql("b"), "c1");
    expect(closeTab("sql:a")).toBeNull();
    expect(useApp.getState().activeTab).toBe("sql:b");
    expect(useApp.getState().tabs).toEqual([sql("b")]);
  });

  test("closing the last tab leaves no active tab", () => {
    const { openTab, closeTab } = useApp.getState();
    openTab(sql("a"), "c1");
    expect(closeTab("sql:a")).toBeNull();
    expect(useApp.getState().tabs).toEqual([]);
    expect(useApp.getState().activeTab).toBeNull();
  });
});

describe("per-connection workspaces", () => {
  test("keeps independent tab sets and SQL drafts per connection", () => {
    const query = sql("draft-a", "untitled.sql");
    const thread = chat("thread-b", "Investigate");

    useApp.getState().openTab(query, "connection-a");
    useApp.getState().setSqlDraft("connection-a", query.queryId, "select 1");
    useApp.getState().openTab(thread, "connection-b");
    useApp.getState().setSqlDraft("connection-b", "draft-b", "select 2");

    expect(useApp.getState().restorableTab("connection-a")).toEqual(query);
    expect(useApp.getState().restorableTab("connection-b")).toEqual(thread);
    expect(useApp.getState().getSqlDraft("connection-a", query.queryId)).toBe("select 1");
    expect(useApp.getState().getSqlDraft("connection-b", "draft-b")).toBe("select 2");

    useApp.getState().setConnection({ id: "connection-a" } as never);
    expect(useApp.getState().tabsConnectionId).toBe("connection-a");
    expect(useApp.getState().tabs).toEqual([query]);
    expect(useApp.getState().activeTab).toBe(query.id);

    useApp.getState().clearSqlDraft("connection-a", query.queryId);
    expect(useApp.getState().getSqlDraft("connection-a", query.queryId)).toBeUndefined();
    expect(useApp.getState().getSqlDraft("connection-b", "draft-b")).toBe("select 2");
  });

  test("persists only lightweight workspace state", () => {
    const query = sql("draft-a", "untitled.sql");
    useApp.getState().openTab(query, "connection-a");
    useApp.getState().setSqlDraft("connection-a", query.queryId, "select now()");

    const saved = JSON.parse(localStorage.getItem("dbchat.workspaces") ?? "{}") as { state?: Record<string, unknown> };
    expect(saved.state?.workspaces).toBeDefined();
    expect(saved.state?.sqlDrafts).toBeDefined();
    expect(saved.state?.connection).toBeUndefined();
    expect(saved.state?.tabs).toBeUndefined();
  });

  test("removes local workspace data when a connection is deleted", () => {
    const query = sql("draft-a", "untitled.sql");
    useApp.getState().openTab(query, "connection-a");
    useApp.getState().setSqlDraft("connection-a", query.queryId, "select 1");

    useApp.getState().removeConnectionWorkspace("connection-a");

    expect(useApp.getState().restorableTab("connection-a")).toBeNull();
    expect(useApp.getState().getSqlDraft("connection-a", query.queryId)).toBeUndefined();
    expect(useApp.getState().tabsConnectionId).toBeNull();
    expect(useApp.getState().tabs).toEqual([]);
  });
});
