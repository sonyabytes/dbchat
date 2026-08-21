import { describe, expect, test } from "bun:test";

import { relativeTime } from "./format.ts";

const now = Date.parse("2026-08-21T12:00:00.000Z");
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

describe("relativeTime", () => {
  test("undefined → never", () => {
    expect(relativeTime(undefined, now)).toBe("never");
  });

  test("buckets by age", () => {
    expect(relativeTime(ago(0), now)).toBe("now");
    expect(relativeTime(ago(59), now)).toBe("now");
    expect(relativeTime(ago(60), now)).toBe("1m ago");
    expect(relativeTime(ago(59 * 60), now)).toBe("59m ago");
    expect(relativeTime(ago(3600), now)).toBe("1h ago");
    expect(relativeTime(ago(23 * 3600), now)).toBe("23h ago");
    expect(relativeTime(ago(86400), now)).toBe("yesterday");
    expect(relativeTime(ago(2 * 86400), now)).toBe("2d ago");
    expect(relativeTime(ago(13 * 86400), now)).toBe("13d ago");
    expect(relativeTime(ago(14 * 86400), now)).toBe("2w ago");
    expect(relativeTime(ago(60 * 86400), now)).toBe("8w ago");
  });

  test("future timestamps clamp to now (clock skew)", () => {
    expect(relativeTime(ago(-500), now)).toBe("now");
  });
});
