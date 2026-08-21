import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { ServerConfig } from "../config.ts";
import { runMigrations } from "./Migrations.ts";

export interface PersistenceShape {
  readonly sql: SqlClient.SqlClient;
  readonly dbPath: string;
}

/** App-state store (sqlite). Provides the SqlClient used by repositories. */
export class Persistence extends Context.Service<Persistence, PersistenceShape>()("dbchat/Persistence") {}

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA foreign_keys = ON`;
    yield* sql`PRAGMA journal_mode = WAL`;
    yield* runMigrations();
  }),
);

const makeSqliteLayer = (filename: string) =>
  Layer.provideMerge(setup, SqliteClient.layer({ filename }));

/** SqlClient + migrations at the configured db path. */
export const SqliteLive = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    yield* Effect.sync(() => mkdirSync(dirname(dbPath), { recursive: true }));
    return makeSqliteLayer(dbPath);
  }),
);

/** In-memory variant for tests. */
export const SqliteMemory = makeSqliteLayer(":memory:");

export const PersistenceLive = Layer.effect(
  Persistence,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { dbPath } = yield* ServerConfig;
    return Persistence.of({ sql, dbPath });
  }),
).pipe(Layer.provideMerge(SqliteLive));
