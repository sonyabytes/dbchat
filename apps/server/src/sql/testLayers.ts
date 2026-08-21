/**
 * Test-only helpers for the `sql.*` slice: a throwaway sqlite `Persistence`
 * rooted in a temp `DBCHAT_HOME`, plus mock `Driver` / `DriverRegistry` /
 * `AgentService` layers so the handlers can be exercised while the real
 * implementations are still being written.
 *
 * Not imported by production code.
 */
import type { ColumnMeta, ConnectionId, RowsPage, SqlSuggestResult } from "@dbchat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfigFromEnv, ServerConfig } from "../config.ts";
import { Persistence, PersistenceLive } from "../persistence/Persistence.ts";
import { AgentService } from "../Services/AgentService.ts";
import { type Driver, DriverRegistry } from "../Services/DriverRegistry.ts";

/** Fresh `DBCHAT_HOME` under the OS temp dir; call `cleanup()` when done. */
export const makeTempHome = () => {
  const dir = mkdtempSync(join(tmpdir(), "dbchat-sql-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

/** `Persistence` (+ its `SqlClient`) backed by a sqlite file in `homeDir`. */
export const testPersistenceLayer = (homeDir: string) =>
  PersistenceLive.pipe(Layer.provide(Layer.succeed(ServerConfig, loadConfigFromEnv({ DBCHAT_HOME: homeDir }))));

export const testColumns: ReadonlyArray<ColumnMeta> = [
  { name: "id", type: "int4", nullable: false, isPrimaryKey: true },
  { name: "email", type: "text", nullable: false, isPrimaryKey: false },
];

const unused = <A, E = never>() => Effect.die(new Error("not used in this test")) as Effect.Effect<A, E>;

/** A `Driver` whose only real behaviour is `query` (and optionally `explain`). */
export const makeTestDriver = (options: {
  readonly query: Driver["query"];
  readonly explain?: Driver["explain"];
}): Driver => ({
  dialect: "postgres",
  ping: unused<{ latencyMs: number; serverVersion?: string }>(),
  introspect: unused(),
  describeTable: () => unused(),
  rows: () => unused<RowsPage>(),
  query: options.query,
  explain: options.explain ?? (() => unused<string>()),
  close: Effect.void,
});

export const testDriverRegistry = (driver: Driver) =>
  Layer.succeed(
    DriverRegistry,
    DriverRegistry.of({
      acquire: () => Effect.succeed(driver),
      release: () => Effect.void,
      status: (id: ConnectionId) => Effect.succeed({ id, state: "connected" as const, latencyMs: 1 }),
      test: () => unused(),
    }),
  );

export const testAgentService = (suggestion: SqlSuggestResult = {}) =>
  Layer.succeed(
    AgentService,
    AgentService.of({
      send: () => Stream.empty,
      events: () => Stream.empty,
      abort: () => Effect.void,
      resolveApproval: () => Effect.void,
      suggest: () => Effect.succeed(suggestion),
    }),
  );

/**
 * Inserts a `connections` row so `query_history` / `saved_queries` foreign keys
 * are satisfied (migration 0001 declares both with `ON DELETE CASCADE`, and
 * `PRAGMA foreign_keys = ON` is set by the Persistence layer).
 */
export const seedConnection = (connectionId: ConnectionId) =>
  Effect.gen(function* () {
    const { sql } = yield* Persistence;
    yield* sql`
      INSERT INTO connections (id, name, dialect, created_at)
      VALUES (${connectionId}, 'test', 'postgres', ${new Date().toISOString()})
    `;
  });
