import { describe, expect, test } from "bun:test";

import { toJsonSafe, toJsonSafeRows } from "./jsonSafe.ts";

describe("toJsonSafe", () => {
  test("passes JSON primitives through", () => {
    expect(toJsonSafe("a")).toBe("a");
    expect(toJsonSafe(1)).toBe(1);
    expect(toJsonSafe(true)).toBe(true);
    expect(toJsonSafe(null)).toBe(null);
    expect(toJsonSafe(undefined)).toBe(null);
  });

  test("Date becomes an ISO string", () => {
    expect(toJsonSafe(new Date("2024-01-02T03:04:05.000Z"))).toBe("2024-01-02T03:04:05.000Z");
  });

  test("BigInt becomes a string", () => {
    expect(toJsonSafe(9007199254740993n)).toBe("9007199254740993");
  });

  test("Buffer becomes a hex literal", () => {
    expect(toJsonSafe(Buffer.from([0xde, 0xad]))).toBe("\\xdead");
  });

  test("non-finite numbers become strings", () => {
    expect(toJsonSafe(Number.NaN)).toBe("NaN");
    expect(toJsonSafe(Number.POSITIVE_INFINITY)).toBe("Infinity");
  });

  test("nested jsonb keeps its shape but coerces leaves", () => {
    expect(toJsonSafe({ a: [1, new Date(0)], b: { c: 2n } })).toEqual({
      a: [1, "1970-01-01T00:00:00.000Z"],
      b: { c: "2" },
    });
  });

  test("class instances degrade to a string", () => {
    class Range {
      toString() {
        return "[1,5)";
      }
    }
    expect(toJsonSafe(new Range())).toBe("[1,5)");
  });

  test("rows round-trip through JSON", () => {
    const rows = toJsonSafeRows([[1, new Date(0), Buffer.from("hi"), 3n, null]]);
    expect(() => JSON.stringify(rows)).not.toThrow();
    expect(JSON.parse(JSON.stringify(rows))).toEqual(rows);
  });
});
