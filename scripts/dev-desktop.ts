#!/usr/bin/env bun
/**
 * `bun run dev:desktop` — API server (watch) + Vite + Electron pointed at the Vite dev server.
 * The renderer origin http://localhost:5173 is in the server's default allow-list.
 */
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const reset = "\x1b[0m";
const children: Bun.Subprocess[] = [];
const DEV_URL = "http://localhost:5173";
const RPC_URL = "ws://127.0.0.1:4800/rpc";

async function pipe(stream: ReadableStream<Uint8Array>, prefix: string) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) console.log(`${prefix} ${l}`);
  }
  if (buf) console.log(`${prefix} ${buf}`);
}

function run(name: string, color: string, cwd: string, cmd: string[], env: Record<string, string | undefined> = {}) {
  const child = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, FORCE_COLOR: "1", ...env } });
  children.push(child);
  const prefix = `${color}[${name}]${reset}`;
  void pipe(child.stdout, prefix);
  void pipe(child.stderr, prefix);
  void child.exited.then((code) => {
    console.log(`${prefix} exited with code ${code}`);
    shutdown(code ?? 1);
  });
  return child;
}

function shutdown(code = 0) {
  for (const c of children) { try { c.kill(); } catch {} }
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// Bundle the Electron main once (fast), then start everything.
const build = Bun.spawnSync(["bun", "scripts/build-main.ts"], { cwd: resolve(root, "apps/desktop"), stdout: "inherit", stderr: "inherit", env: { ...process.env, NODE_ENV: "development" } });
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);

run("server", "\x1b[36m", resolve(root, "apps/server"), ["bun", "run", "dev"], {
  DBCHAT_ALLOWED_ORIGINS: `${DEV_URL},http://127.0.0.1:5173,app://dbchat`,
});
run("web", "\x1b[35m", resolve(root, "apps/web"), ["bun", "run", "dev"]);
// Wait for Vite before launching Electron so the first load does not race it.
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  try { if ((await fetch(DEV_URL)).ok) break; } catch {}
  await Bun.sleep(200);
}
const extra = process.argv.slice(2); // e.g. --smoke --smoke-out=smoke.png
run("electron", "\x1b[33m", resolve(root, "apps/desktop"), ["bunx", "electron", ".", ...extra], {
  DBCHAT_DEV_URL: DEV_URL,
  DBCHAT_RPC_URL: RPC_URL,
  ELECTRON_RUN_AS_NODE: undefined,
});
