import { describe, expect, test } from "bun:test";

import { decodeProviderSessions, providerSession, setProviderSession } from "./providerSessions.ts";

describe("provider session ids", () => {
  test("treats a legacy plain id as an Anthropic session", () => {
    expect(decodeProviderSessions("sess_claude")).toEqual({ anthropic: "sess_claude" });
    expect(providerSession("sess_claude", "openai")).toBeUndefined();
  });

  test("keeps independent sessions when a thread switches providers", () => {
    const claude = setProviderSession(undefined, "anthropic", "claude_1");
    const codex = setProviderSession(claude, "openai", "codex_1");
    const all = setProviderSession(codex, "opencode", "open_1");
    expect(decodeProviderSessions(all)).toEqual({ anthropic: "claude_1", openai: "codex_1", opencode: "open_1" });
  });
});
