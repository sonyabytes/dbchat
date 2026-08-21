/**
 * Per-connection introspection cache.
 *
 * `DriverRegistry`'s shape is frozen in `Services/`, so the cache is its own
 * tiny service; `DriverRegistryLive` provides it alongside the registry and
 * `schema.refresh` invalidates it.
 */
import type { ConnectionId, SchemaMeta } from "@dbchat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface SchemaCacheShape {
  /** Returns the cached schema list, or runs `load` and caches its result. */
  readonly get: <E, R>(
    id: ConnectionId,
    load: Effect.Effect<ReadonlyArray<SchemaMeta>, E, R>,
  ) => Effect.Effect<ReadonlyArray<SchemaMeta>, E, R>;
  readonly invalidate: (id: ConnectionId) => Effect.Effect<void>;
  readonly clear: Effect.Effect<void>;
}

export class SchemaCache extends Context.Service<SchemaCache, SchemaCacheShape>()("dbchat/db/SchemaCache") {}

export const makeSchemaCache = Effect.sync((): SchemaCacheShape => {
  const entries = new Map<ConnectionId, ReadonlyArray<SchemaMeta>>();
  return {
    get: (id, load) =>
      Effect.suspend(() => {
        const hit = entries.get(id);
        if (hit !== undefined) return Effect.succeed(hit);
        return load.pipe(Effect.tap((schemas) => Effect.sync(() => entries.set(id, schemas))));
      }),
    invalidate: (id) => Effect.sync(() => void entries.delete(id)),
    clear: Effect.sync(() => entries.clear()),
  };
});

export const SchemaCacheLive = Layer.effect(SchemaCache, makeSchemaCache);
