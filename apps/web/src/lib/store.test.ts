/// <reference types="bun" />

import { beforeEach, expect, test } from "bun:test";

const values = new Map<string, string>();
const storage: Storage = {
  get length() {
    return values.size;
  },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => [...values.keys()][index] ?? null,
  removeItem: (key) => values.delete(key),
  setItem: (key, value) => values.set(key, value),
};

Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } });
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: { documentElement: { classList: { contains: () => false } } },
});

const { tabIds, useApp } = await import("./store");

beforeEach(() => {
  values.clear();
  useApp.setState({
    connection: null,
    tabsConnectionId: null,
    tabs: [],
    activeTab: null,
    workspaces: {},
    sqlDrafts: {},
  });
});

test("keeps independent tab sets and SQL drafts per connection", () => {
  const query = { id: tabIds.sql("draft-a"), kind: "sql" as const, queryId: "draft-a", title: "untitled.sql" };
  const chat = { id: tabIds.chat("thread-b"), kind: "chat" as const, threadId: "thread-b", title: "Investigate" };

  useApp.getState().openTab(query, "connection-a");
  useApp.getState().setSqlDraft("connection-a", query.queryId, "select 1");
  useApp.getState().openTab(chat, "connection-b");
  useApp.getState().setSqlDraft("connection-b", "draft-b", "select 2");

  expect(useApp.getState().restorableTab("connection-a")).toEqual(query);
  expect(useApp.getState().restorableTab("connection-b")).toEqual(chat);
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
  const query = { id: tabIds.sql("draft-a"), kind: "sql" as const, queryId: "draft-a", title: "untitled.sql" };
  useApp.getState().openTab(query, "connection-a");
  useApp.getState().setSqlDraft("connection-a", query.queryId, "select now()");

  const saved = JSON.parse(storage.getItem("dbchat.workspaces") ?? "{}") as { state?: Record<string, unknown> };
  expect(saved.state?.workspaces).toBeDefined();
  expect(saved.state?.sqlDrafts).toBeDefined();
  expect(saved.state?.connection).toBeUndefined();
  expect(saved.state?.tabs).toBeUndefined();
});

test("removes local workspace data when a connection is deleted", () => {
  const query = { id: tabIds.sql("draft-a"), kind: "sql" as const, queryId: "draft-a", title: "untitled.sql" };
  useApp.getState().openTab(query, "connection-a");
  useApp.getState().setSqlDraft("connection-a", query.queryId, "select 1");

  useApp.getState().removeConnectionWorkspace("connection-a");

  expect(useApp.getState().restorableTab("connection-a")).toBeNull();
  expect(useApp.getState().getSqlDraft("connection-a", query.queryId)).toBeUndefined();
  expect(useApp.getState().tabsConnectionId).toBeNull();
  expect(useApp.getState().tabs).toEqual([]);
});
