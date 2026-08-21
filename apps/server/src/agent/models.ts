/**
 * Model catalog for the chat agent.
 *
 * Static on purpose: the Claude Agent SDK accepts a plain model string (see
 * `Options.model` in sdk.d.ts — aliases or full ids), so there is nothing to
 * introspect without opening a session. All three ids below were verified with
 * a one-turn `query()` against the user's Claude Code login.
 *
 * `DBCHAT_MODEL` picks which entry carries the `default: true` marker; the
 * picker in the web UI falls back to it when neither the thread nor the user
 * has chosen a model.
 */
import type { ModelInfo, ProviderModels } from "@dbchat/contracts";

/** Fallback when `DBCHAT_MODEL` is unset. */
export const DEFAULT_MODEL = "claude-sonnet-5";

export const ANTHROPIC_PROVIDER_LABEL = "Anthropic";

/** Ordered fast → frontier; the UI renders them in this order. */
export const ANTHROPIC_MODELS: ReadonlyArray<ModelInfo> = [
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    provider: "anthropic",
    tier: "fast",
    description: "Fastest and cheapest — good for quick lookups and simple queries.",
    supportsThinking: false,
  },
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    provider: "anthropic",
    tier: "balanced",
    description: "Balanced speed and reasoning — the everyday default.",
    supportsThinking: true,
  },
  {
    id: "claude-opus-5",
    label: "Opus 5",
    provider: "anthropic",
    tier: "frontier",
    description: "Deepest reasoning for gnarly schemas and multi-step analysis.",
    supportsThinking: true,
  },
];

/** `DBCHAT_MODEL`, trimmed, or the built-in default. */
export const resolveDefaultModel = (env: Record<string, string | undefined> = process.env): string =>
  env.DBCHAT_MODEL?.trim() || DEFAULT_MODEL;

/**
 * The catalog as the `ai.models` RPC returns it.
 *
 * There is no cheap auth probe on the Agent SDK (a real `query()` would cost a
 * round trip on every page load), so Anthropic is reported `ready` and a broken
 * login surfaces as an `AgentError` on the first turn instead.
 */
export const buildCatalog = (defaultModel: string = resolveDefaultModel()): ReadonlyArray<ProviderModels> => [
  {
    provider: "anthropic",
    label: ANTHROPIC_PROVIDER_LABEL,
    status: "ready",
    models: ANTHROPIC_MODELS.map((m) => (m.id === defaultModel ? { ...m, default: true } : m)),
  },
];

/** Every model id the catalog knows about, across providers. */
export const catalogModelIds = (catalog: ReadonlyArray<ProviderModels> = buildCatalog()): ReadonlyArray<string> =>
  catalog.flatMap((p) => p.models.map((m) => m.id));

export const findModel = (
  id: string,
  catalog: ReadonlyArray<ProviderModels> = buildCatalog(),
): ModelInfo | undefined => catalog.flatMap((p) => p.models).find((m) => m.id === id);

export interface ModelResolution {
  readonly ok: boolean;
  readonly model: string;
  /** Set when `ok` is false — ready to hand to `AgentError`. */
  readonly reason?: string;
}

/**
 * Precedence: explicit request → the thread's last model → the server default.
 * An unknown id is rejected rather than passed through, so a stale client (or a
 * thread pinned to a model we later dropped) fails loudly instead of silently
 * running on something else.
 */
export const resolveModel = (args: {
  readonly requested?: string | undefined;
  readonly threadModel?: string | undefined;
  readonly defaultModel: string;
  readonly catalog?: ReadonlyArray<ProviderModels>;
}): ModelResolution => {
  const catalog = args.catalog ?? buildCatalog(args.defaultModel);
  const requested = args.requested?.trim();
  if (requested) {
    return findModel(requested, catalog)
      ? { ok: true, model: requested }
      : { ok: false, model: args.defaultModel, reason: `Unknown model "${requested}"` };
  }
  const threadModel = args.threadModel?.trim();
  // A thread pinned to a model that has since disappeared quietly falls back.
  if (threadModel && findModel(threadModel, catalog)) return { ok: true, model: threadModel };
  return { ok: true, model: args.defaultModel };
};
