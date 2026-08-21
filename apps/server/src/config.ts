import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveDefaultModel } from "./agent/models.ts";

export interface ServerConfigShape {
  readonly port: number;
  readonly host: string;
  readonly homeDir: string;
  readonly dbPath: string;
  readonly allowedOrigins: ReadonlyArray<string>;
  /** Default chat model (`DBCHAT_MODEL`); the catalog marks it as the default. */
  readonly model: string;
  readonly version: string;
  /**
   * `DBCHAT_CLAUDE_CLI`: fallback Claude Code binary (the desktop shell points this at its bundled
   * copy, since SDK self-resolution cannot work inside a `bun build --compile` binary). The actual
   * binary/config-dir/env used per turn is resolved in agent/claudeRuntime.ts (user settings and
   * `claude` on PATH take precedence).
   */
  readonly claudeCliPath: string | undefined;
}

export class ServerConfig extends Context.Service<ServerConfig, ServerConfigShape>()(
  "dbchat/ServerConfig",
) {}

export const loadConfigFromEnv = (env: Record<string, string | undefined> = process.env): ServerConfigShape => {
  const homeDir = env.DBCHAT_HOME ?? join(homedir(), ".dbchat");
  const port = Number(env.PORT ?? 4800);
  return {
    port: Number.isFinite(port) ? port : 4800,
    host: env.HOST ?? "127.0.0.1",
    homeDir,
    dbPath: join(homeDir, "dbchat.sqlite"),
    allowedOrigins: (env.DBCHAT_ALLOWED_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    model: resolveDefaultModel(env),
    version: "0.1.0",
    claudeCliPath: env.DBCHAT_CLAUDE_CLI?.trim() || undefined,
  };
};

/**
 * WebSocket upgrades are not subject to CORS, so any web page the user visits
 * could open `ws://127.0.0.1:4800/rpc` and drive the server. Browsers always
 * send an `Origin` header on the upgrade; we accept it only when it is on the
 * allow-list. Requests without an `Origin` (CLI tools, the smoke scripts, the
 * desktop shell) are not browser-initiated and pass through.
 */
export const isOriginAllowed = (origin: string | undefined, allowedOrigins: ReadonlyArray<string>): boolean => {
  if (origin === undefined) return true;
  const o = origin.trim().replace(/\/+$/, "").toLowerCase();
  if (o.length === 0 || o === "null") return false;
  return allowedOrigins.some((a) => a === "*" || a.trim().replace(/\/+$/, "").toLowerCase() === o);
};

export const ServerConfigLive = Layer.succeed(ServerConfig, loadConfigFromEnv());
