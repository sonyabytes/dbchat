/** table.* handlers. */
import { DbchatRpcs, RPC } from "@dbchat/contracts";
import * as Effect from "effect/Effect";

import { DriverRegistry } from "../Services/DriverRegistry.ts";

export const tableHandlers = Effect.gen(function* () {
  const drivers = yield* DriverRegistry;

  return {
    [RPC.tableRows]: (req) => drivers.acquire(req.connectionId).pipe(Effect.flatMap((d) => d.rows(req))),
  } satisfies Partial<Parameters<typeof DbchatRpcs.of>[0]>;
});
