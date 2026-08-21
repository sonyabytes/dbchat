import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RowsRequest } from "@dbchat/contracts";
import { makeSqliteDriver } from "./sqlite.ts";

const seed = (): string => {
  const file = join(mkdtempSync(join(tmpdir(), "dbchat-sqlite-")), "test.db");
  const db = new Database(file, { create: true });
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      plan TEXT DEFAULT 'free',
      deleted_at TEXT
    );
    CREATE UNIQUE INDEX users_email_idx ON users(email);
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      total_cents INTEGER NOT NULL
    );
    CREATE VIEW paying_users AS SELECT * FROM users WHERE plan <> 'free';
  `);
  const insertUser = db.prepare("INSERT INTO users (id, email, plan) VALUES (?, ?, ?)");
  const insertOrder = db.prepare("INSERT INTO orders (id, user_id, total_cents) VALUES (?, ?, ?)");
  for (let i = 1; i <= 50; i++) {
    insertUser.run(i, `user${String(i).padStart(3, "0")}@example.com`, i % 3 === 0 ? "pro" : "free");
    insertOrder.run(i, i, i * 100);
  }
  db.close();
  return file;
};

const withDriver = <A>(f: (d: Awaited<ReturnType<typeof open>>) => Promise<A>) => f;
const open = async (file: string) => Effect.runPromise(makeSqliteDriver({ filename: file }));

const rowsReq = (over: Partial<RowsRequest> = {}): RowsRequest => ({
  connectionId: "c1" as RowsRequest["connectionId"],
  schema: "main",
  table: "users",
  offset: 0,
  limit: 10,
  ...over,
});

describe("sqlite driver", () => {
  test("ping reports a version", async () => {
    const d = await open(seed());
    const res = await Effect.runPromise(d.ping);
    expect(res.serverVersion).toContain("SQLite");
    await Effect.runPromise(d.close);
  });

  test("introspect lists tables and views under `main`", async () => {
    const d = await open(seed());
    const schemas = await Effect.runPromise(d.introspect);
    expect(schemas).toHaveLength(1);
    expect(schemas[0]!.name).toBe("main");
    const names = schemas[0]!.tables.map((t) => `${t.name}:${t.kind}`).sort();
    expect(names).toEqual(["orders:table", "paying_users:view", "users:table"]);
    expect(schemas[0]!.tables.find((t) => t.name === "users")!.rowEstimate).toBe(50);
    await Effect.runPromise(d.close);
  });

  test("describeTable returns columns, pk, fk and indexes", async () => {
    const d = await open(seed());
    const users = await Effect.runPromise(d.describeTable("main", "users"));
    expect(users.columns.map((c) => c.name)).toEqual(["id", "email", "plan", "deleted_at"]);
    expect(users.columns[0]!.isPrimaryKey).toBe(true);
    expect(users.columns[1]!.nullable).toBe(false);
    expect(users.columns[2]!.default).toBe("'free'");
    expect(users.indexes.some((i) => i.name === "users_email_idx" && i.unique)).toBe(true);

    const orders = await Effect.runPromise(d.describeTable("main", "orders"));
    const fk = orders.columns.find((c) => c.name === "user_id")!.foreignKey;
    expect(fk).toEqual({ table: "users", column: "id" });
    await Effect.runPromise(d.close);
  });

  test("describeTable fails with NotFound for a missing table", async () => {
    const d = await open(seed());
    const exit = await Effect.runPromise(Effect.exit(d.describeTable("main", "nope")));
    expect(exit._tag).toBe("Failure");
    await Effect.runPromise(d.close);
  });

  test("rows paginates, sorts and filters", async () => {
    const d = await open(seed());
    const page = await Effect.runPromise(
      d.rows(rowsReq({ limit: 5, offset: 0, sort: [{ column: "id", dir: "desc" }] })),
    );
    expect(page.rows).toHaveLength(5);
    expect(page.rows[0]![0]).toBe(50);
    expect(page.total).toBe(50);
    expect(page.columns.map((c) => c.name)).toEqual(["id", "email", "plan", "deleted_at"]);

    const filtered = await Effect.runPromise(
      d.rows(rowsReq({ limit: 100, filters: [{ column: "plan", op: "eq", value: "pro" }] })),
    );
    expect(filtered.rows.length).toBe(16);
    expect(filtered.total).toBe(16);

    const nulls = await Effect.runPromise(
      d.rows(rowsReq({ limit: 100, filters: [{ column: "deleted_at", op: "is_null" }] })),
    );
    expect(nulls.rows.length).toBe(50);
    await Effect.runPromise(d.close);
  });

  test("query streams a read under readOnly", async () => {
    const d = await open(seed());
    const batches = await Effect.runPromise(
      Stream.runCollect(d.query("select id, email from users order by id", { readOnly: true, limit: 20 })),
    );
    const rows = batches.flatMap((b) => b.rows);
    expect(rows).toHaveLength(20);
    expect(batches[0]!.columns.map((c) => c.name)).toEqual(["id", "email"]);
    await Effect.runPromise(d.close);
  });

  test("query blocks a write under readOnly", async () => {
    const d = await open(seed());
    const exit = await Effect.runPromise(
      Effect.exit(Stream.runCollect(d.query("update users set plan = 'pro'", { readOnly: true }))),
    );
    expect(exit._tag).toBe("Failure");
    const rendered = JSON.stringify(exit);
    expect(rendered).toContain("WriteBlocked");
    await Effect.runPromise(d.close);
  });

  test("query allows a write when readOnly is off", async () => {
    const file = seed();
    const d = await open(file);
    await Effect.runPromise(Stream.runCollect(d.query("update users set plan = 'pro' where id = 1")));
    const page = await Effect.runPromise(
      d.rows(rowsReq({ limit: 1, filters: [{ column: "id", op: "eq", value: 1 }] })),
    );
    expect(page.rows[0]![2]).toBe("pro");
    await Effect.runPromise(d.close);
  });

  test("query reports affectedRows for a write, not the (empty) row list", async () => {
    const file = seed();
    const d = await open(file);
    const batches = await Effect.runPromise(
      Stream.runCollect(d.query("update users set plan = 'pro' where id <= 5", { readOnly: false })),
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]!.affectedRows).toBe(5);
    expect(batches[0]!.rows).toHaveLength(0);
    await Effect.runPromise(d.close);
  });

  test("query keeps RETURNING rows alongside affectedRows", async () => {
    const d = await open(seed());
    const batches = await Effect.runPromise(
      Stream.runCollect(
        d.query("insert into users (id, email, plan) values (900, 'new@example.com', 'pro') returning id, email", {
          readOnly: false,
        }),
      ),
    );
    expect(batches[0]!.affectedRows).toBe(1);
    expect(batches[0]!.rows).toEqual([[900, "new@example.com"]]);
    await Effect.runPromise(d.close);
  });

  test("a multi-statement write is atomic and sums its changes", async () => {
    const file = seed();
    const d = await open(file);
    const batches = await Effect.runPromise(
      Stream.runCollect(
        d.query("update users set plan = 'a' where id <= 2; update users set plan = 'b' where id = 3", {
          readOnly: false,
        }),
      ),
    );
    expect(batches[0]!.affectedRows).toBe(3);

    // The second statement fails => nothing from the batch is committed.
    const exit = await Effect.runPromise(
      Effect.exit(
        Stream.runCollect(
          d.query("update users set plan = 'z' where id = 1; update nope set plan = 'z'", { readOnly: false }),
        ),
      ),
    );
    expect(exit._tag).toBe("Failure");
    const page = await Effect.runPromise(
      d.rows(rowsReq({ limit: 1, filters: [{ column: "id", op: "eq", value: 1 }] })),
    );
    expect(page.rows[0]![2]).toBe("a");
    await Effect.runPromise(d.close);
  });

  test("SELECT columns carry the declared type, expressions the runtime one", async () => {
    const d = await open(seed());
    const batches = await Effect.runPromise(
      Stream.runCollect(
        d.query("select id, email, count(*) as n, 1.5 as ratio from users group by id, email limit 1", {
          readOnly: true,
        }),
      ),
    );
    expect(batches[0]!.columns).toEqual([
      { name: "id", type: "integer", nullable: true, isPrimaryKey: false },
      { name: "email", type: "text", nullable: true, isPrimaryKey: false },
      { name: "n", type: "integer", nullable: true, isPrimaryKey: false },
      { name: "ratio", type: "float", nullable: true, isPrimaryKey: false },
    ]);
    await Effect.runPromise(d.close);
  });

  test("explain returns a query plan", async () => {
    const d = await open(seed());
    const plan = await Effect.runPromise(d.explain("select * from users where email = 'x'"));
    expect(plan.toLowerCase()).toContain("users");
    await Effect.runPromise(d.close);
  });

  test("explain plans a single statement", async () => {
    const d = await open(seed());
    const plan = await Effect.runPromise(d.explain("select * from users where id = 1"));
    expect(plan.length).toBeGreaterThan(0);
    await Effect.runPromise(d.close);
  });

  test("explain refuses a second statement and never executes it", async () => {
    const file = seed();
    const d = await open(file);
    const exit = await Effect.runPromise(Effect.exit(d.explain("select 1; create table pwned(id int)")));
    expect(exit._tag).toBe("Failure");
    const tables = await Effect.runPromise(
      Stream.runCollect(d.query("select name from sqlite_master where name = 'pwned'", { readOnly: true })),
    );
    expect([...tables].flatMap((b) => b.rows)).toEqual([]);
    await Effect.runPromise(d.close);
  });

  test("readOnly query cannot write even while another fiber holds the write handle", async () => {
    const file = seed();
    const d = await open(file);
    // A write on the shared handle in flight does not weaken the read path.
    const exit = await Effect.runPromise(
      Effect.exit(Stream.runCollect(d.query("delete from users", { readOnly: true }))),
    );
    expect(exit._tag).toBe("Failure");
    const count = await Effect.runPromise(
      Stream.runCollect(d.query("select count(*) from users", { readOnly: true })),
    );
    expect(Number([...count][0]?.rows[0]?.[0])).toBeGreaterThan(0);
    await Effect.runPromise(d.close);
  });
});

export { withDriver };
