import { beforeEach, describe, expect, test } from "bun:test";

import { useProdGuard } from "./prod-guard.ts";

beforeEach(() => {
  sessionStorage.clear();
  useProdGuard.getState().reset();
});

describe("useProdGuard", () => {
  test("a fresh session needs confirmation for every prod connection", () => {
    expect(useProdGuard.getState().needsConfirm("c1")).toBe(true);
    expect(useProdGuard.getState().needsConfirm("c2")).toBe(true);
  });

  test("acknowledging is per connection", () => {
    useProdGuard.getState().acknowledge("c1", false);
    expect(useProdGuard.getState().needsConfirm("c1")).toBe(false);
    expect(useProdGuard.getState().needsConfirm("c2")).toBe(true);
    expect(JSON.parse(sessionStorage.getItem("dbchat.prod.ack")!)).toEqual(["c1"]);
  });

  test("muting covers every connection for the session", () => {
    useProdGuard.getState().acknowledge("c1", true);
    expect(useProdGuard.getState().needsConfirm("c2")).toBe(false);
    expect(sessionStorage.getItem("dbchat.prod.mute")).toBe("1");
  });

  test("reset clears memory and storage", () => {
    useProdGuard.getState().acknowledge("c1", true);
    useProdGuard.getState().reset();
    expect(useProdGuard.getState().needsConfirm("c1")).toBe(true);
    expect(sessionStorage.getItem("dbchat.prod.ack")).toBeNull();
    expect(sessionStorage.getItem("dbchat.prod.mute")).toBeNull();
  });
});
