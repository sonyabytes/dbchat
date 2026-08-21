import { describe, expect, test } from "bun:test";

import {
  ANTHROPIC_MODELS,
  buildCatalog,
  catalogModelIds,
  DEFAULT_MODEL,
  findModel,
  resolveDefaultModel,
  resolveModel,
} from "./models.ts";

describe("catalog", () => {
  test("ships Anthropic, Codex, and OpenCode together", () => {
    const catalog = buildCatalog();
    expect(catalog).toHaveLength(3);
    expect(catalog.map((provider) => provider.provider)).toEqual(["anthropic", "openai", "opencode"]);
    expect(catalog[0]!.provider).toBe("anthropic");
    expect(catalog[0]!.status).toBe("ready");
    expect(catalog[0]!.models.map((m) => m.tier)).toEqual(["fast", "balanced", "frontier"]);
    expect(catalogModelIds()).toContain("gpt-5.3-codex");
    expect(catalogModelIds()).toContain("opencode/big-pickle");
  });

  test("DBCHAT_MODEL moves the `default` marker; exactly one model carries it", () => {
    const models = buildCatalog("claude-opus-5")[0]!.models;
    expect(models.filter((m) => m.default).map((m) => m.id)).toEqual(["claude-opus-5"]);
    expect(buildCatalog("claude-sonnet-5")[0]!.models.filter((m) => m.default).map((m) => m.id)).toEqual([
      "claude-sonnet-5",
    ]);
  });

  test("an unknown DBCHAT_MODEL leaves every entry unmarked rather than inventing one", () => {
    expect(buildCatalog("gpt-9")[0]!.models.some((m) => m.default)).toBe(false);
  });

  test("resolveDefaultModel reads and trims DBCHAT_MODEL, else falls back", () => {
    expect(resolveDefaultModel({})).toBe(DEFAULT_MODEL);
    expect(resolveDefaultModel({ DBCHAT_MODEL: "  " })).toBe(DEFAULT_MODEL);
    expect(resolveDefaultModel({ DBCHAT_MODEL: " claude-opus-5 " })).toBe("claude-opus-5");
  });

  test("findModel looks up across the catalog", () => {
    expect(findModel("claude-haiku-4-5")?.label).toBe("Haiku 4.5");
    expect(findModel("claude-3-opus")).toBeUndefined();
  });

  test("every entry has a stable id/label/provider", () => {
    for (const m of ANTHROPIC_MODELS) {
      expect(m.provider).toBe("anthropic");
      expect(m.id.startsWith("claude-")).toBe(true);
      expect(m.label.length).toBeGreaterThan(0);
    }
  });
});

describe("resolveModel", () => {
  const defaultModel = "claude-sonnet-5";

  test("an explicit request wins over the thread and the default", () => {
    expect(resolveModel({ requested: "claude-opus-5", threadModel: "claude-haiku-4-5", defaultModel })).toEqual({
      ok: true,
      model: "claude-opus-5",
    });
  });

  test("without a request the thread's last model wins", () => {
    expect(resolveModel({ threadModel: "claude-haiku-4-5", defaultModel })).toEqual({
      ok: true,
      model: "claude-haiku-4-5",
    });
  });

  test("falls back to the server default when nothing is pinned", () => {
    expect(resolveModel({ defaultModel })).toEqual({ ok: true, model: defaultModel });
    expect(resolveModel({ requested: "   ", defaultModel })).toEqual({ ok: true, model: defaultModel });
  });

  test("an unknown requested model is rejected, not silently swapped", () => {
    const r = resolveModel({ requested: "gpt-5", defaultModel });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("gpt-5");
    expect(r.model).toBe(defaultModel);
  });

  test("a model belonging to an unavailable provider is rejected", () => {
    const catalog = buildCatalog(defaultModel, { openai: { binary: undefined }, opencode: { binary: undefined } });
    const result = resolveModel({ requested: "gpt-5.3-codex", defaultModel, catalog });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("unavailable");
  });

  test("a model belonging to an installed CLI provider is accepted", () => {
    const catalog = buildCatalog(defaultModel, { openai: { binary: "/bin/codex" }, opencode: { binary: "/bin/opencode" } });
    expect(resolveModel({ requested: "gpt-5.3-codex", defaultModel, catalog })).toEqual({ ok: true, model: "gpt-5.3-codex" });
    expect(resolveModel({ requested: "opencode/big-pickle", defaultModel, catalog })).toEqual({ ok: true, model: "opencode/big-pickle" });
  });

  test("a thread pinned to a model we no longer ship quietly falls back", () => {
    expect(resolveModel({ threadModel: "claude-3-opus", defaultModel })).toEqual({ ok: true, model: defaultModel });
  });
});
