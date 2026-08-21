import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";

import Migration0001 from "./Migrations/0001_Init.ts";
import Migration0002 from "./Migrations/0002_ThreadModel.ts";
import Migration0003 from "./Migrations/0003_ThreadSources.ts";

/** Append new migrations here: [id, name, effect]. Ids must be increasing. */
export const migrationEntries = [
  [1, "Init", Migration0001],
  [2, "ThreadModel", Migration0002],
  [3, "ThreadSources", Migration0003],
] as const;

const loader = Migrator.fromRecord(
  Object.fromEntries(migrationEntries.map(([id, name, m]) => [`${id}_${name}`, m])),
);

const run = Migrator.make({});

export const runMigrations = Effect.fn("runMigrations")(function* () {
  const executed = yield* run({ loader });
  if (executed.length > 0) {
    yield* Effect.logInfo("migrations applied", { migrations: executed.map(([id, name]) => `${id}_${name}`) });
  }
  return executed;
});
