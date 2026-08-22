import { afterEach, describe, expect, test } from "bun:test";
import type { GitRepository, RepositoryId } from "@dbchat/contracts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";

import { inspectGitRepository, readGitFile } from "./git.ts";
import { classify, removeMirror, repositoryDir, syncRemote } from "./gitFetcher.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A throwaway "remote": a worktree with one commit on `main`, addressed via file:// like any other URL. */
const remote = () => {
  const path = mkdtempSync(join(tmpdir(), "dbchat-remote-"));
  dirs.push(path);
  execFileSync("git", ["init", "-b", "main", path]);
  git(path, "config", "user.email", "tests@dbchat.local");
  git(path, "config", "user.name", "dbchat tests");
  writeFileSync(join(path, "orders.sql"), "select 1");
  git(path, "add", ".");
  git(path, "commit", "-m", "one");
  return { path, url: `file://${path}` };
};

const home = () => {
  const dir = mkdtempSync(join(tmpdir(), "dbchat-home-"));
  dirs.push(dir);
  return dir;
};

describe("syncRemote", () => {
  test("clones into a bare mirror and pins the remote default branch", async () => {
    const upstream = remote();
    const dir = repositoryDir(home(), "repo_1");
    const head = await Effect.runPromise(syncRemote({ dir, remoteUrl: upstream.url }));
    expect(head.branch).toBe("main");
    expect(head.headCommit).toBe(git(upstream.path, "rev-parse", "HEAD"));
    expect(existsSync(join(dir, "HEAD"))).toBe(true);
    // The mirror is readable through the same code path as a local worktree.
    const repository: GitRepository = {
      id: "repo_1" as RepositoryId, name: "r", origin: "github", path: dir, remoteUrl: upstream.url,
      branch: head.branch, headCommit: head.headCommit, status: "connected", hasToken: false,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(inspectGitRepository(repository).map((m) => m.path)).toEqual(["orders.sql"]);
    expect(readGitFile(repository, "orders.sql")).toBe("select 1");
  });

  test("a second sync fetches new commits and follows the requested branch", async () => {
    const upstream = remote();
    const dir = repositoryDir(home(), "repo_2");
    const first = await Effect.runPromise(syncRemote({ dir, remoteUrl: upstream.url }));

    git(upstream.path, "checkout", "-q", "-b", "feature");
    writeFileSync(join(upstream.path, "customers.sql"), "select 2");
    git(upstream.path, "add", ".");
    git(upstream.path, "commit", "-m", "two");
    const featureSha = git(upstream.path, "rev-parse", "HEAD");

    const main = await Effect.runPromise(syncRemote({ dir, remoteUrl: upstream.url, branch: "main" }));
    expect(main.headCommit).toBe(first.headCommit);
    const feature = await Effect.runPromise(syncRemote({ dir, remoteUrl: upstream.url, branch: "feature" }));
    expect(feature.headCommit).toBe(featureSha);
  });

  test("resolves tags and reports unknown refs", async () => {
    const upstream = remote();
    git(upstream.path, "-c", "tag.gpgSign=false", "tag", "v1");
    const dir = repositoryDir(home(), "repo_3");
    const tagged = await Effect.runPromise(syncRemote({ dir, remoteUrl: upstream.url, branch: "v1" }));
    expect(tagged.headCommit).toBe(git(upstream.path, "rev-parse", "HEAD"));

    const missing = await Effect.runPromise(Effect.result(syncRemote({ dir, remoteUrl: upstream.url, branch: "nope" })));
    expect(missing._tag).toBe("Failure");
    if (missing._tag === "Failure") expect(missing.failure.message).toContain('"nope"');
  });

  test("unreachable remotes keep the mirror but fail with a classified status", async () => {
    const dir = repositoryDir(home(), "repo_4");
    const result = await Effect.runPromise(Effect.result(syncRemote({ dir, remoteUrl: `file://${join(tmpdir(), "does-not-exist-dbchat")}` })));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(["not-found", "error"]).toContain(result.failure.status);
    removeMirror(dir);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("classify", () => {
  test.each([
    ["fatal: Authentication failed for 'https://github.com/a/b/'", "unauthorized"],
    ["remote: Repository not found.\nfatal: repository 'https://github.com/a/b/' not found", "not-found"],
    ["fatal: unable to access 'https://github.com/a/b/': Could not resolve host: github.com", "offline"],
    ["fatal: something else went wrong", "error"],
  ] as const)("%j → %s", (stderr, status) => {
    expect(classify(stderr, "tok").status).toBe(status);
  });

  test("never echoes the token", () => {
    expect(classify("fatal: Authentication failed", "ghp_secret").message).not.toContain("ghp_secret");
  });
});
