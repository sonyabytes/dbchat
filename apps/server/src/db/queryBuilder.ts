/**
 * Dialect-aware SELECT builder shared by the three drivers' `rows`
 * implementation. Identifiers are quoted (never interpolated raw) and every
 * filter value becomes a bound parameter.
 */
import type { FilterSpec, RowsRequest, SortSpec } from "@dbchat/contracts";

export type Dialect = "postgres" | "mysql" | "sqlite";

export interface BuiltQuery {
  readonly text: string;
  readonly params: ReadonlyArray<unknown>;
}

/** Quote an identifier for `dialect`, doubling the quote char inside it. */
export const quoteIdent = (dialect: Dialect, name: string): string => {
  if (name.length === 0) throw new Error("empty identifier");
  if (name.includes("\0")) throw new Error("identifier contains a NUL byte");
  if (dialect === "mysql") return "`" + name.replaceAll("`", "``") + "`";
  return '"' + name.replaceAll('"', '""') + '"';
};

/** `schema.table`, or just `table` when the schema is empty. */
export const quoteRelation = (dialect: Dialect, schema: string, table: string): string =>
  schema.length > 0
    ? `${quoteIdent(dialect, schema)}.${quoteIdent(dialect, table)}`
    : quoteIdent(dialect, table);

/** Positional placeholder factory: `$1, $2, …` for pg, `?` elsewhere. */
export const placeholders = (dialect: Dialect) => {
  let n = 0;
  return () => (dialect === "postgres" ? `$${++n}` : "?");
};

const COMPARISON: Record<string, string> = {
  eq: "=",
  neq: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

const renderFilter = (
  dialect: Dialect,
  filter: FilterSpec,
  next: () => string,
  params: Array<unknown>,
): string => {
  const col = quoteIdent(dialect, filter.column);
  switch (filter.op) {
    case "is_null":
      return `${col} IS NULL`;
    case "is_not_null":
      return `${col} IS NOT NULL`;
    case "in": {
      const values = Array.isArray(filter.value)
        ? (filter.value as ReadonlyArray<unknown>)
        : filter.value === undefined
          ? []
          : [filter.value];
      if (values.length === 0) return "1 = 0";
      const slots = values.map((v) => {
        params.push(v);
        return next();
      });
      return `${col} IN (${slots.join(", ")})`;
    }
    case "like":
    case "ilike": {
      params.push(filter.value ?? "");
      const slot = next();
      if (dialect === "postgres") {
        return filter.op === "ilike" ? `${col}::text ILIKE ${slot}` : `${col}::text LIKE ${slot}`;
      }
      // MySQL's default collations and SQLite's LIKE are already
      // case-insensitive for ASCII, so LIKE covers both ops there.
      return `${col} LIKE ${slot}`;
    }
    default: {
      const op = COMPARISON[filter.op] ?? "=";
      if (filter.value === null || filter.value === undefined) {
        return filter.op === "neq" ? `${col} IS NOT NULL` : `${col} IS NULL`;
      }
      params.push(filter.value);
      return `${col} ${op} ${next()}`;
    }
  }
};

export const buildWhere = (
  dialect: Dialect,
  filters: ReadonlyArray<FilterSpec> | undefined,
  next: () => string,
  params: Array<unknown>,
): string => {
  if (!filters || filters.length === 0) return "";
  return ` WHERE ${filters.map((f) => renderFilter(dialect, f, next, params)).join(" AND ")}`;
};

export const buildOrderBy = (dialect: Dialect, sort: ReadonlyArray<SortSpec> | undefined): string => {
  if (!sort || sort.length === 0) return "";
  const parts = sort.map((s) => `${quoteIdent(dialect, s.column)} ${s.dir === "desc" ? "DESC" : "ASC"}`);
  return ` ORDER BY ${parts.join(", ")}`;
};

const clampLimit = (limit: number) => Math.max(0, Math.min(Math.trunc(limit) || 0, 100_000));
const clampOffset = (offset: number) => Math.max(0, Math.trunc(offset) || 0);

/** `SELECT * FROM schema.table [WHERE …] [ORDER BY …] LIMIT … OFFSET …`. */
export const buildRowsQuery = (dialect: Dialect, req: RowsRequest): BuiltQuery => {
  const params: Array<unknown> = [];
  const next = placeholders(dialect);
  const text =
    `SELECT * FROM ${quoteRelation(dialect, req.schema, req.table)}` +
    buildWhere(dialect, req.filters, next, params) +
    buildOrderBy(dialect, req.sort) +
    ` LIMIT ${clampLimit(req.limit)} OFFSET ${clampOffset(req.offset)}`;
  return { text, params };
};

/** `SELECT count(*) …` with the same WHERE clause (no sort/limit). */
export const buildCountQuery = (dialect: Dialect, req: RowsRequest): BuiltQuery => {
  const params: Array<unknown> = [];
  const next = placeholders(dialect);
  const text =
    `SELECT count(*) AS total FROM ${quoteRelation(dialect, req.schema, req.table)}` +
    buildWhere(dialect, req.filters, next, params);
  return { text, params };
};

/** True when the request narrows the result set, so a row estimate would lie. */
export const hasFilters = (req: RowsRequest): boolean => (req.filters?.length ?? 0) > 0;
