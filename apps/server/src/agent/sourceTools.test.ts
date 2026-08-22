import { describe, expect, test } from "bun:test";
import type { ChatEvent, Connection, MessageId } from "@dbchat/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { Driver } from "../Services/DriverRegistry.ts";
import { invokeDbchatTool, type ToolContext } from "./tools.ts";

const connection = (id: string, name: string): Connection => ({
  id: id as never,
  name,
  dialect: "postgres",
  host: "localhost",
  port: 5432,
  database: name.toLowerCase(),
  user: "test",
  env: "local",
  ssl: "disable",
  readOnlyForAi: true,
  color: "#000",
  createdAt: "2026-01-01T00:00:00.000Z",
});

const driver = (value: number): Driver => ({
  dialect: "postgres",
  ping: Effect.succeed({ latencyMs: 1 }),
  introspect: Effect.succeed([]),
  describeTable: () => Effect.die("unused"),
  rows: () => Effect.die("unused"),
  query: () => Stream.make({ columns: [{ name: "value", type: "int", nullable: false, isPrimaryKey: false }], rows: [[value]] }),
  explain: () => Effect.succeed("plan"),
  close: Effect.void,
});

const json = (result: Awaited<ReturnType<typeof invokeDbchatTool>>) => JSON.parse(result.content[0]!.text) as Record<string, unknown>;

describe("source-aware agent tools", () => {
  test("requires an explicit database id with multiple sources and records provenance", async () => {
    const events: ChatEvent[] = [];
    const ctx: ToolContext = {
      databases: [
        { connection: connection("c1", "Warehouse"), driver: Effect.succeed(driver(1)) },
        { connection: connection("c2", "Product"), driver: Effect.succeed(driver(2)) },
      ],
      repositories: [],
      messageId: "m1" as MessageId,
      run: Effect.runPromise,
      emit: (event) => Effect.sync(() => void events.push(event)),
      proposeWrite: () => Effect.succeed({ status: "rejected" }),
    };

    const ambiguous = await invokeDbchatTool(ctx, "run_sql", { sql: "select 1" });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content[0]?.text).toContain("sourceId is required");

    const selected = await invokeDbchatTool(ctx, "run_sql", { sourceId: "c2", sql: "select 2" });
    expect(json(selected).source).toEqual({ id: "c2", name: "Product" });
    expect(events[0]).toMatchObject({ _tag: "ResultTable", source: { kind: "database", id: "c2" } });
  });

  test("lists all attached source identities", async () => {
    const ctx = {
      databases: [{ connection: connection("c1", "Warehouse"), driver: Effect.succeed(driver(1)) }],
      repositories: [],
      messageId: "m1" as MessageId,
      run: Effect.runPromise,
      emit: () => Effect.void,
      proposeWrite: () => Effect.succeed({ status: "rejected" as const }),
    } satisfies ToolContext;
    const result = json(await invokeDbchatTool(ctx, "list_sources", {}));
    expect(result.databases).toEqual([expect.objectContaining({ id: "c1", name: "Warehouse" })]);
  });
});
