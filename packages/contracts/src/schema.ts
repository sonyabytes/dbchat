import * as Schema from "effect/Schema";

export const TableKind = Schema.Literals(["table", "view"]);
export type TableKind = typeof TableKind.Type;

export const TableMeta = Schema.Struct({
  schema: Schema.String,
  name: Schema.String,
  kind: TableKind,
  rowEstimate: Schema.Number,
});
export type TableMeta = typeof TableMeta.Type;

export const SchemaMeta = Schema.Struct({
  name: Schema.String,
  tables: Schema.Array(TableMeta),
});
export type SchemaMeta = typeof SchemaMeta.Type;

export const ForeignKeyRef = Schema.Struct({
  table: Schema.String,
  column: Schema.String,
});
export type ForeignKeyRef = typeof ForeignKeyRef.Type;

export const ColumnMeta = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  nullable: Schema.Boolean,
  isPrimaryKey: Schema.Boolean,
  foreignKey: Schema.optional(ForeignKeyRef),
  default: Schema.optional(Schema.String),
});
export type ColumnMeta = typeof ColumnMeta.Type;

export const IndexMeta = Schema.Struct({
  name: Schema.String,
  columns: Schema.Array(Schema.String),
  unique: Schema.Boolean,
  definition: Schema.String,
});
export type IndexMeta = typeof IndexMeta.Type;

export const TableDetail = Schema.Struct({
  table: TableMeta,
  columns: Schema.Array(ColumnMeta),
  indexes: Schema.Array(IndexMeta),
});
export type TableDetail = typeof TableDetail.Type;
