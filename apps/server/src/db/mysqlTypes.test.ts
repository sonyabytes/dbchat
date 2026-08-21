import { describe, expect, test } from "bun:test";

import { flagsMask, MYSQL_FLAG, MYSQL_TYPE, mysqlColumnMeta, mysqlTypeName } from "./mysqlTypes.ts";

const field = (over: Partial<Parameters<typeof mysqlTypeName>[0]> = {}) => ({
  name: "c",
  columnType: MYSQL_TYPE.LONG,
  flags: 0,
  characterSet: 63,
  ...over,
});

describe("mysqlTypeName", () => {
  test("maps the integer family", () => {
    expect(mysqlTypeName(field({ columnType: MYSQL_TYPE.TINY }))).toBe("tinyint");
    expect(mysqlTypeName(field({ columnType: MYSQL_TYPE.SHORT }))).toBe("smallint");
    expect(mysqlTypeName(field({ columnType: MYSQL_TYPE.INT24 }))).toBe("mediumint");
    expect(mysqlTypeName(field({ columnType: MYSQL_TYPE.LONG }))).toBe("int");
    expect(mysqlTypeName(field({ columnType: MYSQL_TYPE.LONGLONG }))).toBe("bigint");
  });

  test("carries the UNSIGNED flag into the name", () => {
    expect(mysqlTypeName(field({ columnType: MYSQL_TYPE.LONG, flags: MYSQL_FLAG.UNSIGNED }))).toBe("int unsigned");
  });

  test("separates text from blob by charset", () => {
    expect(mysqlTypeName(field({ columnType: MYSQL_TYPE.BLOB, characterSet: 63 }))).toBe("blob");
    expect(mysqlTypeName(field({ columnType: MYSQL_TYPE.BLOB, characterSet: 255 }))).toBe("text");
    expect(mysqlTypeName(field({ columnType: MYSQL_TYPE.LONG_BLOB, characterSet: 255 }))).toBe("longtext");
  });

  test("separates varchar from varbinary and char from binary", () => {
    expect(mysqlTypeName(field({ columnType: MYSQL_TYPE.VAR_STRING, characterSet: 255 }))).toBe("varchar");
    expect(mysqlTypeName(field({ columnType: MYSQL_TYPE.VAR_STRING, characterSet: 63 }))).toBe("varbinary");
    expect(mysqlTypeName(field({ columnType: MYSQL_TYPE.STRING, characterSet: 255 }))).toBe("char");
    expect(mysqlTypeName(field({ columnType: MYSQL_TYPE.STRING, characterSet: 63 }))).toBe("binary");
  });

  test("recognises enum / set, which arrive as strings with a flag", () => {
    expect(
      mysqlTypeName(field({ columnType: MYSQL_TYPE.STRING, characterSet: 255, flags: MYSQL_FLAG.ENUM })),
    ).toBe("enum");
    expect(
      mysqlTypeName(field({ columnType: MYSQL_TYPE.VAR_STRING, characterSet: 255, flags: MYSQL_FLAG.SET })),
    ).toBe("set");
  });

  test("maps the temporal, decimal and json types", () => {
    expect(mysqlTypeName(field({ columnType: MYSQL_TYPE.DATE }))).toBe("date");
    expect(mysqlTypeName(field({ columnType: MYSQL_TYPE.DATETIME }))).toBe("datetime");
    expect(mysqlTypeName(field({ columnType: MYSQL_TYPE.TIMESTAMP }))).toBe("timestamp");
    expect(mysqlTypeName(field({ columnType: MYSQL_TYPE.NEWDECIMAL }))).toBe("decimal");
    expect(mysqlTypeName(field({ columnType: MYSQL_TYPE.JSON }))).toBe("json");
  });

  test("falls back to the legacy `type` field and to `unknown`", () => {
    expect(mysqlTypeName({ name: "c", type: MYSQL_TYPE.LONGLONG })).toBe("bigint");
    expect(mysqlTypeName({ name: "c" })).toBe("unknown");
    expect(mysqlTypeName(field({ columnType: 0xee }))).toBe("unknown");
  });

  test("prefers MariaDB extended metadata when present", () => {
    expect(mysqlTypeName(field({ columnType: MYSQL_TYPE.STRING, extendedTypeName: "uuid" }))).toBe("uuid");
  });
});

describe("flagsMask", () => {
  test("accepts a numeric mask or mysql2's decoded string list", () => {
    expect(flagsMask(MYSQL_FLAG.NOT_NULL | MYSQL_FLAG.PRI_KEY)).toBe(3);
    expect(flagsMask(["NOT_NULL", "PRI_KEY"])).toBe(3);
    expect(flagsMask(undefined)).toBe(0);
  });
});

describe("mysqlColumnMeta", () => {
  test("derives nullable and isPrimaryKey from the flags", () => {
    expect(
      mysqlColumnMeta(
        field({ name: "id", columnType: MYSQL_TYPE.LONG, flags: MYSQL_FLAG.NOT_NULL | MYSQL_FLAG.PRI_KEY }),
      ),
    ).toEqual({ name: "id", type: "int", nullable: false, isPrimaryKey: true });
  });

  test("an expression column is nullable and never a key", () => {
    expect(mysqlColumnMeta(field({ name: "n", columnType: MYSQL_TYPE.LONGLONG }))).toEqual({
      name: "n",
      type: "bigint",
      nullable: true,
      isPrimaryKey: false,
    });
  });
});
