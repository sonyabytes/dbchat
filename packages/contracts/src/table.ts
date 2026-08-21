import * as Schema from "effect/Schema";
import { ConnectionId } from "./ids.ts";
import { ColumnMeta } from "./schema.ts";

export const SortDir = Schema.Literals(["asc", "desc"]);
export type SortDir = typeof SortDir.Type;

export const SortSpec = Schema.Struct({ column: Schema.String, dir: SortDir });
export type SortSpec = typeof SortSpec.Type;

export const FilterOp = Schema.Literals([
  "eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "in", "is_null", "is_not_null",
]);
export type FilterOp = typeof FilterOp.Type;

export const FilterSpec = Schema.Struct({
  column: Schema.String,
  op: FilterOp,
  value: Schema.optional(Schema.Unknown),
});
export type FilterSpec = typeof FilterSpec.Type;

export const RowsRequest = Schema.Struct({
  connectionId: ConnectionId,
  schema: Schema.String,
  table: Schema.String,
  offset: Schema.Number,
  limit: Schema.Number,
  sort: Schema.optional(Schema.Array(SortSpec)),
  filters: Schema.optional(Schema.Array(FilterSpec)),
});
export type RowsRequest = typeof RowsRequest.Type;

export const Row = Schema.Array(Schema.Unknown);
export type Row = typeof Row.Type;

export const RowsPage = Schema.Struct({
  columns: Schema.Array(ColumnMeta),
  rows: Schema.Array(Row),
  total: Schema.optional(Schema.Number),
  truncated: Schema.Boolean,
});
export type RowsPage = typeof RowsPage.Type;
