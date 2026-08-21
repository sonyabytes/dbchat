/**
 * Real DriverRegistry: one live driver per connection, opened lazily from the
 * stored metadata plus its decrypted secret and closed on `release` (or when
 * the layer's scope closes).
 *
 * It also provides `SchemaCache`, the per-connection introspection cache that
 * `schema.refresh` invalidates.
 */
import {
  ConnectionError,
  type ConnectionId,
  type ConnectionInput,
  type ConnectionStatus,
  type ConnectionTestResult,
  DriverError,
} from "@dbchat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import { makeDriver, makeDriverFromSpec, specFromInput } from "../db/driverFactory.ts";
import { SchemaCache, SchemaCacheLive } from "../db/schemaCache.ts";
import { validateConnectionInput } from "../db/validate.ts";
import { ConnectionStore } from "../Services/ConnectionStore.ts";
import { type Driver, DriverRegistry } from "../Services/DriverRegistry.ts";

interface Entry {
  readonly driver: Driver;
  latencyMs?: number;
  error?: string;
}

const registryLayer = Layer.effect(
  DriverRegistry,
  Effect.gen(function* () {
    const store = yield* ConnectionStore;
    const cache = yield* SchemaCache;
    const lock = yield* Semaphore.make(1);
    const open = new Map<ConnectionId, Entry>();
    const failures = new Map<ConnectionId, string>();

    const closeEntry = (id: ConnectionId) =>
      Effect.suspend(() => {
        const entry = open.get(id);
        open.delete(id);
        return entry ? entry.driver.close.pipe(Effect.ignore) : Effect.void;
      });

    // Close every pool when the layer's scope goes away.
    yield* Effect.addFinalizer(() =>
      Effect.forEach([...open.keys()], (id) => closeEntry(id), { discard: true }).pipe(Effect.ignore),
    );

    const openDriver = (id: ConnectionId) =>
      Effect.gen(function* () {
        const connection = yield* store.get(id);
        const secret = yield* store.getSecret(id);
        const driver = yield* makeDriver(connection, Option.getOrUndefined(secret));
        const health = yield* driver.ping.pipe(
          Effect.tapError(() => driver.close.pipe(Effect.ignore)),
        );
        const entry: Entry = { driver, latencyMs: health.latencyMs };
        open.set(id, entry);
        failures.delete(id);
        return entry;
      }).pipe(
        Effect.tapError((e) => Effect.sync(() => failures.set(id, e.message))),
      );

    const acquire = (id: ConnectionId) =>
      lock.withPermits(1)(
        Effect.suspend(() => {
          const hit = open.get(id);
          return hit ? Effect.succeed(hit.driver) : openDriver(id).pipe(Effect.map((e) => e.driver));
        }),
      );

    const release = (id: ConnectionId) =>
      lock.withPermits(1)(closeEntry(id).pipe(Effect.andThen(cache.invalidate(id))));

    const status = (id: ConnectionId): Effect.Effect<ConnectionStatus> =>
      Effect.sync(() => {
        const entry = open.get(id);
        if (entry) {
          return {
            id,
            state: "connected" as const,
            ...(entry.latencyMs !== undefined ? { latencyMs: entry.latencyMs } : {}),
          };
        }
        const error = failures.get(id);
        return error !== undefined ? { id, state: "error" as const, error } : { id, state: "idle" as const };
      });

    const test = (input: ConnectionInput): Effect.Effect<ConnectionTestResult, ConnectionError | DriverError> =>
      Effect.gen(function* () {
        const problem = validateConnectionInput(input);
        if (problem) {
          return yield* Effect.fail(new ConnectionError({ message: problem.message }));
        }
        const driver = yield* makeDriverFromSpec(specFromInput(input));
        const result = yield* driver.ping.pipe(Effect.ensuring(driver.close.pipe(Effect.ignore)));
        return {
          ok: true,
          latencyMs: result.latencyMs,
          ...(result.serverVersion !== undefined ? { serverVersion: result.serverVersion } : {}),
        } satisfies ConnectionTestResult;
      }).pipe(
        Effect.catch((e) =>
          Effect.succeed({
            ok: false,
            latencyMs: 0,
            error: e.message,
          } satisfies ConnectionTestResult),
        ),
      );

    return DriverRegistry.of({ acquire, release, status, test });
  }),
);

/** Provides both `DriverRegistry` and the `SchemaCache` the schema RPCs use. */
export const DriverRegistryLive = registryLayer.pipe(Layer.provideMerge(SchemaCacheLive));
