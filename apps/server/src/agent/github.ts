/**
 * GitHub connectivity: URL normalisation, a pre-clone probe against the REST
 * API, and per-invocation auth for git so tokens never land in `.git/config`.
 */
import type { GitHubConnectionTest, GitSyncStatus } from "@dbchat/contracts";
import { ValidationError } from "@dbchat/contracts";
import * as Effect from "effect/Effect";

export interface GitHubRef {
  readonly owner: string;
  readonly repo: string;
  /** Canonical clone URL without credentials. */
  readonly remoteUrl: string;
}

const NAME = /^[A-Za-z0-9_.-]+$/;

/**
 * Accepts `owner/repo`, `github.com/owner/repo`, `https://github.com/owner/repo(.git)`,
 * `git@github.com:owner/repo(.git)`, and `ssh://git@github.com/owner/repo`.
 */
export const parseGitHubUrl = (raw: string): GitHubRef | undefined => {
  const input = raw.trim().replace(/\/+$/, "");
  if (!input) return undefined;
  let rest: string | undefined;
  const ssh = input.match(/^(?:ssh:\/\/)?git@github\.com[:/](.+)$/i);
  const https = input.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i);
  if (ssh) rest = ssh[1];
  else if (https) rest = https[1];
  else if (!input.includes("://") && !input.includes("@") && input.split("/").length === 2) rest = input;
  if (!rest) return undefined;
  const [owner, repoRaw, ...extra] = rest.split("/");
  if (extra.length > 0 || !owner || !repoRaw) return undefined;
  const repo = repoRaw.replace(/\.git$/i, "");
  if (!NAME.test(owner) || !NAME.test(repo)) return undefined;
  return { owner, repo, remoteUrl: `https://github.com/${owner}/${repo}` };
};

/**
 * Git config flags that authenticate a single command. Using `http.extraHeader`
 * keeps the token out of the remote URL (and therefore out of `.git/config`,
 * process listings, and error messages).
 */
export const gitAuthArgs = (token: string | undefined): ReadonlyArray<string> =>
  token
    ? ["-c", `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`]
    : [];

export interface GitHubProbeError {
  readonly status: GitSyncStatus;
  readonly message: string;
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const API = "https://api.github.com";

const headersFor = (token: string | undefined): Record<string, string> => ({
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "dbchat",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

/**
 * One round-trip to `GET /repos/:owner/:repo` classifies the failure mode
 * (bad token vs. missing repo vs. no network) before we spend a clone on it.
 * With a token we also resolve the login so the UI can show who we're acting as.
 */
export const probeGitHub = (
  ref: GitHubRef,
  token: string | undefined,
  fetcher: Fetcher = fetch,
): Effect.Effect<GitHubConnectionTest, GitHubProbeError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => fetcher(`${API}/repos/${ref.owner}/${ref.repo}`, {
        headers: headersFor(token),
        signal: AbortSignal.timeout(10_000),
      }),
      catch: (error): GitHubProbeError => ({
        status: "offline",
        message: `Could not reach api.github.com: ${error instanceof Error ? error.message : String(error)}`,
      }),
    });
    if (response.status === 401) {
      return yield* Effect.fail<GitHubProbeError>({ status: "unauthorized", message: "GitHub rejected the token." });
    }
    if (response.status === 403) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      return yield* Effect.fail<GitHubProbeError>({
        status: remaining === "0" ? "offline" : "unauthorized",
        message: remaining === "0"
          ? "GitHub API rate limit exhausted; add a token or retry later."
          : "The token does not have access to this repository (needs `repo` or Contents: read).",
      });
    }
    if (response.status === 404) {
      return yield* Effect.fail<GitHubProbeError>({
        status: "not-found",
        message: token
          ? `${ref.owner}/${ref.repo} was not found, or the token cannot see it.`
          : `${ref.owner}/${ref.repo} was not found. Private repositories need a token.`,
      });
    }
    if (!response.ok) {
      return yield* Effect.fail<GitHubProbeError>({ status: "error", message: `GitHub returned HTTP ${response.status}.` });
    }
    const body = (yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: (): GitHubProbeError => ({ status: "error", message: "GitHub returned an unreadable response." }),
    })) as { default_branch?: unknown; private?: unknown };
    const remaining = Number(response.headers.get("x-ratelimit-remaining"));

    let tokenUser: string | undefined;
    if (token) {
      const me = yield* Effect.tryPromise({
        try: () => fetcher(`${API}/user`, { headers: headersFor(token), signal: AbortSignal.timeout(10_000) }),
        catch: (): GitHubProbeError => ({ status: "offline", message: "Could not reach api.github.com." }),
      });
      if (me.ok) {
        const user = (yield* Effect.promise(() => me.json() as Promise<{ login?: unknown }>));
        if (typeof user.login === "string") tokenUser = user.login;
      }
    }

    return {
      owner: ref.owner,
      repo: ref.repo,
      remoteUrl: ref.remoteUrl,
      defaultBranch: typeof body.default_branch === "string" ? body.default_branch : "main",
      private: body.private === true,
      ...(tokenUser !== undefined ? { tokenUser } : {}),
      ...(Number.isFinite(remaining) ? { rateLimitRemaining: remaining } : {}),
    };
  });

export const probeToValidation = (error: GitHubProbeError): ValidationError =>
  new ValidationError({ field: error.status === "unauthorized" ? "token" : "remoteUrl", message: error.message });
