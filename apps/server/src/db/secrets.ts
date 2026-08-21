/**
 * Connection-secret encryption.
 *
 * Secrets (`{ password?, url? }`) are stored in `connection_secrets` as an
 * AES-256-GCM blob. The 32-byte key lives in `$DBCHAT_HOME/key` with mode 0600
 * and is generated on first run. (A macOS Keychain-backed key comes later; the
 * `SecretCipher` interface is the seam for that.)
 *
 * Ciphertext and nonce are persisted base64-encoded — SQLite is dynamically
 * typed, so the BLOB columns hold the text fine and we avoid Uint8Array
 * parameter binding differences between drivers.
 */
import type { ConnectionSecret } from "../Services/ConnectionStore.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ServerConfig } from "../config.ts";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedSecret {
  /** base64 of `ciphertext || authTag`. */
  readonly secret: string;
  /** base64 of the 12-byte GCM nonce. */
  readonly nonce: string;
}

/** Reads `$DBCHAT_HOME/key`, creating a fresh 32-byte key on first run. */
export const loadOrCreateKeyUnsafe = (homeDir: string): Buffer => {
  const keyPath = join(homeDir, "key");
  if (existsSync(keyPath)) {
    const raw = readFileSync(keyPath, "utf8").trim();
    const key = Buffer.from(raw, "base64");
    if (key.length !== KEY_BYTES) {
      throw new Error(`dbchat key at ${keyPath} is ${key.length} bytes, expected ${KEY_BYTES}`);
    }
    // Repair permissions if something loosened them.
    try { chmodSync(keyPath, 0o600); } catch { /* best effort */ }
    return key;
  }
  mkdirSync(homeDir, { recursive: true });
  const key = randomBytes(KEY_BYTES);
  writeFileSync(keyPath, `${key.toString("base64")}\n`, { mode: 0o600 });
  try { chmodSync(keyPath, 0o600); } catch { /* best effort */ }
  return key;
};

export const encryptWithKey = (key: Buffer, secret: ConnectionSecret): EncryptedSecret => {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const plaintext = Buffer.from(JSON.stringify(secret), "utf8");
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    secret: Buffer.concat([body, tag]).toString("base64"),
    nonce: nonce.toString("base64"),
  };
};

export const decryptWithKey = (key: Buffer, enc: EncryptedSecret): ConnectionSecret => {
  const blob = Buffer.from(enc.secret, "base64");
  if (blob.length < TAG_BYTES) throw new Error("connection secret is truncated");
  const body = blob.subarray(0, blob.length - TAG_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(enc.nonce, "base64"));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  const parsed: unknown = JSON.parse(plaintext);
  if (parsed === null || typeof parsed !== "object") throw new Error("connection secret is not an object");
  const obj = parsed as Record<string, unknown>;
  return {
    ...(typeof obj["password"] === "string" ? { password: obj["password"] } : {}),
    ...(typeof obj["url"] === "string" ? { url: obj["url"] } : {}),
  };
};

export interface SecretCipherShape {
  readonly encrypt: (secret: ConnectionSecret) => EncryptedSecret;
  readonly decrypt: (enc: EncryptedSecret) => ConnectionSecret;
}

export class SecretCipher extends Context.Service<SecretCipher, SecretCipherShape>()(
  "dbchat/db/SecretCipher",
) {}

/** File-backed cipher rooted at `ServerConfig.homeDir`. */
export const SecretCipherLive = Layer.effect(
  SecretCipher,
  Effect.gen(function* () {
    const { homeDir } = yield* ServerConfig;
    const key = yield* Effect.sync(() => loadOrCreateKeyUnsafe(homeDir));
    return SecretCipher.of({
      encrypt: (secret) => encryptWithKey(key, secret),
      decrypt: (enc) => decryptWithKey(key, enc),
    });
  }),
);
