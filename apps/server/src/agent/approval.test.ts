import { describe, expect, test } from "bun:test";
import type { ApprovalId, ChatEvent, MessageId, Thread, ThreadId } from "@dbchat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import type { Driver, QueryOptions, RowBatch } from "../Services/DriverRegistry.ts";
import { makeChatHub } from "./hub.ts";
import type { ChatRepoShape } from "./repo.ts";
import { type PendingApproval, proposeWrite, type SessionDeps } from "./session.ts";
import { collectQuery } from "./tools.ts";

const thread: Thread = { id: "t1" as ThreadId, connectionId: "c1" as never, title: "x", createdAt: "", updatedAt: "" };
const messageId = "m1" as MessageId;

const makeMockDriver = (
  calls: Array<{ sql: string; options: QueryOptions | undefined }>,
  batch: RowBatch = { columns: [], rows: [[3]] },
): Driver => ({
  dialect: "postgres",
  ping: Effect.succeed({ latencyMs: 1 }),
  introspect: Effect.succeed([]),
  describeTable: () => Effect.die("unused"),
  rows: () => Effect.die("unused"),
  query: (sql, options) =>
    Stream.suspend(() => {
      calls.push({ sql, options });
      return Stream.make(batch);
    }),
  explain: () => Effect.succeed(""),
  close: Effect.void,
});

const makeMockRepo = (statuses: Array<[ApprovalId, string, unknown]>): ChatRepoShape =>
  ({
    createApproval: () => Effect.void,
    setApprovalStatus: (id: ApprovalId, status: string, detail?: unknown) =>
      Effect.sync(() => void statuses.push([id, status, detail])),
  }) as unknown as ChatRepoShape;

const setup = (batch?: RowBatch, approvalRequired = true) =>
  Effect.gen(function* () {
  const hub = yield* makeChatHub;
  const calls: Array<{ sql: string; options: QueryOptions | undefined }> = [];
  const statuses: Array<[ApprovalId, string, unknown]> = [];
  const pendingApprovals = new Map<ApprovalId, PendingApproval>();
  const deps: SessionDeps = {
    repo: makeMockRepo(statuses),
    hub,
    acquireDriver: Effect.succeed(batch === undefined ? makeMockDriver(calls) : makeMockDriver(calls, batch)),
    writeApprovalRequired: Effect.succeed(approvalRequired),
    executeWrite: ({ sql }) =>
      collectQuery(batch === undefined ? makeMockDriver(calls) : makeMockDriver(calls, batch), sql, {
        readOnly: false,
        limit: 1,
        timeoutMs: 30_000,
      }),
    pendingApprovals,
    model: "test",
    cwd: "/tmp",
    log: () => Effect.void,
  };
  const events: ChatEvent[] = [];
  const emit = (e: ChatEvent) => Effect.sync(() => void events.push(e)).pipe(Effect.andThen(hub.publish(thread.id, e)));
  return { deps, calls, statuses, pendingApprovals, events, emit, hub };
});

const waitForPending = (pending: Map<ApprovalId, PendingApproval>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 100 && pending.size === 0; i++) yield* Effect.sleep("5 millis");
    const [id, p] = [...pending.entries()][0]!;
    return { id, p };
  });

describe("propose_write approval flow", () => {
  test("executes without an approval only when the connection policy allows it", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const s = yield* setup({ columns: [], rows: [], affectedRows: 2 }, false);
        const outcome = yield* proposeWrite({
          deps: s.deps,
          thread,
          messageId,
          sql: "update t set a = 1",
          estimatedRows: 2,
          emit: s.emit,
        });
        return { outcome, s };
      }),
    );
    expect(out.outcome).toEqual({ status: "executed", rowCount: 2 });
    expect(out.s.calls).toHaveLength(1);
    expect(out.s.calls[0]!.options?.readOnly).toBe(false);
    expect(out.s.pendingApprovals.size).toBe(0);
    expect(out.s.events).toEqual([]);
    expect(out.s.statuses).toEqual([]);
  });

  test("waits for approval, then executes with readOnly:false and emits executed", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const s = yield* setup();
        const fiber = yield* Effect.forkChild(
          proposeWrite({ deps: s.deps, thread, messageId, sql: "update t set a = 1", estimatedRows: 3, emit: s.emit }),
        );
        const { id, p } = yield* waitForPending(s.pendingApprovals);
        expect(s.events.map((e) => e._tag)).toEqual(["ApprovalRequested"]);
        expect(s.calls).toHaveLength(0); // nothing ran before the decision
        yield* Deferred.succeed(p.decision, true);
        const outcome = yield* Fiber.join(fiber);
        return { outcome, s, id };
      }),
    );
    expect(out.outcome).toEqual({ status: "executed", rowCount: 1 });
    expect(out.s.calls).toHaveLength(1);
    expect(out.s.calls[0]!.sql).toBe("update t set a = 1");
    expect(out.s.calls[0]!.options?.readOnly).toBe(false);
    expect(out.s.calls[0]!.options?.timeoutMs).toBe(30_000);
    expect(out.s.events.map((e) => e._tag)).toEqual(["ApprovalRequested", "ApprovalResolved", "ApprovalResolved"]);
    const last = out.s.events[2]!;
    expect(last._tag === "ApprovalResolved" && last.status).toBe("executed");
    expect(out.s.statuses.map(([, st]) => st)).toEqual(["approved", "executed"]);
    expect(out.s.pendingApprovals.size).toBe(0);
  });

  test("reports the driver's affectedRows, not the returned row count", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        // A bare UPDATE returns no rows at all: only `affectedRows` is meaningful.
        const s = yield* setup({ columns: [], rows: [], affectedRows: 42 });
        const fiber = yield* Effect.forkChild(
          proposeWrite({
            deps: s.deps,
            thread,
            messageId,
            sql: "update t set a = 1",
            estimatedRows: undefined,
            emit: s.emit,
          }),
        );
        const { p } = yield* waitForPending(s.pendingApprovals);
        yield* Deferred.succeed(p.decision, true);
        const outcome = yield* Fiber.join(fiber);
        return { outcome, s };
      }),
    );
    expect(out.outcome).toEqual({ status: "executed", rowCount: 42 });
    // …and the same count is what gets persisted on the approval.
    expect(out.s.statuses.at(-1)).toEqual([expect.any(String), "executed", { rowCount: 42 }]);
  });

  // The write path caps returned rows at 1 (a RETURNING clause could be huge),
  // so the fallback can only ever report 0 or 1 — which is precisely why the
  // driver has to hand back `affectedRows`.
  test("falls back to the (capped) returned row count when the driver reports none", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const s = yield* setup({ columns: [], rows: [[1], [2]] });
        const fiber = yield* Effect.forkChild(
          proposeWrite({
            deps: s.deps,
            thread,
            messageId,
            sql: "insert into t values (1), (2) returning id",
            estimatedRows: undefined,
            emit: s.emit,
          }),
        );
        const { p } = yield* waitForPending(s.pendingApprovals);
        yield* Deferred.succeed(p.decision, true);
        return yield* Fiber.join(fiber);
      }),
    );
    expect(out).toEqual({ status: "executed", rowCount: 1 });
  });

  test("rejection never touches the driver", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const s = yield* setup();
        const fiber = yield* Effect.forkChild(
          proposeWrite({ deps: s.deps, thread, messageId, sql: "delete from t", estimatedRows: undefined, emit: s.emit }),
        );
        const { p } = yield* waitForPending(s.pendingApprovals);
        yield* Deferred.succeed(p.decision, false);
        const outcome = yield* Fiber.join(fiber);
        return { outcome, s };
      }),
    );
    expect(out.outcome).toEqual({ status: "rejected" });
    expect(out.s.calls).toHaveLength(0);
    expect(out.s.events.map((e) => e._tag)).toEqual(["ApprovalRequested", "ApprovalResolved"]);
    expect(out.s.statuses.map(([, st]) => st)).toEqual(["rejected"]);
  });
});

describe("hub fan-out", () => {
  test("two subscribers both receive the thread's events; other threads are filtered", async () => {
    const got = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const hub = yield* makeChatHub;
          const a = yield* hub.subscribeScoped(thread.id);
          const b = yield* hub.subscribeScoped(thread.id);
          const fa = yield* Effect.forkChild(a.pipe(Stream.take(2), Stream.runCollect));
          const fb = yield* Effect.forkChild(b.pipe(Stream.take(2), Stream.runCollect));
          yield* hub.publish("other" as ThreadId, { _tag: "Error", message: "nope" });
          yield* hub.publish(thread.id, { _tag: "TextDelta", messageId, text: "hi" });
          yield* hub.publish(thread.id, { _tag: "TurnDone", messageId });
          return [yield* Fiber.join(fa), yield* Fiber.join(fb)];
        }),
      ),
    );
    expect(got[0]!.map((e) => e._tag)).toEqual(["TextDelta", "TurnDone"]);
    expect(got[1]!.map((e) => e._tag)).toEqual(["TextDelta", "TurnDone"]);
  });
});
