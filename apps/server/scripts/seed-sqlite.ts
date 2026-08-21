/**
 * Scratch SQLite database for local driver work / `smoke-db.ts`.
 *
 *   bun scripts/seed-sqlite.ts                    # /tmp/dbchat-smoke.sqlite
 *   SQLITE_PATH=/tmp/other.sqlite bun scripts/seed-sqlite.ts
 *
 * Safe to re-run: everything is dropped first.
 */
import { Database } from "bun:sqlite";

const file = process.env.SQLITE_PATH ?? "/tmp/dbchat-smoke.sqlite";
const db = new Database(file, { create: true });

db.exec(`
  DROP VIEW  IF EXISTS paying_users;
  DROP TABLE IF EXISTS orders;
  DROP TABLE IF EXISTS users;

  CREATE TABLE users (
    id         INTEGER PRIMARY KEY,
    email      TEXT NOT NULL,
    plan       TEXT NOT NULL DEFAULT 'free',
    country    TEXT,
    created_at TEXT NOT NULL,
    deleted_at TEXT,
    blob_col   BLOB
  );
  CREATE UNIQUE INDEX users_email_key ON users (email);
  CREATE INDEX users_plan_idx ON users (plan);

  CREATE TABLE orders (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    total_cents INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'paid',
    placed_at   TEXT NOT NULL
  );
  CREATE INDEX orders_user_idx ON orders (user_id);

  CREATE VIEW paying_users AS SELECT * FROM users WHERE plan <> 'free';
`);

const USERS = 2_000;
const countries = ["US", "GB", "DE", "FR", "JP"];
const insertUser = db.prepare(
  "INSERT INTO users (id, email, plan, country, created_at, blob_col) VALUES (?, ?, ?, ?, ?, ?)",
);
const insertOrder = db.prepare(
  "INSERT INTO orders (id, user_id, total_cents, status, placed_at) VALUES (?, ?, ?, ?, ?)",
);

db.transaction(() => {
  for (let i = 1; i <= USERS; i++) {
    insertUser.run(
      i,
      `user${String(i).padStart(5, "0")}@example.com`,
      i % 3 === 0 ? "pro" : "free",
      countries[i % countries.length]!,
      new Date(Date.now() - i * 3_600_000).toISOString(),
      new Uint8Array([0xce, i % 256, (i >> 8) % 256]),
    );
    insertOrder.run(i, i, i * 137, i % 7 === 0 ? "refunded" : "paid", new Date(Date.now() - i * 60_000).toISOString());
  }
})();

db.close();
console.log(`seeded ${file}: ${USERS} users, ${USERS} orders`);
