/**
 * End-to-end driver smoke test over the real RPC socket.
 *
 *   bun run start                       # in one terminal (or `bun run dev`)
 *   bun scripts/smoke-db.ts             # postgres (default)
 *   DBCHAT_SMOKE=mysql  bun scripts/smoke-db.ts
 *   DBCHAT_SMOKE=sqlite bun scripts/smoke-db.ts
 *
 * It creates a connection, tests it, connects, introspects, reads a page of
 * rows with sort + filter, checks that a write is blocked on the read-only
 * path, exercises the write path (DDL/DML row counts, transactional rollback,
 * result-set column types) against a scratch table, and deletes the connection
 * again.
 */
import { type ConnectionInput, DbchatRpcs, RPC } from "@dbchat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

const url = process.env.DBCHAT_RPC_URL ?? "ws://127.0.0.1:4800/rpc";
const target = (process.env.DBCHAT_SMOKE ?? "postgres") as "postgres" | "mysql" | "sqlite";

const inputs: Record<typeof target, { input: ConnectionInput; schema: string; table: string; filterColumn: string }> = {
  postgres: {
    input: {
      name: "smoke-pg",
      dialect: "postgres",
      host: process.env.PGHOST ?? "127.0.0.1",
      port: Number(process.env.PGPORT ?? 5432),
      database: process.env.PGDATABASE ?? "dbchat_dev",
      user: process.env.PGUSER ?? process.env.USER ?? "postgres",
      ...(process.env.PGPASSWORD ? { password: process.env.PGPASSWORD } : {}),
      env: "local",
      ssl: "disable",
      readOnlyForAi: true,
    },
    schema: "public",
    table: "users",
    filterColumn: "plan",
  },
  mysql: {
    input: {
      name: "smoke-mysql",
      dialect: "mysql",
      host: process.env.MYSQL_HOST ?? "127.0.0.1",
      port: Number(process.env.MYSQL_PORT ?? 3307),
      database: process.env.MYSQL_DATABASE ?? "dbchat_dev",
      user: process.env.MYSQL_USER ?? "root",
      password: process.env.MYSQL_PASSWORD ?? "dev",
      env: "local",
      ssl: "disable",
      readOnlyForAi: true,
    },
    schema: process.env.MYSQL_DATABASE ?? "dbchat_dev",
    table: "users",
    filterColumn: "plan",
  },
  sqlite: {
    input: {
      name: "smoke-sqlite",
      dialect: "sqlite",
      database: process.env.SQLITE_PATH ?? "/tmp/dbchat-smoke.sqlite",
      env: "local",
      ssl: "disable",
      readOnlyForAi: true,
    },
    schema: "main",
    table: "users",
    filterColumn: "plan",
  },
};

const ProtocolLive = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(Socket.layerWebSocket(url)),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provide(RpcSerialization.layerJson),
);

const step = (label: string) => console.log(`\n── ${label}`);

const program = Effect.gen(function* () {
  const plan = inputs[target];
  const client = yield* RpcClient.make(DbchatRpcs);

  step("server.health");
  console.log(yield* client[RPC.serverHealth]());

  step("connection.test");
  const test = yield* client[RPC.connectionTest]({ input: plan.input });
  console.log(test);
  if (!test.ok) return yield* Effect.die(new Error(`connection.test failed: ${test.error ?? "unknown"}`));

  step("connection.create");
  const connection = yield* client[RPC.connectionCreate](plan.input);
  console.log({ id: connection.id, name: connection.name, dialect: connection.dialect });
  // Secrets must never come back over the wire.
  const leaked = Object.keys(connection).filter((k) => k === "password" || k === "url");
  if (leaked.length > 0) {
    return yield* Effect.die(new Error(`connection payload leaked: ${leaked.join(", ")}`));
  }

  const cleanup = Effect.gen(function* () {
    step("connection.delete");
    yield* client[RPC.connectionDelete]({ id: connection.id });
    console.log("deleted", connection.id);
  });

  const body = Effect.gen(function* () {
    step("connection.connect");
    console.log(yield* client[RPC.connectionConnect]({ id: connection.id }));

    step("schema.list");
    const schemas = yield* client[RPC.schemaList]({ connectionId: connection.id });
    for (const s of schemas) console.log(` ${s.name}: ${s.tables.map((t) => `${t.name}(${t.rowEstimate})`).join(", ")}`);

    step("schema.table");
    const detail = yield* client[RPC.schemaTable]({
      connectionId: connection.id,
      schema: plan.schema,
      table: plan.table,
    });
    console.log(` columns: ${detail.columns.map((c) => `${c.name}:${c.type}${c.isPrimaryKey ? " PK" : ""}`).join(", ")}`);
    console.log(` indexes: ${detail.indexes.map((i) => `${i.name}${i.unique ? " (unique)" : ""}`).join(", ")}`);

    step("table.rows (sort + filter)");
    const page = yield* client[RPC.tableRows]({
      connectionId: connection.id,
      schema: plan.schema,
      table: plan.table,
      offset: 0,
      limit: 5,
      sort: [{ column: "id", dir: "desc" }],
      filters: [{ column: plan.filterColumn, op: "eq", value: "pro" }],
    });
    console.log(` total=${page.total} rows=${page.rows.length}`);
    console.log(` first=${JSON.stringify(page.rows[0])}`);

    step("sql.run (read)");
    const result = yield* client[RPC.sqlRun]({
      connectionId: connection.id,
      sql: `select count(*) as n from ${plan.table}`,
      readOnly: true,
      limit: 10,
    });
    console.log(` ${result.rowCount} row(s) in ${result.durationMs}ms:`, result.rows[0]);

    step("sql.run (write under readOnly => WriteBlocked)");
    const blocked = yield* client[RPC.sqlRun]({
      connectionId: connection.id,
      sql: `update ${plan.table} set plan = 'pro'`,
      readOnly: true,
    }).pipe(Effect.flip, Effect.option);
    console.log(" ", JSON.stringify(blocked));

    step("sql.run (write path: transaction + affectedRows + column types)");
    const scratch = "dbchat_smoke_tmp";
    const write = (sql: string) =>
      client[RPC.sqlRun]({ connectionId: connection.id, sql, readOnly: false });

    yield* write(`drop table if exists ${scratch}`);
    yield* write(`create table ${scratch} (id int, n int)`);
    const inserted = yield* write(`insert into ${scratch} (id, n) values (1, 10), (2, 20), (3, 30)`);
    console.log(` insert -> rowCount=${inserted.rowCount} (expected 3)`);
    if (inserted.rowCount !== 3) return yield* Effect.die(new Error(`insert rowCount ${inserted.rowCount} != 3`));

    const updated = yield* write(`update ${scratch} set n = n + 1 where id <= 2`);
    console.log(` update -> rowCount=${updated.rowCount} (expected 2)`);
    if (updated.rowCount !== 2) return yield* Effect.die(new Error(`update rowCount ${updated.rowCount} != 2`));

    const deleted = yield* write(`delete from ${scratch} where id = 3`);
    console.log(` delete -> rowCount=${deleted.rowCount} (expected 1)`);
    if (deleted.rowCount !== 1) return yield* Effect.die(new Error(`delete rowCount ${deleted.rowCount} != 1`));

    // A failing multi-statement batch must leave nothing behind.
    const rolledBack = yield* write(
      `insert into ${scratch} (id, n) values (9, 90); insert into ${scratch} (id, n) values (10, 'nope', 1)`,
    ).pipe(Effect.flip, Effect.option);
    console.log(` rollback probe -> ${rolledBack._tag === "Some" ? "failed as expected" : "UNEXPECTEDLY SUCCEEDED"}`);
    const after = yield* client[RPC.sqlRun]({
      connectionId: connection.id,
      sql: `select count(*) as n from ${scratch}`,
      readOnly: true,
    });
    console.log(` rows after rollback = ${JSON.stringify(after.rows[0])} (expected 2)`);

    step("sql.run (read: column types)");
    const typed = yield* client[RPC.sqlRun]({
      connectionId: connection.id,
      sql: `select id, n from ${scratch} order by id`,
      readOnly: true,
    });
    console.log(` columns: ${typed.columns.map((c) => `${c.name}:${c.type}`).join(", ")}`);
    const untyped = typed.columns.filter((c) => c.type === "unknown");
    if (untyped.length > 0) {
      return yield* Effect.die(new Error(`columns still unknown: ${untyped.map((c) => c.name).join(", ")}`));
    }
    yield* write(`drop table ${scratch}`);

    step("schema.refresh");
    const refreshed = yield* client[RPC.schemaRefresh]({ connectionId: connection.id });
    console.log(` ${refreshed.length} schema(s)`);

    step("connection.disconnect");
    yield* client[RPC.connectionDisconnect]({ id: connection.id });
    console.log(" ok");
  });

  yield* Effect.ensuring(body, cleanup.pipe(Effect.orDie));
}).pipe(Effect.scoped, Effect.provide(ProtocolLive));

await Effect.runPromise(program);
console.log("\nsmoke-db: OK");
process.exit(0);
