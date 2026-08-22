/** Read-only Git/dbt inspection. All reads are pinned to a resolved commit. */
import type { GitModel, GitRepository, LocalGitRepositoryInput } from "@dbchat/contracts";
import { ValidationError } from "@dbchat/contracts";
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { realpathSync, statSync } from "node:fs";
import * as Effect from "effect/Effect";

const MAX_GIT_OUTPUT = 8 * 1024 * 1024;
const MAX_CONTEXT_CHARS = 60_000;
const MAX_MODELS = 1_000;
const ALLOWED = /\.(sql|ya?ml|md|json)$/i;
const SKIPPED = /(^|\/)(node_modules|target|dist|build|\.venv|venv|__pycache__)(\/|$)/;

const git = (path: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-C", path, ...args], {
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT,
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const validation = (field: string, error: unknown) =>
  new ValidationError({ field, message: error instanceof Error ? error.message : String(error) });

export const inspectGitInput = (input: Omit<LocalGitRepositoryInput, "origin"> & { origin?: "local" }) =>
  Effect.try({
    try: () => {
      const requested = input.path.trim();
      if (!requested) throw new Error("Repository path is required.");
      const realPath = realpathSync(requested);
      if (!statSync(realPath).isDirectory()) throw new Error("Repository path must be a directory.");
      const root = git(realPath, ["rev-parse", "--show-toplevel"]);
      const branch = input.branch?.trim() || git(root, ["branch", "--show-current"]) || "HEAD";
      const headCommit = git(root, ["rev-parse", "--verify", `${branch}^{commit}`]);
      return {
        name: input.name.trim() || basename(root),
        path: root,
        branch,
        headCommit,
      };
    },
    catch: (error) => validation("path", error),
  });

const kindFor = (path: string): GitModel["kind"] => {
  if (/\.(ya?ml)$/i.test(path)) return "yaml";
  if (/\.md$/i.test(path)) return "markdown";
  if (/(^|\/)(manifest|catalog)\.json$/i.test(path)) return "dbt-artifact";
  return "sql";
};

export const gitFiles = (repository: Pick<GitRepository, "path" | "headCommit">): ReadonlyArray<string> =>
  git(repository.path, ["ls-tree", "-r", "--name-only", repository.headCommit])
    .split("\n")
    .map((path) => path.trim())
    .filter((path) => path && ALLOWED.test(path) && !SKIPPED.test(path))
    .slice(0, MAX_MODELS);

export const readGitFile = (
  repository: Pick<GitRepository, "path" | "headCommit">,
  path: string,
): string => {
  if (!gitFiles(repository).includes(path)) throw new Error(`File is not available as model context: ${path}`);
  const content = git(repository.path, ["show", `${repository.headCommit}:${path}`]);
  return content.length > MAX_CONTEXT_CHARS
    ? `${content.slice(0, MAX_CONTEXT_CHARS)}\n… [truncated ${content.length - MAX_CONTEXT_CHARS} characters]`
    : content;
};

const upstreamFromSql = (sql: string): ReadonlyArray<string> => {
  const found = new Set<string>();
  for (const match of sql.matchAll(/\bref\(\s*['"]([^'"]+)['"]\s*\)/g)) found.add(match[1]!);
  for (const match of sql.matchAll(/\bsource\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g)) {
    found.add(`${match[1]}.${match[2]}`);
  }
  return [...found];
};

export const inspectGitRepository = (repository: GitRepository): GitModel[] =>
  gitFiles(repository).map((path) => {
    const name = basename(path).replace(/\.(sql|ya?ml|md|json)$/i, "");
    let upstream: ReadonlyArray<string> = [];
    if (/\.sql$/i.test(path)) {
      try {
        upstream = upstreamFromSql(readGitFile(repository, path));
      } catch {
        upstream = [];
      }
    }
    return { path, name, kind: kindFor(path), upstream };
  });

export const searchGitRepository = (repository: GitRepository, query: string): ReadonlyArray<{
  path: string;
  name: string;
  matches: ReadonlyArray<string>;
}> => {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const results: Array<{ path: string; name: string; matches: ReadonlyArray<string> }> = [];
  for (const model of inspectGitRepository(repository)) {
    const lines: string[] = [];
    if (model.path.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle)) lines.push(model.path);
    if (lines.length === 0 && model.kind !== "dbt-artifact") {
      try {
        for (const line of readGitFile(repository, model.path).split("\n")) {
          if (line.toLowerCase().includes(needle)) lines.push(line.trim().slice(0, 240));
          if (lines.length >= 3) break;
        }
      } catch {
        // One unreadable file should not hide results from the rest of the repository.
      }
    }
    if (lines.length > 0) results.push({ path: model.path, name: model.name, matches: lines });
    if (results.length >= 20) break;
  }
  return results;
};
