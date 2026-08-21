/**
 * AI provider / model catalog.
 *
 * The server owns the catalog (`ai.models`); the UI groups it by provider and
 * sends the chosen `ModelInfo.id` back on `chat.send`. Only Anthropic is wired
 * up today, but `ProviderId` / `ProviderModels` are shaped so a second provider
 * is a data change rather than a contract change.
 */
import * as Schema from "effect/Schema";

export const ProviderId = Schema.Literals(["anthropic"]);
export type ProviderId = typeof ProviderId.Type;

/** Rough capability/speed bucket, rendered as a pill next to the model name. */
export const ModelTier = Schema.Literals(["fast", "balanced", "frontier"]);
export type ModelTier = typeof ModelTier.Type;

export const ProviderStatus = Schema.Literals(["ready", "unavailable"]);
export type ProviderStatus = typeof ProviderStatus.Type;

export const ModelInfo = Schema.Struct({
  /** Full model id passed to the provider SDK (e.g. `claude-sonnet-5`). */
  id: Schema.String,
  /** Short human label (e.g. `Sonnet 5`). */
  label: Schema.String,
  provider: ProviderId,
  tier: ModelTier,
  description: Schema.optional(Schema.String),
  /** True on the model the server falls back to (from `DBCHAT_MODEL`). */
  default: Schema.optional(Schema.Boolean),
  supportsThinking: Schema.optional(Schema.Boolean),
});
export type ModelInfo = typeof ModelInfo.Type;

export const ProviderModels = Schema.Struct({
  provider: ProviderId,
  label: Schema.String,
  status: ProviderStatus,
  /** Why the provider is unavailable — shown greyed out in the picker. */
  reason: Schema.optional(Schema.String),
  models: Schema.Array(ModelInfo),
});
export type ProviderModels = typeof ProviderModels.Type;
