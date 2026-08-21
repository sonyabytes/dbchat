/** connection.* handlers. Self-contained: only depends on Services/*. */
import { DbchatRpcs, RPC } from "@dbchat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ConnectionStore, mergeConnectionSecret } from "../Services/ConnectionStore.ts";
import { DriverRegistry } from "../Services/DriverRegistry.ts";

export const connectionHandlers = Effect.gen(function* () {
  const store = yield* ConnectionStore;
  const drivers = yield* DriverRegistry;

  return {
    [RPC.connectionList]: () => store.list,
    [RPC.connectionCredentials]: ({ id }) =>
      store.get(id).pipe(
        Effect.andThen(store.getSecret(id)),
        Effect.map(Option.getOrUndefined),
        Effect.map((secret) => secret ?? {}),
      ),
    [RPC.connectionCreate]: (input) => store.create(input),
    [RPC.connectionUpdate]: ({ id, input }) =>
      // Metadata or credentials may have changed, so drop the open driver.
      drivers.release(id).pipe(Effect.andThen(store.update(id, input))),
    [RPC.connectionDelete]: ({ id }) => drivers.release(id).pipe(Effect.andThen(store.remove(id))),
    [RPC.connectionTest]: ({ id, input }) =>
      id === undefined
        ? drivers.test(input)
        : store.getSecret(id).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.map((secret) => mergeConnectionSecret(input, secret)),
            Effect.flatMap(drivers.test),
          ),
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
