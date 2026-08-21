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

/** A read-only Git worktree/ref that supplies model and documentation context. */
export const GitRepository = Schema.Struct({
  id: RepositoryId,
  name: Schema.String,
  path: Schema.String,
  branch: Schema.String,
  headCommit: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type GitRepository = typeof GitRepository.Type;

export const GitRepositoryInput = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  /** Branch, tag, or commit. Omit to use the worktree's current branch. */
  branch: Schema.optional(Schema.String),
});
export type GitRepositoryInput = typeof GitRepositoryInput.Type;

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
