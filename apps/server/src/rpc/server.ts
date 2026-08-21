/** server.* handlers. */
import { DbchatRpcs, RPC } from "@dbchat/contracts";
import * as Effect from "effect/Effect";

import { ServerConfig } from "../config.ts";

export const serverHandlers = Effect.gen(function* () {
  const config = yield* ServerConfig;
  return {
    [RPC.serverHealth]: () => Effect.succeed({ ok: true, version: config.version }),
  } satisfies Partial<Parameters<typeof DbchatRpcs.of>[0]>;
});
