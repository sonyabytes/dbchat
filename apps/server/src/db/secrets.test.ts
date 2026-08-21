import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decryptWithKey, encryptWithKey, loadOrCreateKeyUnsafe } from "./secrets.ts";

describe("secrets", () => {
  test("generates a 0600 key on first run and reuses it", () => {
    const home = mkdtempSync(join(tmpdir(), "dbchat-key-"));
    const a = loadOrCreateKeyUnsafe(home);
    expect(a.length).toBe(32);
    const mode = statSync(join(home, "key")).mode & 0o777;
    expect(mode).toBe(0o600);
    const b = loadOrCreateKeyUnsafe(home);
    expect(b.toString("base64")).toBe(a.toString("base64"));
  });

  test("round-trips a secret", () => {
    const home = mkdtempSync(join(tmpdir(), "dbchat-key-"));
    const key = loadOrCreateKeyUnsafe(home);
    const enc = encryptWithKey(key, { password: "hunter2", url: "postgres://u:p@h/db" });
    expect(enc.secret).not.toContain("hunter2");
    expect(decryptWithKey(key, enc)).toEqual({ password: "hunter2", url: "postgres://u:p@h/db" });
  });

  test("omits absent fields", () => {
    const home = mkdtempSync(join(tmpdir(), "dbchat-key-"));
    const key = loadOrCreateKeyUnsafe(home);
    expect(decryptWithKey(key, encryptWithKey(key, { password: "x" }))).toEqual({ password: "x" });
  });

  test("a tampered blob fails authentication", () => {
    const home = mkdtempSync(join(tmpdir(), "dbchat-key-"));
    const key = loadOrCreateKeyUnsafe(home);
    const enc = encryptWithKey(key, { password: "hunter2" });
    const bytes = Buffer.from(enc.secret, "base64");
    bytes[0] = bytes[0]! ^ 0xff;
    expect(() => decryptWithKey(key, { secret: bytes.toString("base64"), nonce: enc.nonce })).toThrow();
  });

  test("a different key cannot decrypt", () => {
    const a = loadOrCreateKeyUnsafe(mkdtempSync(join(tmpdir(), "dbchat-key-")));
    const b = loadOrCreateKeyUnsafe(mkdtempSync(join(tmpdir(), "dbchat-key-")));
    const enc = encryptWithKey(a, { password: "hunter2" });
    expect(() => decryptWithKey(b, enc)).toThrow();
  });
});
