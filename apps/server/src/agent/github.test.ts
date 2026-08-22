import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";

import { gitAuthArgs, parseGitHubUrl, probeGitHub } from "./github.ts";

describe("parseGitHubUrl", () => {
  test.each([
    ["owner/repo", "owner", "repo"],
    ["github.com/owner/repo", "owner", "repo"],
    ["https://github.com/owner/repo", "owner", "repo"],
    ["https://github.com/owner/repo.git/", "owner", "repo"],
    ["https://www.github.com/owner/repo", "owner", "repo"],
    ["git@github.com:owner/repo.git", "owner", "repo"],
    ["ssh://git@github.com/owner/repo", "owner", "repo"],
    ["  https://github.com/Owner-1/my.repo_2  ", "Owner-1", "my.repo_2"],
  ])("%s → %s/%s", (input, owner, repo) => {
    expect(parseGitHubUrl(input)).toEqual({ owner, repo, remoteUrl: `https://github.com/${owner}/${repo}` });
  });

  test.each(["", "owner", "owner/repo/extra", "https://gitlab.com/owner/repo", "https://github.com/owner/re po", "git@github.com:owner"])(
    "rejects %j",
    (input) => {
      expect(parseGitHubUrl(input)).toBeUndefined();
    },
  );
});

describe("gitAuthArgs", () => {
  test("passes the token as a per-command header, never in the URL", () => {
    const args = gitAuthArgs("ghp_secret");
    expect(args[0]).toBe("-c");
    expect(args[1]).toStartWith("http.extraHeader=Authorization: Basic ");
    expect(args[1]).not.toContain("ghp_secret");
    expect(Buffer.from(args[1]!.split("Basic ")[1]!, "base64").toString()).toBe("x-access-token:ghp_secret");
  });

  test("is empty without a token", () => {
    expect(gitAuthArgs(undefined)).toEqual([]);
  });
});

const ref = { owner: "acme", repo: "analytics", remoteUrl: "https://github.com/acme/analytics" };

const fakeFetch = (routes: Record<string, () => Response>) => {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, auth: (init.headers as Record<string, string>)["Authorization"] });
    const route = routes[url];
    if (!route) throw new Error(`unexpected ${url}`);
    return route();
  };
  return { fetcher, calls };
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("probeGitHub", () => {
  test("returns default branch, visibility, and token user", async () => {
    const { fetcher, calls } = fakeFetch({
      "https://api.github.com/repos/acme/analytics": () =>
        json({ default_branch: "trunk", private: true }, 200, { "x-ratelimit-remaining": "4999" }),
      "https://api.github.com/user": () => json({ login: "sonya" }),
    });
    const result = await Effect.runPromise(probeGitHub(ref, "tok", fetcher));
    expect(result).toEqual({
      ...ref,
      defaultBranch: "trunk",
      private: true,
      tokenUser: "sonya",
      rateLimitRemaining: 4999,
    });
    expect(calls.every((call) => call.auth === "Bearer tok")).toBe(true);
  });

  test("skips the user lookup without a token", async () => {
    const { fetcher, calls } = fakeFetch({
      "https://api.github.com/repos/acme/analytics": () => json({ default_branch: "main", private: false }),
    });
    const result = await Effect.runPromise(probeGitHub(ref, undefined, fetcher));
    expect(result.tokenUser).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.auth).toBeUndefined();
  });

  test.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
    [404, "not-found"],
    [500, "error"],
  ] as const)("maps HTTP %d to %s", async (status, expected) => {
    const { fetcher } = fakeFetch({ "https://api.github.com/repos/acme/analytics": () => json({}, status) });
    const result = await Effect.runPromise(Effect.result(probeGitHub(ref, "tok", fetcher)));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.status).toBe(expected);
  });

  test("distinguishes rate limiting from a forbidden token", async () => {
    const { fetcher } = fakeFetch({
      "https://api.github.com/repos/acme/analytics": () => json({}, 403, { "x-ratelimit-remaining": "0" }),
    });
    const result = await Effect.runPromise(Effect.result(probeGitHub(ref, undefined, fetcher)));
    if (result._tag === "Failure") expect(result.failure.status).toBe("offline");
    else throw new Error("expected failure");
  });

  test("network errors are offline", async () => {
    const result = await Effect.runPromise(
      Effect.result(probeGitHub(ref, undefined, async () => { throw new Error("ENOTFOUND"); })),
    );
    if (result._tag === "Failure") expect(result.failure.status).toBe("offline");
    else throw new Error("expected failure");
  });
});
