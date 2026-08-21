import { describe, expect, test } from "bun:test";

import { bigQueryColumnMeta, bigQueryFieldType } from "./bigquery.ts";

describe("BigQuery schema metadata", () => {
  test("formats scalar, repeated, and nested fields", () => {
    expect(bigQueryFieldType({ name: "id", type: "INTEGER", mode: "REQUIRED" })).toBe("INTEGER");
    expect(bigQueryFieldType({ name: "tags", type: "STRING", mode: "REPEATED" })).toBe("ARRAY<STRING>");
    expect(bigQueryFieldType({
      name: "address",
      type: "RECORD",
      fields: [
        { name: "city", type: "STRING" },
        { name: "zip", type: "INTEGER" },
      ],
    })).toBe("STRUCT<city STRING, zip INTEGER>");
  });

  test("maps nullability and defaults without inventing primary keys", () => {
    expect(bigQueryColumnMeta({
      name: "created_at",
      type: "TIMESTAMP",
      mode: "REQUIRED",
      defaultValueExpression: "CURRENT_TIMESTAMP()",
    })).toEqual({
      name: "created_at",
      type: "TIMESTAMP",
      nullable: false,
      isPrimaryKey: false,
      default: "CURRENT_TIMESTAMP()",
    });
  });
});
