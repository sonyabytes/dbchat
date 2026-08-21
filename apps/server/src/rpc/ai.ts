/** ai.* handlers: the model catalog the picker renders. */
import { DbchatRpcs, RPC } from "@dbchat/contracts";
import * as Effect from "effect/Effect";

import { loadClaudeSettings, probeClaudeStatus, saveClaudeSettings } from "../agent/claudeRuntime.ts";
import { buildCatalog } from "../agent/models.ts";
import { ServerConfig } from "../config.ts";

export const aiHandlers = Effect.gen(function* () {
  const config = yield* ServerConfig;
  // Static catalog: built once, `DBCHAT_MODEL` only moves the `default` marker.
  const catalog = buildCatalog(config.model);
  return {
    [RPC.aiModels]: () => Effect.succeed(catalog),
    [RPC.aiClaudeGet]: () => Effect.sync(() => loadClaudeSettings(config.homeDir)),
    [RPC.aiClaudeSet]: (settings) => Effect.sync(() => saveClaudeSettings(settings, config.homeDir)),
    [RPC.aiClaudeStatus]: (settings) => Effect.promise(() => probeClaudeStatus(settings)),
  } satisfies Partial<Parameters<typeof DbchatRpcs.of>[0]>;
});
