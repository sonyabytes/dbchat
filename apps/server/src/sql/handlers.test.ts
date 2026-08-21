/** End-to-end tests for the `sql.*` RPC handlers against a mocked Driver. */
import { afterEach, expect, test } from "bun:test";

import { type ConnectionId, type QueryId, type RunId, SqlError, WriteBlocked } from "@dbchat/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { Persistence } from "../persistence/Persistence.ts";
import { sqlHandlers } from "../rpc/sql.ts";
import type { Driver, QueryOptions } from "../Services/DriverRegistry.ts";
import { deriveRunId } from "./statements.ts";
import {
  makeTempHome,
  makeTestDriver,
  seedConnection,
  testAgentService,
  testColumns,
  testDriverRegistry,
  testPersistenceLayer,
} from "./testLayers.ts";

const connectionId = "c_handlers" as ConnectionId;

const homes: Array<() => void> = [];
afterEach(() => {
  while (homes.length > 0) homes.pop()?.();
});

type Handlers = Effect.Success<typeof sqlHandlers>;

/** Boots the handlers over a temp sqlite + the supplied mock driver. */
const withHandlers = <A, E>(
  driver: Driver,
  f: (handlers: Handlers) => Effect.Effect<A, E, Persistence>,
  options?: { readonly suggestion?: { text: string; reason: string } },
): Promise<A> => {
  const home = makeTempHome();
  homes.push(home.cleanup);
  const layers = Layer.mergeAll(
    testDriverRegistry(driver),
    testAgentService(options?.suggestion ? { suggestion: options.suggestion } : {}),
  ).pipe(Layer.provideMerge(testPersistenceLayer(home.dir)));

  return Effect.runPromise(
    Effect.gen(function* () {
      yield* seedConnection(connectionId);
      return yield* f(yield* sqlHandlers);
    }).pipe(Effect.provide(layers)),
  );
};

const rowsDriver = (batches: ReadonlyArray<ReadonlyArray<ReadonlyArray<unknown>>>, seen: QueryOptions[] = []) =>
  makeTestDriver({
    query: (_sql, opts) => {
      if (opts) seen.push(opts);
      return Stream.fromIterable(batches.map((rows) => ({ columns: testColumns, rows })));
    },
  });

test("run collects every batch, reports the command, and writes history", async () => {
  const seen: QueryOptions[] = [];
  const { result, history } = await withHandlers(
    rowsDriver(
      [
        [
          [1, "a@x.com"],
          [2, "b@x.com"],
        ],
        [[3, "c@x.com"]],
      ],
      seen,
    ),
    (handlers) =>
      Effect.gen(function* () {
        const result = yield* handlers["sql.run"]({ connectionId, sql: "  select id, email from users " });
        const history = yield* handlers["sql.history.list"]({ connectionId });
        return { result, history };
      }),
  );

  expect(result.rows).toEqual([
    [1, "a@x.com"],
    [2, "b@x.com"],
    [3, "c@x.com"],
  ]);
  expect(result.rowCount).toBe(3);
  expect(result.columns).toEqual(testColumns);
  expect(result.command).toBe("SELECT");
  expect(result.truncated).toBe(false);
  expect(result.durationMs).toBeGreaterThanOrEqual(0);

  // defaults handed to the driver
  expect(seen[0]).toEqual({ readOnly: true, limit: 500, timeoutMs: 60_000 });

  expect(history).toHaveLength(1);
  // history keeps the SQL exactly as submitted so it can be replayed verbatim
  expect(history[0]).toMatchObject({
    connectionId,
    sql: "  select id, email from users ",
    rowCount: 3,
    ok: true,
  });
});

test("run caps rows at the requested limit and marks the result truncated", async () => {
  const result = await withHandlers(
    rowsDriver([
      [
        [1, "a"],
        [2, "b"],
        [3, "c"],
      ],
    ]),
    (handlers) => handlers["sql.run"]({ connectionId, sql: "select * from users", limit: 2 }),
  );

  expect(result.rows).toHaveLength(2);
  expect(result.rowCount).toBe(2);
  expect(result.truncated).toBe(true);
});

test("read-only runs reject `;`-separated batches before reaching the driver", async () => {
  let queried = false;
  const driver = makeTestDriver({
    query: () => {
      queried = true;
      return Stream.empty;
    },
  });

  const { exit, history } = await withHandlers(driver, (handlers) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        handlers["sql.run"]({ connectionId, sql: "select 1; drop table users" }),
      );
      const history = yield* handlers["sql.history.list"]({ connectionId });
      return { exit, history };
    }),
  );

  expect(queried).toBe(false);
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause) as SqlError;
    expect(error).toBeInstanceOf(SqlError);
    expect(error.code).toBe("MULTI_STATEMENT");
  }
  expect(history).toHaveLength(1);
  expect(history[0]?.ok).toBe(false);
  expect(history[0]?.error).toContain("Multiple statements");
});

test("the multi-statement guard does not apply when readOnly is false", async () => {
  const result = await withHandlers(rowsDriver([[[1]]]), (handlers) =>
    handlers["sql.run"]({ connectionId, sql: "insert into t values (1); insert into t values (2)", readOnly: false }),
  );
  expect(result.rowCount).toBe(1);
});

test("a DML run reports the driver's affectedRows as rowCount, in the result and in history", async () => {
  const { result, history } = await withHandlers(
    makeTestDriver({
      // What a real driver returns for `update …`: no rows, a server row count.
      query: () => Stream.make({ columns: [], rows: [], affectedRows: 17 }),
    }),
    (handlers) =>
      Effect.gen(function* () {
        const result = yield* handlers["sql.run"]({
          connectionId,
          sql: "update users set plan = 'pro'",
          readOnly: false,
        });
        const history = yield* handlers["sql.history.list"]({ connectionId });
        return { result, history };
      }),
  );

  expect(result.rows).toEqual([]);
  expect(result.rowCount).toBe(17);
  expect(result.command).toBe("UPDATE");
  expect(history[0]).toMatchObject({ rowCount: 17, ok: true });
});

test("affectedRows is summed across batches and ignored for a SELECT", async () => {
  const dml = await withHandlers(
    makeTestDriver({
      query: () =>
        Stream.fromIterable([
          { columns: [], rows: [], affectedRows: 2 },
          { columns: [], rows: [], affectedRows: 3 },
        ]),
    }),
    (handlers) =>
      handlers["sql.run"]({ connectionId, sql: "insert into t values (1)", readOnly: false }),
  );
  expect(dml.rowCount).toBe(5);

  const select = await withHandlers(rowsDriver([[[1, "a"], [2, "b"]]]), (handlers) =>
    handlers["sql.run"]({ connectionId, sql: "select id, email from users" }),
  );
  expect(select.rowCount).toBe(2);
});

test("sql.cancel interrupts the in-flight run", async () => {
  const runId = "run_cancel" as RunId;
  const home = makeTempHome();
  homes.push(home.cleanup);

  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();

      const driver = makeTestDriver({
        query: () =>
          Stream.fromEffect(
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          ).pipe(Stream.ensuring(Deferred.succeed(released, undefined))),
      });

      const layers = Layer.mergeAll(testDriverRegistry(driver), testAgentService()).pipe(
        Layer.provideMerge(testPersistenceLayer(home.dir)),
      );

      return yield* Effect.gen(function* () {
        yield* seedConnection(connectionId);
        const handlers = yield* sqlHandlers;

        const fiber = yield* Effect.forkChild(
          Effect.exit(handlers["sql.run"]({ connectionId, sql: "select pg_sleep(60)", runId })),
        );
        yield* Deferred.await(started);

        yield* handlers["sql.cancel"]({ runId });

        // the driver stream's finalizer ran = the driver-side cancel happened
        yield* Deferred.await(released);
        const exit = yield* Fiber.join(fiber);
        const history = yield* handlers["sql.history.list"]({ connectionId });
        const secondCancel = yield* Effect.exit(handlers["sql.cancel"]({ runId }));
        return { exit, history, secondCancel };
      }).pipe(Effect.provide(layers));
    }),
  );

  expect(Exit.isFailure(outcome.exit)).toBe(true);
  if (Exit.isFailure(outcome.exit)) {
    const error = Cause.squash(outcome.exit.cause) as SqlError;
    expect(error).toBeInstanceOf(SqlError);
    expect(error.code).toBe("CANCELED");
  }
  expect(outcome.history).toHaveLength(1);
  expect(outcome.history[0]?.ok).toBe(false);
  expect(outcome.history[0]?.error).toBe("Query canceled");
  // the registry entry is gone once the run finished
  expect(Exit.isFailure(outcome.secondCancel)).toBe(true);
});

test("cancel works with the derived runId when the client omits one", async () => {
  const home = makeTempHome();
  homes.push(home.cleanup);
  const sqlText = "select pg_sleep(60)";

  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const driver = makeTestDriver({
        query: () =>
          Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))),
      });
      const layers = Layer.mergeAll(testDriverRegistry(driver), testAgentService()).pipe(
        Layer.provideMerge(testPersistenceLayer(home.dir)),
      );

      return yield* Effect.gen(function* () {
        yield* seedConnection(connectionId);
        const handlers = yield* sqlHandlers;
        const fiber = yield* Effect.forkChild(
          Effect.exit(handlers["sql.run"]({ connectionId, sql: sqlText })),
        );
        yield* Deferred.await(started);
        yield* handlers["sql.cancel"]({ runId: deriveRunId(connectionId, sqlText) });
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(layers));
    }),
  );

  expect(Exit.isFailure(exit)).toBe(true);
});

test("interrupting the request itself tears down the driver stream", async () => {
  const home = makeTempHome();
  homes.push(home.cleanup);

  const released = await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const driver = makeTestDriver({
        query: () =>
          Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))).pipe(
            Stream.ensuring(Deferred.succeed(released, undefined)),
          ),
      });
      const layers = Layer.mergeAll(testDriverRegistry(driver), testAgentService()).pipe(
        Layer.provideMerge(testPersistenceLayer(home.dir)),
      );

      return yield* Effect.gen(function* () {
        yield* seedConnection(connectionId);
        const handlers = yield* sqlHandlers;
        const fiber = yield* Effect.forkChild(handlers["sql.run"]({ connectionId, sql: "select 1" }));
        yield* Deferred.await(started);
        // simulates the RPC request being cancelled (e.g. the socket closing)
        yield* Fiber.interrupt(fiber);
        yield* Deferred.await(released);
        return true;
      }).pipe(Effect.provide(layers));
    }),
  );

  expect(released).toBe(true);
});

test("driver errors pass through untouched and are recorded", async () => {
  const driverError = new SqlError({ message: 'relation "nope" does not exist', position: 15, code: "42P01" });
  const { exit, history } = await withHandlers(
    makeTestDriver({ query: () => Stream.fail(driverError) }),
    (handlers) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(handlers["sql.run"]({ connectionId, sql: "select * from nope" }));
        return { exit, history: yield* handlers["sql.history.list"]({ connectionId }) };
      }),
  );

  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause) as SqlError;
    expect(error.position).toBe(15);
    expect(error.code).toBe("42P01");
  }
  expect(history[0]?.ok).toBe(false);
  expect(history[0]?.error).toContain("does not exist");
});

test("WriteBlocked from the driver reaches the client", async () => {
  const blocked = new WriteBlocked({ sql: "delete from users", reason: "read-only session" });
  const exit = await withHandlers(makeTestDriver({ query: () => Stream.fail(blocked) }), (handlers) =>
    Effect.exit(handlers["sql.run"]({ connectionId, sql: "delete from users", readOnly: false })),
  );

  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Cause.squash(exit.cause)).toBeInstanceOf(WriteBlocked);
  }
});

test("history is newest-first across runs", async () => {
  const history = await withHandlers(rowsDriver([[[1]]]), (handlers) =>
    Effect.gen(function* () {
      yield* handlers["sql.run"]({ connectionId, sql: "select 1" });
      yield* Effect.sleep("2 millis");
      yield* handlers["sql.run"]({ connectionId, sql: "select 2" });
      yield* Effect.sleep("2 millis");
      yield* handlers["sql.run"]({ connectionId, sql: "select 3" });
      return yield* handlers["sql.history.list"]({ connectionId });
    }),
  );

  expect(history.map((h) => h.sql)).toEqual(["select 3", "select 2", "select 1"]);
});

test("saved query CRUD round-trips through the handlers", async () => {
  const out = await withHandlers(rowsDriver([]), (handlers) =>
    Effect.gen(function* () {
      const created = yield* handlers["sql.saved.save"]({ connectionId, name: "Recent", sql: "select 1" });
      const afterCreate = yield* handlers["sql.saved.list"]({ connectionId });
      const updated = yield* handlers["sql.saved.save"]({
        id: created.id,
        connectionId,
        name: "Recent v2",
        sql: "select 2",
      });
      yield* handlers["sql.saved.delete"]({ id: created.id });
      const afterDelete = yield* handlers["sql.saved.list"]({ connectionId });
      const missing = yield* Effect.exit(handlers["sql.saved.delete"]({ id: created.id }));
      const invalid = yield* Effect.exit(
        handlers["sql.saved.save"]({ connectionId, name: "   ", sql: "select 1" }),
      );
      return { created, afterCreate, updated, afterDelete, missing, invalid };
    }),
  );

  expect(out.afterCreate).toHaveLength(1);
  expect(out.updated.id).toBe(out.created.id);
  expect(out.updated.name).toBe("Recent v2");
  expect(out.afterDelete).toHaveLength(0);
  expect(Exit.isFailure(out.missing)).toBe(true);
  expect(Exit.isFailure(out.invalid)).toBe(true);
});

test("explain delegates to the driver", async () => {
  const driver = makeTestDriver({
    query: () => Stream.empty,
    explain: (sql) => Effect.succeed(`PLAN FOR ${sql}`),
  });

  const { plan, multi } = await withHandlers(driver, (handlers) =>
    Effect.gen(function* () {
      const { plan } = yield* handlers["sql.explain"]({ connectionId, sql: "select 1" });
      const multi = yield* Effect.exit(handlers["sql.explain"]({ connectionId, sql: "select 1; select 2" }));
      return { plan, multi };
    }),
  );

  expect(plan).toBe("PLAN FOR select 1");
  expect(Exit.isFailure(multi)).toBe(true);
});

test("suggest delegates to AgentService", async () => {
  const suggestion = { text: " and total_cents > 0", reason: "skips test orders" };
  const result = await withHandlers(
    rowsDriver([]),
    (handlers) => handlers["sql.suggest"]({ connectionId, sql: "select * from orders where", cursor: 26 }),
    { suggestion },
  );

  expect(result.suggestion).toEqual(suggestion);
});

test("saving against an unknown connection surfaces a ValidationError", async () => {
  const exit = await withHandlers(rowsDriver([]), (handlers) =>
    Effect.exit(
      handlers["sql.saved.save"]({
        id: "q_orphan" as QueryId,
        connectionId: "c_nope" as ConnectionId,
        name: "orphan",
        sql: "select 1",
      }),
    ),
  );

  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(String(Cause.squash(exit.cause))).toContain("Could not save query");
  }
});
