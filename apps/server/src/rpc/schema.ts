/** schema.* handlers. `list` is served from the per-connection cache; `refresh` invalidates it first. */
import { DbchatRpcs, RPC } from "@dbchat/contracts";
import * as Effect from "effect/Effect";

import { SchemaCache } from "../db/schemaCache.ts";
import { DriverRegistry } from "../Services/DriverRegistry.ts";

export const schemaHandlers = Effect.gen(function* () {
  const drivers = yield* DriverRegistry;
  const cache = yield* SchemaCache;

  const load = (connectionId: Parameters<typeof drivers.acquire>[0]) =>
    drivers.acquire(connectionId).pipe(Effect.flatMap((d) => d.introspect));

  return {
    [RPC.schemaList]: ({ connectionId }) => cache.get(connectionId, load(connectionId)),
    [RPC.schemaTable]: ({ connectionId, schema, table }) =>
      drivers.acquire(connectionId).pipe(Effect.flatMap((d) => d.describeTable(schema, table))),
    [RPC.schemaRefresh]: ({ connectionId }) =>
      cache.invalidate(connectionId).pipe(Effect.andThen(cache.get(connectionId, load(connectionId)))),
  } satisfies Partial<Parameters<typeof DbchatRpcs.of>[0]>;
});
