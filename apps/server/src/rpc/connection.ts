/** connection.* handlers. Self-contained: only depends on Services/*. */
import { DbchatRpcs, RPC } from "@dbchat/contracts";
import * as Effect from "effect/Effect";

import { ConnectionStore } from "../Services/ConnectionStore.ts";
import { DriverRegistry } from "../Services/DriverRegistry.ts";

export const connectionHandlers = Effect.gen(function* () {
  const store = yield* ConnectionStore;
  const drivers = yield* DriverRegistry;

  return {
    [RPC.connectionList]: () => store.list,
    [RPC.connectionCreate]: (input) => store.create(input),
    [RPC.connectionUpdate]: ({ id, input }) =>
      // Metadata or credentials may have changed, so drop the open driver.
      drivers.release(id).pipe(Effect.andThen(store.update(id, input))),
    [RPC.connectionDelete]: ({ id }) => drivers.release(id).pipe(Effect.andThen(store.remove(id))),
    [RPC.connectionTest]: (input) => drivers.test(input),
    /** connect = open (or reuse) the driver, ping it, then stamp `lastUsedAt`. */
    [RPC.connectionConnect]: ({ id }) =>
      drivers.acquire(id).pipe(
        Effect.flatMap((driver) => driver.ping),
        Effect.andThen(store.touch(id)),
        Effect.andThen(drivers.status(id)),
      ),
    [RPC.connectionDisconnect]: ({ id }) => store.get(id).pipe(Effect.andThen(drivers.release(id))),
  } satisfies Partial<Parameters<typeof DbchatRpcs.of>[0]>;
});
