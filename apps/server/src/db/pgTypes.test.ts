import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";

import { builtinPgTypeName, makePgTypeResolver, type PgTypeRow } from "./pgTypes.ts";

describe("builtinPgTypeName", () => {
  test("names the OIDs pg hands back for the common scalars", () => {
    expect(builtinPgTypeName(16)).toBe("bool");
    expect(builtinPgTypeName(20)).toBe("int8");
    expect(builtinPgTypeName(23)).toBe("int4");
    expect(builtinPgTypeName(25)).toBe("text");
    expect(builtinPgTypeName(701)).toBe("float8");
    expect(builtinPgTypeName(1043)).toBe("varchar");
    expect(builtinPgTypeName(1184)).toBe("timestamptz");
    expect(builtinPgTypeName(1700)).toBe("numeric");
    expect(builtinPgTypeName(2950)).toBe("uuid");
    expect(builtinPgTypeName(3802)).toBe("jsonb");
  });

  test("arrays read as `elem[]`", () => {
    expect(builtinPgTypeName(1007)).toBe("int4[]");
    expect(builtinPgTypeName(1009)).toBe("text[]");
    expect(builtinPgTypeName(1016)).toBe("int8[]");
  });

  test("returns undefined for a non-builtin (enum / extension) OID", () => {
    expect(builtinPgTypeName(123_456)).toBeUndefined();
  });
});

describe("makePgTypeResolver", () => {
  const rows = (...pairs: Array<[number, string]>): ReadonlyArray<PgTypeRow> =>
    pairs.map(([oid, name]) => ({ oid, name }));

  test("answers builtin OIDs without touching the catalog", async () => {
    let catalogCalls = 0;
    const resolver = makePgTypeResolver({
      loadCatalog: Effect.sync(() => {
        catalogCalls += 1;
        return rows();
      }),
      formatTypes: () => Effect.succeed(rows()),
    });

    const names = await Effect.runPromise(resolver.resolve([20, 1700, 25]));
    expect([...names.values()]).toEqual(["int8", "numeric", "text"]);
    expect(catalogCalls).toBe(0);
  });

  test("sweeps pg_type once, then serves later lookups from the cache", async () => {
    let catalogCalls = 0;
    const resolver = makePgTypeResolver({
      loadCatalog: Effect.sync(() => {
        catalogCalls += 1;
        return rows([90_001, "plan_enum"], [90_002, "citext"]);
      }),
      formatTypes: () => Effect.succeed(rows()),
    });

    expect((await Effect.runPromise(resolver.resolve([90_001]))).get(90_001)).toBe("plan_enum");
    expect((await Effect.runPromise(resolver.resolve([90_002]))).get(90_002)).toBe("citext");
    expect(catalogCalls).toBe(1);
  });

  test("falls back to format_type for an OID created after the sweep", async () => {
    const seen: Array<ReadonlyArray<number>> = [];
    const resolver = makePgTypeResolver({
      loadCatalog: Effect.succeed(rows()),
      formatTypes: (oids) => {
        seen.push(oids);
        return Effect.succeed(rows([90_003, "geometry"]));
      },
    });

    expect((await Effect.runPromise(resolver.resolve([90_003]))).get(90_003)).toBe("geometry");
    expect(seen).toEqual([[90_003]]);
  });

  test("degrades to `unknown` when both lookups fail", async () => {
    const resolver = makePgTypeResolver({
      loadCatalog: Effect.fail(new Error("no catalog")),
      formatTypes: () => Effect.fail(new Error("no format_type")),
    });

    const names = await Effect.runPromise(resolver.resolve([90_004, 23]));
    expect(names.get(90_004)).toBe("unknown");
    // A builtin still resolves even when every round-trip fails.
    expect(names.get(23)).toBe("int4");
  });
});
