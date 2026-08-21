import * as Schema from "effect/Schema";
import { ConnectionId, IsoDateTime, QueryId, RunId } from "./ids.ts";
import { ColumnMeta } from "./schema.ts";
import { Row } from "./table.ts";

export const SqlRunRequest = Schema.Struct({
  connectionId: ConnectionId,
  sql: Schema.String,
  limit: Schema.optional(Schema.Number),
  readOnly: Schema.optional(Schema.Boolean),
  runId: Schema.optional(RunId),
});
export type SqlRunRequest = typeof SqlRunRequest.Type;

export const SqlResult = Schema.Struct({
  columns: Schema.Array(ColumnMeta),
  rows: Schema.Array(Row),
  rowCount: Schema.Number,
  durationMs: Schema.Number,
  command: Schema.optional(Schema.String),
  truncated: Schema.optional(Schema.Boolean),
});
export type SqlResult = typeof SqlResult.Type;

export const SqlExplainResult = Schema.Struct({ plan: Schema.String });
export type SqlExplainResult = typeof SqlExplainResult.Type;

export const QueryHistoryEntry = Schema.Struct({
  id: Schema.String,
  connectionId: ConnectionId,
  sql: Schema.String,
  durationMs: Schema.Number,
  rowCount: Schema.Number,
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
  ranAt: IsoDateTime,
});
export type QueryHistoryEntry = typeof QueryHistoryEntry.Type;

export const SavedQuery = Schema.Struct({
  id: QueryId,
  connectionId: ConnectionId,
  name: Schema.String,
  sql: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SavedQuery = typeof SavedQuery.Type;

export const SavedQuerySaveInput = Schema.Struct({
  id: Schema.optional(QueryId),
  connectionId: ConnectionId,
  name: Schema.String,
  sql: Schema.String,
});
export type SavedQuerySaveInput = typeof SavedQuerySaveInput.Type;

export const SqlSuggestRequest = Schema.Struct({
  connectionId: ConnectionId,
  sql: Schema.String,
  cursor: Schema.Number,
});
export type SqlSuggestRequest = typeof SqlSuggestRequest.Type;

export const SqlSuggestion = Schema.Struct({ text: Schema.String, reason: Schema.String });
export type SqlSuggestion = typeof SqlSuggestion.Type;

export const SqlSuggestResult = Schema.Struct({ suggestion: Schema.optional(SqlSuggestion) });
export type SqlSuggestResult = typeof SqlSuggestResult.Type;
