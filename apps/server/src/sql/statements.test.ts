import { describe, expect, test } from "bun:test";

import type { ConnectionId } from "@dbchat/contracts";
import { deriveRunId, detectCommand, hashSql, isMultiStatement, splitStatements } from "./statements.ts";

describe("splitStatements", () => {
  test("single statement, with or without a trailing semicolon", () => {
    expect(splitStatements("select 1")).toEqual(["select 1"]);
    expect(splitStatements("select 1;")).toEqual(["select 1"]);
    expect(splitStatements("  select 1 ;  \n ")).toEqual(["select 1"]);
  });

  test("splits top-level statements", () => {
    expect(splitStatements("select 1; select 2")).toEqual(["select 1", "select 2"]);
    expect(splitStatements("delete from t;;\nselect 2;")).toEqual(["delete from t", "select 2"]);
  });

  test("ignores semicolons inside string literals", () => {
    expect(splitStatements("select ';'")).toEqual(["select ';'"]);
    expect(splitStatements("select 'a;b', 'c''d;e' from t")).toEqual(["select 'a;b', 'c''d;e' from t"]);
    expect(splitStatements("select 'a\\';b'")).toHaveLength(1);
  });

  test("ignores semicolons inside quoted identifiers", () => {
    expect(splitStatements('select "we;ird" from t')).toEqual(['select "we;ird" from t']);
    expect(splitStatements("select `we;ird` from t")).toEqual(["select `we;ird` from t"]);
  });

  test("ignores semicolons inside comments", () => {
    expect(splitStatements("select 1 -- ; not a statement\n")).toEqual(["select 1 -- ; not a statement"]);
    expect(splitStatements("select 1 /* ; nope */ from t")).toEqual(["select 1 /* ; nope */ from t"]);
    expect(splitStatements("select 1 # ; nope\n")).toEqual(["select 1 # ; nope"]);
  });

  test("ignores semicolons inside dollar-quoted bodies", () => {
    const fn = "create function f() returns void as $$ begin perform 1; end $$ language plpgsql";
    expect(splitStatements(fn)).toEqual([fn]);
    const tagged = "select $tag$ a; b $tag$";
    expect(splitStatements(tagged)).toEqual([tagged]);
  });
});

describe("isMultiStatement", () => {
  test("true only for genuine batches", () => {
    expect(isMultiStatement("select 1")).toBe(false);
    expect(isMultiStatement("select 1;")).toBe(false);
    expect(isMultiStatement("select ';'")).toBe(false);
    expect(isMultiStatement("select 1; drop table users")).toBe(true);
  });
});

describe("detectCommand", () => {
  test("returns the leading keyword, uppercased", () => {
    expect(detectCommand("select 1")).toBe("SELECT");
    expect(detectCommand("  \n insert into t values (1)")).toBe("INSERT");
    expect(detectCommand("with x as (select 1) select * from x")).toBe("WITH");
  });

  test("skips leading comments and parens", () => {
    expect(detectCommand("-- a comment\nselect 1")).toBe("SELECT");
    expect(detectCommand("/* hi */ update t set a = 1")).toBe("UPDATE");
    expect(detectCommand("(select 1)")).toBe("SELECT");
  });

  test("undefined when there is no keyword", () => {
    expect(detectCommand("   ")).toBeUndefined();
    expect(detectCommand("-- only a comment")).toBeUndefined();
  });
});

describe("runId derivation", () => {
  test("hash is stable and sensitive to the text", () => {
    expect(hashSql("select 1")).toBe(hashSql("select 1"));
    expect(hashSql("select 1")).not.toBe(hashSql("select 2"));
    expect(hashSql("select 1")).toMatch(/^[0-9a-f]{8}$/);
  });

  test("runId combines connection and sql", () => {
    const c = "c_1" as ConnectionId;
    expect(String(deriveRunId(c, "select 1"))).toBe(`c_1:${hashSql("select 1")}`);
    expect(deriveRunId(c, "select 1")).not.toBe(deriveRunId(c, "select 2"));
    expect(deriveRunId(c, "select 1")).not.toBe(deriveRunId("c_2" as ConnectionId, "select 1"));
  });
});
