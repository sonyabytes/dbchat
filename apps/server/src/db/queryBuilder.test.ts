import type { RowsRequest } from "@dbchat/contracts";
import { describe, expect, test } from "bun:test";

import { buildCountQuery, buildRowsQuery, quoteIdent, quoteRelation } from "./queryBuilder.ts";

const req = (over: Partial<RowsRequest> = {}): RowsRequest => ({
  connectionId: "c1" as RowsRequest["connectionId"],
  schema: "public",
  table: "users",
  offset: 0,
  limit: 50,
  ...over,
});

describe("quoteIdent", () => {
  test("postgres and sqlite use double quotes", () => {
    expect(quoteIdent("postgres", "users")).toBe('"users"');
    expect(quoteIdent("sqlite", "users")).toBe('"users"');
  });

  test("mysql uses backticks", () => {
    expect(quoteIdent("mysql", "users")).toBe("`users`");
  });

  test("embedded quote characters are doubled", () => {
    expect(quoteIdent("postgres", 'we"ird')).toBe('"we""ird"');
    expect(quoteIdent("mysql", "we`ird")).toBe("`we``ird`");
  });

  test("an injection attempt stays inside the quotes", () => {
    expect(quoteIdent("postgres", 'users"; drop table users; --')).toBe('"users""; drop table users; --"');
  });

  test("empty identifiers are rejected", () => {
    expect(() => quoteIdent("postgres", "")).toThrow();
  });

  test("relation includes the schema only when present", () => {
    expect(quoteRelation("postgres", "public", "users")).toBe('"public"."users"');
    expect(quoteRelation("sqlite", "", "users")).toBe('"users"');
  });
});

describe("buildRowsQuery", () => {
  test("plain page", () => {
    const q = buildRowsQuery("postgres", req({ offset: 100, limit: 25 }));
    expect(q.text).toBe('SELECT * FROM "public"."users" LIMIT 25 OFFSET 100');
    expect(q.params).toEqual([]);
  });

  test("sort renders ORDER BY in order", () => {
    const q = buildRowsQuery("postgres", req({ sort: [{ column: "b", dir: "desc" }, { column: "a", dir: "asc" }] }));
    expect(q.text).toContain('ORDER BY "b" DESC, "a" ASC');
  });

  test("filters are parametrised with $n on postgres", () => {
    const q = buildRowsQuery(
      "postgres",
      req({ filters: [{ column: "plan", op: "eq", value: "pro" }, { column: "age", op: "gte", value: 21 }] }),
    );
    expect(q.text).toContain('WHERE "plan" = $1 AND "age" >= $2');
    expect(q.params).toEqual(["pro", 21]);
  });

  test("filters use ? on mysql and sqlite", () => {
    const q = buildRowsQuery("mysql", req({ schema: "app", filters: [{ column: "plan", op: "eq", value: "pro" }] }));
    expect(q.text).toBe("SELECT * FROM `app`.`users` WHERE `plan` = ? LIMIT 50 OFFSET 0");
    expect(q.params).toEqual(["pro"]);
  });

  test("null checks take no parameter", () => {
    const q = buildRowsQuery(
      "postgres",
      req({ filters: [{ column: "deleted_at", op: "is_null" }, { column: "email", op: "is_not_null" }] }),
    );
    expect(q.text).toContain('WHERE "deleted_at" IS NULL AND "email" IS NOT NULL');
    expect(q.params).toEqual([]);
  });

  test("in expands to one placeholder per value", () => {
    const q = buildRowsQuery("postgres", req({ filters: [{ column: "id", op: "in", value: [1, 2, 3] }] }));
    expect(q.text).toContain('"id" IN ($1, $2, $3)');
    expect(q.params).toEqual([1, 2, 3]);
  });

  test("an empty in list becomes a constant false", () => {
    const q = buildRowsQuery("postgres", req({ filters: [{ column: "id", op: "in", value: [] }] }));
    expect(q.text).toContain("1 = 0");
    expect(q.params).toEqual([]);
  });

  test("ilike uses ILIKE on postgres and LIKE elsewhere", () => {
    expect(buildRowsQuery("postgres", req({ filters: [{ column: "email", op: "ilike", value: "%a%" }] })).text)
      .toContain('"email"::text ILIKE $1');
    expect(buildRowsQuery("mysql", req({ filters: [{ column: "email", op: "ilike", value: "%a%" }] })).text)
      .toContain("`email` LIKE ?");
  });

  test("eq with a null value degrades to IS NULL", () => {
    const q = buildRowsQuery("postgres", req({ filters: [{ column: "x", op: "eq", value: null }] }));
    expect(q.text).toContain('"x" IS NULL');
    expect(q.params).toEqual([]);
  });

  test("neq with a null value degrades to IS NOT NULL", () => {
    const q = buildRowsQuery("postgres", req({ filters: [{ column: "x", op: "neq", value: null }] }));
    expect(q.text).toContain('"x" IS NOT NULL');
  });

  test("limit and offset are clamped, never interpolated from strings", () => {
    const q = buildRowsQuery("postgres", req({ limit: 10 ** 9, offset: -5 }));
    expect(q.text).toContain("LIMIT 100000 OFFSET 0");
  });

  test("a hostile column name cannot escape the quotes", () => {
    const q = buildRowsQuery("postgres", req({ sort: [{ column: 'id" ; drop table users --', dir: "asc" }] }));
    expect(q.text).toContain('ORDER BY "id"" ; drop table users --" ASC');
  });
});

describe("buildCountQuery", () => {
  test("counts with the same WHERE and no sort or limit", () => {
    const q = buildCountQuery("postgres", req({ sort: [{ column: "a", dir: "asc" }], filters: [{ column: "plan", op: "eq", value: "pro" }] }));
    expect(q.text).toBe('SELECT count(*) AS total FROM "public"."users" WHERE "plan" = $1');
    expect(q.params).toEqual(["pro"]);
  });
});
