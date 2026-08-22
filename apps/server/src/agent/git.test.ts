import { afterEach, describe, expect, test } from "bun:test";
import type { GitRepository, RepositoryId } from "@dbchat/contracts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as Effect from "effect/Effect";

import { inspectGitInput, inspectGitRepository, readGitFile, searchGitRepository } from "./git.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const fixture = () => {
  const path = mkdtempSync(join(tmpdir(), "dbchat-git-"));
  dirs.push(path);
  execFileSync("git", ["init", "-b", "main", path]);
  execFileSync("git", ["-C", path, "config", "user.email", "tests@dbchat.local"]);
  execFileSync("git", ["-C", path, "config", "user.name", "dbchat tests"]);
  mkdirSync(join(path, "models", "marts"), { recursive: true });
  writeFileSync(join(path, "models", "marts", "orders.sql"), "select * from {{ ref('stg_orders') }}");
  writeFileSync(join(path, "models", "marts", "schema.yml"), "models:\n  - name: orders\n    description: Customer orders\n");
  writeFileSync(join(path, ".env"), "SECRET=never-index-this");
  execFileSync("git", ["-C", path, "add", "."]);
  execFileSync("git", ["-C", path, "commit", "-m", "fixture"]);
  return path;
};

describe("Git/dbt context", () => {
  test("pins a repository ref and indexes only supported model context", async () => {
    const path = fixture();
    const inspected = await Effect.runPromise(inspectGitInput({ name: "Analytics", path }));
    const repository: GitRepository = {
      id: "repo1" as RepositoryId,
      ...inspected,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const models = inspectGitRepository(repository);
    expect(models.map((model) => model.path)).toEqual(["models/marts/orders.sql", "models/marts/schema.yml"]);
    expect(models.find((model) => model.name === "orders")?.upstream).toEqual(["stg_orders"]);
    expect(readGitFile(repository, "models/marts/orders.sql")).toContain("stg_orders");
    expect(searchGitRepository(repository, "Customer orders")[0]?.path).toBe("models/marts/schema.yml");
  });

  test("rejects folders that are not Git repositories", async () => {
    const path = mkdtempSync(join(tmpdir(), "dbchat-not-git-"));
    dirs.push(path);
    const result = await Effect.runPromise(Effect.result(inspectGitInput({ name: "Nope", path })));
    expect(result._tag).toBe("Failure");
  });
});
