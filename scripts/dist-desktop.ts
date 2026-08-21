#!/usr/bin/env bun
/**
 * `bun run dist:desktop` — builds the macOS .dmg (arm64, unsigned) into apps/desktop/release/.
 *   1. web build (apps/web/dist)            → Resources/web
 *   2. server sidecar (apps/desktop/sidecar) → Resources/bin/{dbchat-server,claude}
 *   3. electron main/preload bundle          → app.asar
 *   4. electron-builder --mac dmg --arm64
 * Flags: --skip-web --skip-sidecar (reuse previous outputs), --dir (unpacked .app only, no dmg).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const args = new Set(process.argv.slice(2));
const step = (name: string, cmd: string[], cwd = root, env: Record<string, string> = {}) => {
  console.log(`\n\x1b[1m[dist] ${name}\x1b[0m  $ ${cmd.join(" ")}`);
  const r = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit", env: { ...process.env, ...env } });
  if (r.exitCode !== 0) { console.error(`[dist] step "${name}" failed (${r.exitCode})`); process.exit(r.exitCode ?? 1); }
};

if (!args.has("--skip-web") || !existsSync(resolve(root, "apps/web/dist/index.html"))) {
  step("contracts typecheck", ["bun", "run", "--filter", "@dbchat/contracts", "build"]);
  step("web build", ["bun", "run", "--filter", "@dbchat/web", "build"]);
}
if (!args.has("--skip-sidecar") || !existsSync(resolve(root, "apps/desktop/sidecar/dbchat-server"))) {
  step("server sidecar", ["bun", "apps/server/scripts/build-sidecar.ts", "--target", "bun-darwin-arm64"]);
}
if (!existsSync(resolve(root, "apps/desktop/resources/icon.icns"))) {
  step("app icon", ["bun", "scripts/make-icon.ts"], resolve(root, "apps/desktop"));
}
step("electron main bundle", ["bun", "scripts/build-main.ts"], resolve(root, "apps/desktop"));
step(
  "electron-builder",
  ["bunx", "electron-builder", "--mac", args.has("--dir") ? "dir" : "dmg", "--arm64", "--config", "electron-builder.yml", "--publish", "never"],
  resolve(root, "apps/desktop"),
  { CSC_IDENTITY_AUTO_DISCOVERY: "false" },
);
console.log("\n[dist] done → apps/desktop/release/");
