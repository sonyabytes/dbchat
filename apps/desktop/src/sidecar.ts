/**
 * Spawns and supervises the Bun server binary.
 *
 * env passed to the child: PORT, HOST=127.0.0.1, DBCHAT_HOME, DBCHAT_ALLOWED_ORIGINS,
 * DBCHAT_CLAUDE_CLI (bundled `claude`, used only as a fallback — see server/agent/claudeRuntime.ts). stdout/stderr → <logs>/server.log.
 * Crash policy: restart up to MAX_RESTARTS times within the app lifetime, then give up (onFatal).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

export interface SidecarOptions {
  readonly binary: string;
  readonly claudeCli?: string | undefined;
  readonly home: string;
  readonly logsDir: string;
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly onFatal: (error: Error) => void;
  readonly log?: (line: string) => void;
}

const MAX_RESTARTS = 3;

export async function pickFreePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolvePort(port));
    });
  });
}

export async function waitForHealth(url: string, timeoutMs = 15_000, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("sidecar exited before becoming healthy");
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not become healthy at ${url}: ${String(lastError)}`);
}

export class Sidecar {
  readonly port: number;
  readonly httpUrl: string;
  readonly rpcUrl: string;
  private child: ChildProcess | undefined;
  private restarts = 0;
  private stopping = false;
  private logStream: WriteStream | undefined;
  private exitAbort = new AbortController();

  private readonly opts: SidecarOptions;

  constructor(opts: SidecarOptions, port: number) {
    this.opts = opts;
    this.port = port;
    this.httpUrl = `http://127.0.0.1:${port}`;
    this.rpcUrl = `ws://127.0.0.1:${port}/rpc`;
  }

  static async start(opts: SidecarOptions): Promise<Sidecar> {
    const port = await pickFreePort();
    const s = new Sidecar(opts, port);
    s.spawn();
    await waitForHealth(`${s.httpUrl}/health`, 20_000, s.exitAbort.signal);
    return s;
  }

  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(this.port),
      HOST: "127.0.0.1",
      DBCHAT_HOME: this.opts.home,
      DBCHAT_ALLOWED_ORIGINS: this.opts.allowedOrigins.join(","),
    };
    if (this.opts.claudeCli && existsSync(this.opts.claudeCli)) env.DBCHAT_CLAUDE_CLI = this.opts.claudeCli;
    // Electron sets these for its own children; the Bun binary must not inherit them.
    delete env.ELECTRON_RUN_AS_NODE;
    return env;
  }

  private spawn(): void {
    mkdirSync(this.opts.logsDir, { recursive: true });
    mkdirSync(this.opts.home, { recursive: true });
    this.logStream ??= createWriteStream(join(this.opts.logsDir, "server.log"), { flags: "a" });
    this.logStream.write(`\n--- ${new Date().toISOString()} spawn ${this.opts.binary} (port ${this.port}, attempt ${this.restarts + 1})\n`);
    this.exitAbort = new AbortController();

    const child = spawn(this.opts.binary, [], { env: this.env(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    child.stdout?.on("data", (d: Buffer) => this.logStream?.write(d));
    child.stderr?.on("data", (d: Buffer) => this.logStream?.write(d));
    child.on("error", (err) => {
      this.logStream?.write(`spawn error: ${err.message}\n`);
      this.exitAbort.abort();
      if (!this.stopping) this.opts.onFatal(err);
    });
    child.on("exit", (code, sig) => {
      this.logStream?.write(`--- exited code=${code} signal=${sig}\n`);
      this.exitAbort.abort();
      if (this.stopping) return;
      if (this.restarts >= MAX_RESTARTS) {
        this.opts.onFatal(new Error(`dbchat server crashed ${this.restarts + 1} times (last exit code ${code}). See ${join(this.opts.logsDir, "server.log")}.`));
        return;
      }
      this.restarts++;
      this.opts.log?.(`sidecar exited (code ${code}); restarting (${this.restarts}/${MAX_RESTARTS})`);
      setTimeout(() => this.spawn(), 500);
    });
  }

  /** SIGTERM, then SIGKILL after `graceMs`. Resolves once the child has exited. */
  stop(graceMs = 1500): Promise<void> {
    this.stopping = true;
    this.logStream?.write(`--- stop requested\n`);
    const c = this.child;
    if (!c || c.exitCode !== null || c.signalCode !== null) { this.logStream?.end(); return Promise.resolve(); }
    return new Promise<void>((done) => {
      const finish = () => { clearTimeout(timer); this.logStream?.end(); done(); };
      const timer = setTimeout(() => { try { c.kill("SIGKILL"); } catch {} finish(); }, graceMs);
      c.once("exit", finish);
      try { c.kill("SIGTERM"); } catch { finish(); }
    });
  }
}
