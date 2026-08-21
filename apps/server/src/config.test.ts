import { describe, expect, test } from "bun:test";
import { isOriginAllowed, loadConfigFromEnv } from "./config.ts";

const allowed = ["http://localhost:5173", "http://127.0.0.1:5173"];

describe("isOriginAllowed", () => {
  test("no Origin header (non-browser client) passes", () => {
    expect(isOriginAllowed(undefined, allowed)).toBe(true);
  });

  test("listed origins pass, case/trailing-slash insensitive", () => {
    expect(isOriginAllowed("http://localhost:5173", allowed)).toBe(true);
    expect(isOriginAllowed("HTTP://LOCALHOST:5173/", allowed)).toBe(true);
  });

  test("foreign, empty and null origins are rejected", () => {
    expect(isOriginAllowed("https://evil.example", allowed)).toBe(false);
    expect(isOriginAllowed("http://localhost:5174", allowed)).toBe(false);
    expect(isOriginAllowed("http://localhost:5173.evil.example", allowed)).toBe(false);
    expect(isOriginAllowed("null", allowed)).toBe(false);
    expect(isOriginAllowed("", allowed)).toBe(false);
  });

  test("a literal * allows everything that is not null", () => {
    expect(isOriginAllowed("https://anything.example", ["*"])).toBe(true);
    expect(isOriginAllowed("null", ["*"])).toBe(false);
  });

  test("DBCHAT_ALLOWED_ORIGINS is parsed into the list", () => {
    const cfg = loadConfigFromEnv({ DBCHAT_ALLOWED_ORIGINS: " http://a:1 ,http://b:2, " });
    expect(cfg.allowedOrigins).toEqual(["http://a:1", "http://b:2"]);
  });
});
