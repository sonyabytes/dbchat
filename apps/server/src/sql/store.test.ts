import { afterEach, expect, test } from "bun:test";

import type { ConnectionId, QueryId } from "@dbchat/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { Persistence } from "../persistence/Persistence.ts";
import { HISTORY_LIMIT, HISTORY_RETAIN, makeSqlStore } from "./store.ts";
import { makeTempHome, seedConnection, testPersistenceLayer } from "./testLayers.ts";

const connectionId = "c_store" as ConnectionId;
const otherConnectionId = "c_other" as ConnectionId;

const homes: Array<() => void> = [];
afterEach(() => {
  while (homes.length > 0) homes.pop()?.();
});

/** Runs `f` against a fresh migrated sqlite in a temp DBCHAT_HOME. */
const withStore = <A, E>(
  f: (store: ReturnType<typeof makeSqlStore>) => Effect.Effect<A, E, Persistence>,
): Promise<A> => {
  const home = makeTempHome();
  homes.push(home.cleanup);
  return Effect.runPromise(
    Effect.gen(function* () {
      const { sql } = yield* Persistence;
      yield* seedConnection(connectionId);
      yield* seedConnection(otherConnectionId);
      return yield* f(makeSqlStore(sql));
    }).pipe(Effect.provide(testPersistenceLayer(home.dir))),
  );
};

test("history is newest-first, scoped per connection, and capped", async () => {
  const entries = await withStore((store) =>
    Effect.gen(function* () {
      yield* store.recordRun({
        connectionId,
        sql: "select 1",
        durationMs: 5,
        rowCount: 1,
        ok: true,
        ranAt: "2026-01-01T00:00:00.000Z",
      });
      yield* store.recordRun({
        connectionId,
        sql: "select 2",
        durationMs: 7,
        rowCount: 0,
        ok: false,
        error: "boom",
        ranAt: "2026-01-03T00:00:00.000Z",
      });
      yield* store.recordRun({
        connectionId,
        sql: "select 3",
        durationMs: 9,
        rowCount: 2,
        ok: true,
        ranAt: "2026-01-02T00:00:00.000Z",
      });
      yield* store.recordRun({
        connectionId: otherConnectionId,
        sql: "select 4",
        durationMs: 1,
        rowCount: 0,
        ok: true,
        ranAt: "2026-01-04T00:00:00.000Z",
      });
      return yield* store.listHistory(connectionId);
    }),
  );

  expect(entries.map((e) => e.sql)).toEqual(["select 2", "select 3", "select 1"]);
  expect(entries[0]?.ok).toBe(false);
  expect(entries[0]?.error).toBe("boom");
  expect(entries[1]?.ok).toBe(true);
  // optional field must be absent, not null, so the contract schema encodes it
  expect("error" in entries[1]!).toBe(false);
  expect(entries[2]).toMatchObject({ durationMs: 5, rowCount: 1, connectionId });
});

test("history keeps only the newest HISTORY_LIMIT rows", async () => {
  const entries = await withStore((store) =>
    Effect.gen(function* () {
      for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
        yield* store.recordRun({
          connectionId,
          sql: `select ${i}`,
          durationMs: i,
          rowCount: 0,
          ok: true,
          ranAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        });
      }
      return yield* store.listHistory(connectionId);
    }),
  );

  expect(entries).toHaveLength(HISTORY_LIMIT);
  expect(entries[0]?.sql).toBe(`select ${HISTORY_LIMIT + 4}`);
});

test("saved queries: create, update in place, list, delete", async () => {
  const result = await withStore((store) =>
    Effect.gen(function* () {
      const created = yield* store.saveQuery({ connectionId, name: "Top users", sql: "select 1" });
      const listedAfterCreate = yield* store.listSaved(connectionId);

      const updated = yield* store.saveQuery({
        id: created.id,
        connectionId,
        name: "Top users (v2)",
        sql: "select 2",
      });
      const listedAfterUpdate = yield* store.listSaved(connectionId);

      const deleted = yield* store.deleteQuery(created.id);
      const missing = yield* store.deleteQuery(created.id);
      const listedAfterDelete = yield* store.listSaved(connectionId);

      return { created, listedAfterCreate, updated, listedAfterUpdate, deleted, missing, listedAfterDelete };
    }),
  );

  expect(result.listedAfterCreate).toHaveLength(1);
  expect(result.listedAfterCreate[0]).toMatchObject({ name: "Top users", sql: "select 1" });

  expect(result.updated.id).toBe(result.created.id);
  expect(result.updated.createdAt).toBe(result.created.createdAt);
  expect(result.listedAfterUpdate).toHaveLength(1);
  expect(result.listedAfterUpdate[0]).toMatchObject({ name: "Top users (v2)", sql: "select 2" });

  expect(result.deleted).toBe(true);
  expect(result.missing).toBe(false);
  expect(result.listedAfterDelete).toHaveLength(0);
});

test("saved queries are scoped per connection", async () => {
  const { mine, theirs } = await withStore((store) =>
    Effect.gen(function* () {
      yield* store.saveQuery({ connectionId, name: "a", sql: "select 1" });
      yield* store.saveQuery({ connectionId: otherConnectionId, name: "b", sql: "select 2" });
      return { mine: yield* store.listSaved(connectionId), theirs: yield* store.listSaved(otherConnectionId) };
    }),
  );

  expect(mine.map((q) => q.name)).toEqual(["a"]);
  expect(theirs.map((q) => q.name)).toEqual(["b"]);
});

test("saving against an unknown connection fails the foreign key", async () => {
  const home = makeTempHome();
  homes.push(home.cleanup);
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const { sql } = yield* Persistence;
      return yield* makeSqlStore(sql).saveQuery({
        id: "q_orphan" as QueryId,
        connectionId: "c_missing" as ConnectionId,
        name: "orphan",
        sql: "select 1",
      });
    }).pipe(Effect.provide(testPersistenceLayer(home.dir))),
  );

  expect(Exit.isFailure(exit)).toBe(true);
});

test("query_history is pruned to HISTORY_RETAIN rows per connection on insert", async () => {
  const counts = await withStore((store) =>
    Effect.gen(function* () {
      const { sql } = yield* Persistence;
      const base = Date.parse("2026-01-01T00:00:00.000Z");
      for (let i = 0; i < HISTORY_RETAIN + 25; i++) {
        yield* store.recordRun({
          connectionId,
          sql: `select ${i}`,
          durationMs: 1,
          rowCount: 1,
          ok: true,
          ranAt: new Date(base + i * 1000).toISOString(),
        });
      }
      yield* store.recordRun({ connectionId: otherConnectionId, sql: "select 1", durationMs: 1, rowCount: 1, ok: true, ranAt: new Date().toISOString() });
      const mine = yield* sql<{ n: number }>`SELECT count(*) AS n FROM query_history WHERE connection_id = ${connectionId}`;
      const oldest = yield* sql<{ sql: string }>`SELECT sql FROM query_history WHERE connection_id = ${connectionId} ORDER BY ran_at ASC LIMIT 1`;
      const other = yield* sql<{ n: number }>`SELECT count(*) AS n FROM query_history WHERE connection_id = ${otherConnectionId}`;
      return { mine: Number(mine[0]?.n), oldest: oldest[0]?.sql, other: Number(other[0]?.n) };
    }),
  );
  expect(counts.mine).toBe(HISTORY_RETAIN);
  expect(counts.oldest).toBe("select 25");
  expect(counts.other).toBe(1);
});
