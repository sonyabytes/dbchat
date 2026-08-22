import { afterEach, expect, test } from "bun:test";

import type { ConnectionId } from "@dbchat/contracts";
import * as Effect from "effect/Effect";

import { makeTempHome, seedConnection, testPersistenceLayer } from "../sql/testLayers.ts";
import { type ChatRepoShape, makeChatRepo } from "./repo.ts";

const connectionId = "c_chatrepo" as ConnectionId;

const homes: Array<() => void> = [];
afterEach(() => {
  while (homes.length > 0) homes.pop()?.();
});

/** Runs `f` against a fresh migrated sqlite in a temp DBCHAT_HOME. */
const withRepo = <A, E>(f: (repo: ChatRepoShape) => Effect.Effect<A, E>): Promise<A> => {
  const home = makeTempHome();
  homes.push(home.cleanup);
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* seedConnection(connectionId);
      return yield* f(yield* makeChatRepo);
    }).pipe(Effect.provide(testPersistenceLayer(home.dir))),
  );
};

test("a new thread has no model until one is set", async () => {
  const thread = await withRepo((repo) =>
    Effect.gen(function* () {
      const created = yield* repo.createThread("hi", [{ kind: "database", id: connectionId }]);
      return yield* repo.getThread(created.id);
    }),
  );
  expect(thread.model).toBeUndefined();
});

test("setThreadModel persists and survives a re-read (migration 0002 column)", async () => {
  const out = await withRepo((repo) =>
    Effect.gen(function* () {
      const created = yield* repo.createThread("hi", [{ kind: "database", id: connectionId }]);
      yield* repo.setThreadModel(created.id, "claude-opus-5");
      const afterSet = yield* repo.getThread(created.id);
      yield* repo.setThreadModel(created.id, "claude-haiku-4-5");
      const afterSwitch = yield* repo.getThread(created.id);
      const listed = yield* repo.listThreads();
      return { afterSet, afterSwitch, listed };
    }),
  );
  expect(out.afterSet.model).toBe("claude-opus-5");
  expect(out.afterSwitch.model).toBe("claude-haiku-4-5");
  expect(out.listed.map((t) => t.model)).toEqual(["claude-haiku-4-5"]);
});

test("the model is independent of the sdk session id", async () => {
  const thread = await withRepo((repo) =>
    Effect.gen(function* () {
      const created = yield* repo.createThread("hi", [{ kind: "database", id: connectionId }]);
      yield* repo.setThreadModel(created.id, "claude-opus-5");
      yield* repo.setSdkSessionId(created.id, "sess_1");
      yield* repo.setThreadTitle(created.id, "renamed");
      return yield* repo.getThread(created.id);
    }),
  );
  expect(thread).toMatchObject({ model: "claude-opus-5", sdkSessionId: "sess_1", title: "renamed" });
});

test("threads can exist without a database and can attach several source kinds", async () => {
  const out = await withRepo((repo) => Effect.gen(function* () {
    const thread = yield* repo.createThread("general research", []);
    const now = new Date().toISOString();
    const repository = {
      id: "repo_test" as never,
      name: "analytics",
      origin: "local" as const,
      path: "/tmp/analytics",
      branch: "main",
      headCommit: "abc123",
      status: "connected" as const,
      hasToken: false,
      createdAt: now,
      updatedAt: now,
    };
    yield* repo.insertGitRepository(repository);
    const updated = yield* repo.setThreadSources(thread.id, [
      { kind: "database", id: connectionId },
      { kind: "git", id: repository.id },
    ]);
    return { thread, updated };
  }));
  expect(out.thread.sources).toEqual([]);
  expect(out.updated.sources).toEqual([
    { kind: "database", id: connectionId },
    { kind: "git", id: "repo_test" as never },
  ]);
});
