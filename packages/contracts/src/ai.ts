/**
 * AI provider / model catalog.
 *
 * The server owns the catalog (`ai.models`); the UI groups it by provider and
 * sends the chosen `ModelInfo.id` back on `chat.send`. Provider availability is
 * discovered from the installed Claude Code, Codex, and OpenCode runtimes.
 */
import * as Schema from "effect/Schema";

export const ProviderId = Schema.Literals(["anthropic", "openai", "opencode"]);
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

/* ---------------- Claude runtime (which `claude` instance the agent uses) ---------------- */

/** Persisted in `<DBCHAT_HOME>/claude.json`. Empty string = unset (fall back to env / PATH / default). */
export const ClaudeRuntimeSettings = Schema.Struct({
  /** Path or command name of the Claude Code binary. */
  binaryPath: Schema.String,
  /** `CLAUDE_CONFIG_DIR` — a separate login/profile. `HOME` is never overridden. */
  configDir: Schema.String,
});
export type ClaudeRuntimeSettings = typeof ClaudeRuntimeSettings.Type;

export const ClaudeRuntimeStatus = Schema.Struct({
  binaryPath: Schema.NullOr(Schema.String),
  binarySource: Schema.Literals(["settings", "env", "path", "bundled"]),
  configDir: Schema.String,
  configDirSource: Schema.Literals(["settings", "env", "default"]),
  configDirExists: Schema.Boolean,
  /** `null` = could not determine (no binary / probe failed). */
  loggedIn: Schema.NullOr(Schema.Boolean),
  authMethod: Schema.optional(Schema.String),
  apiProvider: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  detail: Schema.String,
});
export type ClaudeRuntimeStatus = typeof ClaudeRuntimeStatus.Type;
