#!/usr/bin/env bun
/**
 * Builds the server as a standalone binary (bun runtime embedded) for the desktop shell.
 *
 *   bun apps/server/scripts/build-sidecar.ts [--out <dir>] [--target bun-darwin-arm64]
 *
 * Output: <out>/dbchat-server   (default out: apps/desktop/sidecar)
 *         <out>/claude          (native Claude Code CLI, copied from the Agent SDK's platform package)
 *
 * The Agent SDK locates its native `claude` binary with `createRequire(import.meta.url).resolve(...)`,
 * which cannot work from inside a compiled binary ($bunfs). The desktop shell therefore ships the
 * binary next to the sidecar and points the server at it via `DBCHAT_CLAUDE_CLI` (see config.ts).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const serverDir = resolve(import.meta.dir, "..");
const repoRoot = resolve(serverDir, "../..");
const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const outDir = resolve(flag("--out", join(repoRoot, "apps/desktop/sidecar")));
const target = flag("--target", `bun-${process.platform}-${process.arch}`);
mkdirSync(outDir, { recursive: true });

const outfile = join(outDir, "dbchat-server");
console.log(`[sidecar] bun build --compile --target=${target} → ${outfile}`);
const build = Bun.spawnSync(
  ["bun", "build", "--compile", `--target=${target}`, "--minify", join(serverDir, "src/main.ts"), "--outfile", outfile],
  { cwd: serverDir, stdout: "inherit", stderr: "inherit" },
);
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);

// Copy the native Claude Code CLI that matches the target.
const [, plat, arch] = target.split("-");
const pkg = `@anthropic-ai/claude-agent-sdk-${plat}-${arch}`;
const req = createRequire(join(serverDir, "package.json"));
let cli: string | undefined;
try {
  cli = join(dirname(req.resolve(`${pkg}/package.json`)), plat === "win32" ? "claude.exe" : "claude");
} catch {
  // Not linked into apps/server/node_modules (bun keeps optional platform packages only in the
  // hoisted store). Look there directly.
  const store = join(repoRoot, "node_modules/.bun");
  const prefix = `${pkg.replace("/", "+")}@`;
  const hit = existsSync(store) ? readdirSync(store).filter((d) => d.startsWith(prefix)).sort().at(-1) : undefined;
  if (hit) cli = join(store, hit, "node_modules", pkg, plat === "win32" ? "claude.exe" : "claude");
}
if (cli && existsSync(cli)) {
  const dest = join(outDir, plat === "win32" ? "claude.exe" : "claude");
  cpSync(cli, dest);
  console.log(`[sidecar] copied ${pkg}/claude (${(statSync(dest).size / 1e6).toFixed(0)} MB) → ${dest}`);
} else {
  console.warn(`[sidecar] WARNING: ${pkg} not found; the packaged app will need DBCHAT_CLAUDE_CLI or a global \`claude\` install.`);
}
console.log(`[sidecar] done: ${(statSync(outfile).size / 1e6).toFixed(0)} MB`);
