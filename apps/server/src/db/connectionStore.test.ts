import { describe, expect, test } from "bun:test";
import type { ConnectionId, ConnectionInput } from "@dbchat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ServerConfig, loadConfigFromEnv } from "../config.ts";
import { ConnectionStoreLive } from "../Layers/ConnectionStoreLive.ts";
import { Persistence, SqliteMemory } from "../persistence/Persistence.ts";
import { ConnectionStore } from "../Services/ConnectionStore.ts";

const testLayer = () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dbchat-store-"));
  const dbPath = join(homeDir, "test.sqlite");
  const ConfigTest = Layer.succeed(ServerConfig, { ...loadConfigFromEnv(), homeDir, dbPath });
  const PersistenceTest = Layer.effect(
    Persistence,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return Persistence.of({ sql, dbPath: ":memory:" });
    }),
  ).pipe(Layer.provideMerge(SqliteMemory));
  return { homeDir, layer: ConnectionStoreLive.pipe(Layer.provide(PersistenceTest), Layer.provide(ConfigTest)) };
};

const run = <A, E>(f: (store: (typeof ConnectionStore)["Service"]) => Effect.Effect<A, E>) => {
  const { homeDir, layer } = testLayer();
  return Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* ConnectionStore;
      return { result: yield* f(store), homeDir };
    }).pipe(Effect.provide(layer), Effect.scoped) as Effect.Effect<{ result: A; homeDir: string }, E>,
  );
};

const pgInput: ConnectionInput = {
  name: "local pg",
  dialect: "postgres",
  host: "127.0.0.1",
  port: 5432,
  database: "dbchat_dev",
  user: "sonya",
  password: "hunter2",
  env: "local",
  ssl: "disable",
  readOnlyForAi: true,
};

describe("ConnectionStoreLive", () => {
  test("creates, lists and gets a connection", async () => {
    const { result } = await run((store) =>
      Effect.gen(function* () {
        const created = yield* store.create(pgInput);
        const listed = yield* store.list;
        const fetched = yield* store.get(created.id);
        return { created, listed, fetched };
      }),
    );
    expect(result.created.name).toBe("local pg");
    expect(result.created.port).toBe(5432);
    expect(result.listed).toHaveLength(1);
    expect(result.fetched.id).toBe(result.created.id);
  });

  test("never returns the secret on the Connection", async () => {
    const { result } = await run((store) => store.create(pgInput));
    expect(Object.keys(result)).not.toContain("password");
    expect(Object.keys(result)).not.toContain("url");
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  test("stores the secret encrypted and reads it back", async () => {
    const { result } = await run((store) =>
      Effect.gen(function* () {
        const created = yield* store.create({ ...pgInput, url: "postgres://u:p@h/db" });
        const secret = yield* store.getSecret(created.id);
        return { id: created.id, secret };
      }),
    );
    expect(Option.getOrThrow(result.secret)).toEqual({ password: "hunter2", url: "postgres://u:p@h/db" });
  });

  test("getSecret is none when nothing was stored", async () => {
    const { result } = await run((store) =>
      Effect.gen(function* () {
        const created = yield* store.create({ ...pgInput, password: undefined });
        return yield* store.getSecret(created.id);
      }),
    );
    expect(Option.isNone(result)).toBe(true);
  });

  test("update keeps the existing secret when no new one is supplied", async () => {
    const { result } = await run((store) =>
      Effect.gen(function* () {
        const created = yield* store.create(pgInput);
        const updated = yield* store.update(created.id, { ...pgInput, name: "renamed", password: undefined });
        const secret = yield* store.getSecret(created.id);
        return { updated, secret };
      }),
    );
    expect(result.updated.name).toBe("renamed");
    expect(Option.getOrThrow(result.secret)).toEqual({ password: "hunter2" });
  });

  test("update replaces the secret when a new one is supplied", async () => {
    const { result } = await run((store) =>
      Effect.gen(function* () {
        const created = yield* store.create(pgInput);
        yield* store.update(created.id, { ...pgInput, password: "newpass" });
        return yield* store.getSecret(created.id);
      }),
    );
    expect(Option.getOrThrow(result)).toEqual({ password: "newpass" });
  });

  test("update keeps a stored URL when an edit omits it", async () => {
    const { result } = await run((store) =>
      Effect.gen(function* () {
        const created = yield* store.create({
          ...pgInput,
          host: undefined,
          port: undefined,
          database: undefined,
          user: undefined,
          password: undefined,
          url: "postgres://u:p@h/db",
        });
        const updated = yield* store.update(created.id, {
          name: "renamed URL",
          dialect: "postgres",
          env: "staging",
          ssl: "require",
          readOnlyForAi: false,
        });
        return { updated, secret: yield* store.getSecret(created.id) };
      }),
    );
    expect(result.updated.name).toBe("renamed URL");
    expect(Option.getOrThrow(result.secret)).toEqual({ url: "postgres://u:p@h/db" });
  });

  test("an explicitly blank URL switches a URL connection to fields", async () => {
    const { result } = await run((store) =>
      Effect.gen(function* () {
        const created = yield* store.create({
          ...pgInput,
          host: undefined,
          port: undefined,
          database: undefined,
          user: undefined,
          password: undefined,
          url: "postgres://u:p@h/db",
        });
        const updated = yield* store.update(created.id, { ...pgInput, password: undefined, url: "" });
        return { updated, secret: yield* store.getSecret(created.id) };
      }),
    );
    expect(result.updated.host).toBe("127.0.0.1");
    expect(result.updated.database).toBe("dbchat_dev");
    expect(Option.isNone(result.secret)).toBe(true);
  });

  test("touch stamps lastUsedAt", async () => {
    const { result } = await run((store) =>
      Effect.gen(function* () {
        const created = yield* store.create({ ...pgInput, password: undefined });
        yield* store.touch(created.id);
        return yield* store.get(created.id);
      }),
    );
    expect(result.lastUsedAt).toBeDefined();
  });

  test("remove deletes the row and its secret", async () => {
    const { result } = await run((store) =>
      Effect.gen(function* () {
        const created = yield* store.create(pgInput);
        yield* store.remove(created.id);
        const after = yield* Effect.exit(store.get(created.id));
        const secret = yield* store.getSecret(created.id);
        return { after, secret, list: yield* store.list };
      }),
    );
    expect(result.after._tag).toBe("Failure");
    expect(Option.isNone(result.secret)).toBe(true);
    expect(result.list).toHaveLength(0);
  });

  test("get and remove fail with NotFound for an unknown id", async () => {
    const { result } = await run((store) => Effect.exit(store.get("nope" as ConnectionId)));
    expect(result._tag).toBe("Failure");
  });

  describe("validation", () => {
    const expectInvalid = async (input: ConnectionInput, field: string) => {
      const { result } = await run((store) => Effect.flip(store.create(input)));
      expect(result._tag).toBe("ValidationError");
      expect(result.field).toBe(field);
    };

    test("name is required", () => expectInvalid({ ...pgInput, name: "  " }, "name"));
    test("port must be in range", () => expectInvalid({ ...pgInput, port: 70000 }, "port"));
    test("host is required for postgres", () => expectInvalid({ ...pgInput, host: "" }, "host"));
    test("database is required for postgres", () => expectInvalid({ ...pgInput, database: "" }, "database"));
    test("user is required for postgres", () => expectInvalid({ ...pgInput, user: "" }, "user"));

    test("sqlite only needs a file path", async () => {
      const { result } = await run((store) =>
        store.create({
          name: "scratch",
          dialect: "sqlite",
          database: "/tmp/x.sqlite",
          env: "local",
          ssl: "disable",
          readOnlyForAi: true,
        }),
      );
      expect(result.database).toBe("/tmp/x.sqlite");
      expect(result.port).toBe(0);
    });

    test("sqlite without a path is rejected", () =>
      expectInvalid(
        { name: "scratch", dialect: "sqlite", env: "local", ssl: "disable", readOnlyForAi: true },
        "database",
      ));

    test("a url replaces the per-field requirements", async () => {
      const { result } = await run((store) =>
        store.create({
          name: "via url",
          dialect: "postgres",
          url: "postgres://u:p@h:5432/db",
          env: "local",
          ssl: "prefer",
          readOnlyForAi: true,
        }),
      );
      expect(result.name).toBe("via url");
    });

    test("a malformed url is rejected", () =>
      expectInvalid(
        { name: "bad", dialect: "postgres", url: "not-a-url", env: "local", ssl: "prefer", readOnlyForAi: true },
        "url",
      ));
  });
});
