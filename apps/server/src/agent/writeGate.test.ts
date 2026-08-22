import { describe, expect, test } from "bun:test";
import { WriteBlocked } from "@dbchat/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { Driver, QueryOptions } from "../Services/DriverRegistry.ts";
import { forceReadOnlyDriver, makeAiWriteExecutor } from "./writeGate.ts";

const thread = {
  id: "t1",
  sources: [{ kind: "database", id: "c1" }],
  title: "test",
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
} as never;

const connection = (readOnlyForAi: boolean) => ({
  id: "c1",
  name: "test",
  dialect: "postgres",
  host: "localhost",
  port: 5432,
  database: "test",
  user: "test",
  env: "local",
  ssl: "disable",
  readOnlyForAi,
  color: "#000",
  createdAt: "2025-01-01T00:00:00.000Z",
}) as never;

const driver = (calls: Array<QueryOptions | undefined>): Driver => ({
  dialect: "postgres",
  ping: Effect.succeed({ latencyMs: 1 }),
  introspect: Effect.succeed([]),
  describeTable: () => Effect.die("unused"),
  rows: () => Effect.die("unused"),
  query: (_sql, options) => {
    calls.push(options);
    return Stream.make({ columns: [], rows: [], affectedRows: 1 });
  },
  explain: () => Effect.succeed(""),
  close: Effect.void,
});

const executor = (args: {
  readOnlyForAi: boolean;
  calls: Array<QueryOptions | undefined>;
  approval?: { threadId?: string; sql?: string; status?: string };
}) =>
  makeAiWriteExecutor({
    getThread: () => Effect.succeed(thread),
    getConnection: () => Effect.succeed(connection(args.readOnlyForAi)),
    getApproval: (id) =>
      Effect.succeed({
        id,
        threadId: (args.approval?.threadId ?? "t1") as never,
        connectionId: "c1" as never,
        sql: args.approval?.sql ?? "update t set a = 1",
        status: (args.approval?.status ?? "approved") as never,
        createdAt: "",
      } as never),
    acquireDriver: () => Effect.succeed(driver(args.calls)),
  });

describe("AI write gate", () => {
  test("normal AI drivers force read-only even if a caller asks for writes", async () => {
    const calls: Array<QueryOptions | undefined> = [];
    const wrapped = forceReadOnlyDriver(driver(calls));
    await Effect.runPromise(Stream.runDrain(wrapped.query("delete from t", { readOnly: false })));
    expect(calls[0]?.readOnly).toBe(true);
  });

  test("blocks an unapproved write when Read-only for AI is enabled", async () => {
    const calls: Array<QueryOptions | undefined> = [];
    const run = executor({ readOnlyForAi: true, calls });
    const result = await Effect.runPromise(Effect.result(run({ threadId: "t1" as never, connectionId: "c1" as never, sql: "update t set a = 1" })));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(WriteBlocked);
    expect(calls).toEqual([]);
  });

  test("allows an exact persisted approval and reaches the write path", async () => {
    const calls: Array<QueryOptions | undefined> = [];
    const run = executor({ readOnlyForAi: true, calls });
    await Effect.runPromise(run({ threadId: "t1" as never, connectionId: "c1" as never, sql: "update t set a = 1", approvalId: "ap1" as never }));
    expect(calls[0]?.readOnly).toBe(false);
  });

  test("rejects an approval for different SQL", async () => {
    const calls: Array<QueryOptions | undefined> = [];
    const run = executor({ readOnlyForAi: true, calls, approval: { sql: "delete from t" } });
    const result = await Effect.runPromise(
      Effect.result(run({ threadId: "t1" as never, connectionId: "c1" as never, sql: "update t set a = 1", approvalId: "ap1" as never })),
    );
    expect(result._tag).toBe("Failure");
    expect(calls).toEqual([]);
  });

  test("allows an unapproved write when the connection policy explicitly permits it", async () => {
    const calls: Array<QueryOptions | undefined> = [];
    const run = executor({ readOnlyForAi: false, calls });
    await Effect.runPromise(run({ threadId: "t1" as never, connectionId: "c1" as never, sql: "delete from t" }));
    expect(calls[0]?.readOnly).toBe(false);
  });

  test("rejects batches and transaction-control tricks even after approval", async () => {
    const calls: Array<QueryOptions | undefined> = [];
    const sql = "commit; delete from t";
    const run = executor({ readOnlyForAi: true, calls, approval: { sql } });
    const result = await Effect.runPromise(
      Effect.result(run({ threadId: "t1" as never, connectionId: "c1" as never, sql, approvalId: "ap1" as never })),
    );
    expect(result._tag).toBe("Failure");
    expect(calls).toEqual([]);
  });
});
