/**
 * Remote repository fetcher. Remote sources are mirrored into bare clones under
 * `$DBCHAT_HOME/repos/<id>` so every read in `git.ts` (`ls-tree`, `show`) works
 * identically for local worktrees and remote repositories.
 *
 * Tokens are passed per command via `http.extraHeader` (see github.ts) and are
 * never written to disk by git.
 */
import type { GitSyncStatus } from "@dbchat/contracts";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";

import { gitAuthArgs } from "./github.ts";

const FETCH_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 8 * 1024 * 1024;
/** Fetch branches and tags into the bare repo's own namespaces, dropping refs deleted upstream. */
const REFSPECS = ["+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"] as const;

export interface FetchError {
  readonly status: GitSyncStatus;
  readonly message: string;
}

export interface ResolvedHead {
  readonly branch: string;
  readonly headCommit: string;
}

export const repositoryDir = (homeDir: string, id: string): string => join(homeDir, "repos", id);

const run = (dir: string, args: ReadonlyArray<string>, token?: string): Effect.Effect<string, FetchError> =>
  Effect.callback<string, FetchError>((resume) => {
    const child = execFile(
      "git",
      [...gitAuthArgs(token), "-C", dir, ...args],
      {
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT,
        timeout: FETCH_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" },
      },
      (error, stdout, stderr) => {
        if (error) resume(Effect.fail(classify(stderr || error.message, token)));
        else resume(Effect.succeed(stdout.trim()));
      },
    );
    return Effect.sync(() => child.kill());
  });

/** Map git's stderr to a connectivity status without leaking the token (extraHeader is never echoed). */
export const classify = (stderr: string, token: string | undefined): FetchError => {
  const text = stderr.trim();
  const lower = text.toLowerCase();
  const detail = text.split("\n").find((line) => line.startsWith("fatal:") || line.startsWith("error:")) ?? text.split("\n")[0] ?? "git failed";
  if (/authentication failed|could not read username|invalid username or (password|token)|403|permission denied/.test(lower)) {
    return {
      status: "unauthorized",
      message: token ? "GitHub rejected the stored token. Update it and refresh." : "This repository requires a token.",
    };
  }
  if (/repository not found|not found|does not appear to be a git repository/.test(lower)) {
    return { status: "not-found", message: "The remote repository was not found." };
  }
  if (/could not resolve host|unable to access|timed out|connection refused|network is unreachable|etimedout/.test(lower)) {
    return { status: "offline", message: "Could not reach the Git remote." };
  }
  return { status: "error", message: detail.slice(0, 300) };
};

/** Idempotent: creates the bare mirror if missing and points `origin` at `remoteUrl`. */
export const ensureMirror = (dir: string, remoteUrl: string): Effect.Effect<void, FetchError> =>
  Effect.gen(function* () {
    if (!existsSync(join(dir, "HEAD"))) {
      mkdirSync(dir, { recursive: true });
      yield* run(dir, ["init", "--bare", "-q"]);
    }
    const current = yield* run(dir, ["remote", "get-url", "origin"]).pipe(Effect.orElseSucceed(() => ""));
    if (!current) yield* run(dir, ["remote", "add", "origin", remoteUrl]);
    else if (current !== remoteUrl) yield* run(dir, ["remote", "set-url", "origin", remoteUrl]);
  });

/** `git fetch --prune` of all branches and tags. */
export const fetchMirror = (dir: string, token?: string): Effect.Effect<void, FetchError> =>
  run(dir, ["fetch", "--prune", "--no-tags", "-q", "origin", ...REFSPECS], token).pipe(Effect.asVoid);

/** The remote's default branch, as advertised by its symbolic HEAD. */
export const remoteDefaultBranch = (dir: string, token?: string): Effect.Effect<string | undefined, FetchError> =>
  run(dir, ["ls-remote", "--symref", "origin", "HEAD"], token).pipe(
    Effect.map((out) => out.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m)?.[1]),
  );

/** Pin `branch` (branch, tag, or commit) to a commit inside the mirror. */
export const resolveHead = (dir: string, branch: string): Effect.Effect<ResolvedHead, FetchError> =>
  Effect.gen(function* () {
    const candidates = [`refs/heads/${branch}`, `refs/tags/${branch}`, branch];
    for (const candidate of candidates) {
      const sha = yield* run(dir, ["rev-parse", "--verify", "-q", `${candidate}^{commit}`]).pipe(
        Effect.orElseSucceed(() => ""),
      );
      if (sha) return { branch, headCommit: sha };
    }
    return yield* Effect.fail<FetchError>({
      status: "error",
      message: `Branch, tag, or commit "${branch}" does not exist on the remote.`,
    });
  });

export interface SyncInput {
  readonly dir: string;
  readonly remoteUrl: string;
  readonly token?: string;
  /** Requested ref; falls back to the remote's default branch. */
  readonly branch?: string;
}

/** Clone-or-fetch, then resolve the pinned head. The single entry point used by the RPC layer. */
export const syncRemote = (input: SyncInput): Effect.Effect<ResolvedHead, FetchError> =>
  Effect.gen(function* () {
    yield* ensureMirror(input.dir, input.remoteUrl);
    yield* fetchMirror(input.dir, input.token);
    const branch = input.branch?.trim() || (yield* remoteDefaultBranch(input.dir, input.token)) || "main";
    return yield* resolveHead(input.dir, branch);
  });

export const removeMirror = (dir: string): void => {
  rmSync(dir, { recursive: true, force: true });
};
