#!/usr/bin/env bun
/** Runs server + web dev processes with prefixed output. `bun run dev`. */
const procs: Array<{ name: string; color: string; cwd: string; cmd: string[] }> = [
  { name: "server", color: "\x1b[36m", cwd: "apps/server", cmd: ["bun", "run", "dev"] },
  { name: "web", color: "\x1b[35m", cwd: "apps/web", cmd: ["bun", "run", "dev"] },
];
const reset = "\x1b[0m";
const children: Bun.Subprocess[] = [];

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

for (const p of procs) {
  const child = Bun.spawn(p.cmd, { cwd: p.cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, FORCE_COLOR: "1" } });
  children.push(child);
  const prefix = `${p.color}[${p.name}]${reset}`;
  void pipe(child.stdout, prefix);
  void pipe(child.stderr, prefix);
  void child.exited.then((code) => {
    console.log(`${prefix} exited with code ${code}`);
    shutdown(code ?? 1);
  });
}

function shutdown(code = 0) {
  for (const c of children) {
    try { c.kill(); } catch {}
  }
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
