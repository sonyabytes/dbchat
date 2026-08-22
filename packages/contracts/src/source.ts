import * as Schema from "effect/Schema";

import { ConnectionId, IsoDateTime, RepositoryId } from "./ids.ts";

export const DatabaseSourceRef = Schema.Struct({
  kind: Schema.Literal("database"),
  id: ConnectionId,
});
export type DatabaseSourceRef = typeof DatabaseSourceRef.Type;

export const GitSourceRef = Schema.Struct({
  kind: Schema.Literal("git"),
  id: RepositoryId,
});
export type GitSourceRef = typeof GitSourceRef.Type;

export const SourceRef = Schema.Union([DatabaseSourceRef, GitSourceRef]);
export type SourceRef = typeof SourceRef.Type;

/** Where a repository's commits come from: a worktree already on disk, or a remote dbchat clones itself. */
export const GitOrigin = Schema.Literals(["local", "github"]);
export type GitOrigin = typeof GitOrigin.Type;

/** Last known connectivity of a remote-backed repository. Local repositories are always `connected`. */
export const GitSyncStatus = Schema.Literals(["connected", "unauthorized", "not-found", "offline", "error"]);
export type GitSyncStatus = typeof GitSyncStatus.Type;

/** A read-only Git ref that supplies model and documentation context. All reads are pinned to `headCommit`. */
export const GitRepository = Schema.Struct({
  id: RepositoryId,
  name: Schema.String,
  origin: GitOrigin,
  /** Local worktree path, or the dbchat-managed clone for remote origins. */
  path: Schema.String,
  /** Canonical HTTPS URL for remote origins, e.g. https://github.com/owner/repo. */
  remoteUrl: Schema.optional(Schema.String),
  branch: Schema.String,
  headCommit: Schema.String,
  status: GitSyncStatus,
  /** Human-readable detail for non-`connected` statuses. */
  statusMessage: Schema.optional(Schema.String),
  /** Whether a token is stored for this repository (the token itself is never returned). */
  hasToken: Schema.Boolean,
  lastFetchedAt: Schema.optional(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type GitRepository = typeof GitRepository.Type;

export const LocalGitRepositoryInput = Schema.Struct({
  origin: Schema.Literal("local"),
  name: Schema.String,
  path: Schema.String,
  /** Branch, tag, or commit. Omit to use the worktree's current branch. */
  branch: Schema.optional(Schema.String),
});
export type LocalGitRepositoryInput = typeof LocalGitRepositoryInput.Type;

export const GitHubRepositoryInput = Schema.Struct({
  origin: Schema.Literal("github"),
  name: Schema.String,
  /** Any GitHub form: https URL, ssh URL, or `owner/repo`. */
  remoteUrl: Schema.String,
  /** Personal access token. Required for private repositories; omit to keep the stored token on refresh. */
  token: Schema.optional(Schema.String),
  /** Branch or tag on the remote. Omit to use the remote's default branch. */
  branch: Schema.optional(Schema.String),
});
export type GitHubRepositoryInput = typeof GitHubRepositoryInput.Type;

export const GitRepositoryInput = Schema.Union([LocalGitRepositoryInput, GitHubRepositoryInput]);
export type GitRepositoryInput = typeof GitRepositoryInput.Type;

/** Probe a GitHub repository before cloning: validates the URL, token, and access in one round-trip. */
export const GitHubConnectionTestInput = Schema.Struct({
  remoteUrl: Schema.String,
  token: Schema.optional(Schema.String),
});
export type GitHubConnectionTestInput = typeof GitHubConnectionTestInput.Type;

export const GitHubConnectionTest = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
  remoteUrl: Schema.String,
  defaultBranch: Schema.String,
  private: Schema.Boolean,
  /** Login of the token's user when a token was supplied and accepted. */
  tokenUser: Schema.optional(Schema.String),
  /** Rate-limit remaining on the credential used for the probe. */
  rateLimitRemaining: Schema.optional(Schema.Number),
});
export type GitHubConnectionTest = typeof GitHubConnectionTest.Type;

export const GitModel = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["sql", "yaml", "markdown", "dbt-artifact"]),
  upstream: Schema.Array(Schema.String),
});
export type GitModel = typeof GitModel.Type;

export const GitRepositoryInspection = Schema.Struct({
  repository: GitRepository,
  models: Schema.Array(GitModel),
});
export type GitRepositoryInspection = typeof GitRepositoryInspection.Type;
