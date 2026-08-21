/**
 * Self-updater for the unsigned macOS build.
 *
 * electron-updater needs a code-signed app on macOS, so this mirrors install.sh instead:
 *   1. GET https://api.github.com/repos/<repo>/releases/latest → compare tag (vX.Y.Z) with app.getVersion()
 *   2. download the *-arm64.dmg asset to a temp dir
 *   3. spawn a detached shell script that waits for this process to exit, mounts the dmg,
 *      replaces the .app in place (ditto), clears quarantine, relaunches — then app.quit()
 * Checks run on launch (after a short delay) and every CHECK_INTERVAL_MS; "Check for Updates…" in the app menu
 * runs it interactively; the sidebar icon drives it silently through state events (see getState/onChange).
 */
import { app, dialog, shell } from "electron";
import { spawn } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

export interface UpdaterOptions {
  readonly repo: string;
  readonly stateFile: string;
  readonly log?: (line: string) => void;
  /** Called right before the swap script runs; should stop the sidecar and quit. */
  readonly quit: () => void;
}

export interface ReleaseInfo {
  readonly version: string;
  readonly tag: string;
  readonly url: string; // html_url
  readonly dmgUrl: string;
  readonly notes: string;
}

export type UpdateStatus = "idle" | "checking" | "available" | "downloading" | "ready" | "error";
export interface UpdateState {
  readonly status: UpdateStatus;
  readonly current: string;
  readonly latest?: { version: string; notes: string; url: string } | undefined;
  /** 0..1 while downloading. */
  readonly progress?: number | undefined;
  readonly error?: string | undefined;
}

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 8_000;
const ASSET_RE = /-arm64\.dmg$/;

type State = { lastCheck?: string };

export const parseVersion = (v: string): number[] | undefined => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
};

/** >0 if a is newer than b. */
export const compareVersions = (a: string, b: string): number => {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
};

export async function fetchLatestRelease(repo: string): Promise<ReleaseInfo | undefined> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": `dbchat/${app.getVersion()}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return undefined; // no releases yet
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const json = (await res.json()) as { tag_name: string; html_url: string; body?: string; assets?: { name: string; browser_download_url: string }[] };
  const asset = json.assets?.find((a) => ASSET_RE.test(a.name));
  if (!asset) return undefined;
  const version = parseVersion(json.tag_name)?.join(".");
  if (!version) return undefined;
  return { version, tag: json.tag_name, url: json.html_url, dmgUrl: asset.browser_download_url, notes: json.body ?? "" };
}

/** Path of the running .app bundle, or undefined when not a packaged macOS app (or translocated / not writable). */
export function installedAppBundle(): string | undefined {
  if (process.platform !== "darwin" || !app.isPackaged) return undefined;
  // <bundle>.app/Contents/MacOS/<exe>
  const bundle = resolve(dirname(process.execPath), "..", "..");
  if (!bundle.endsWith(".app")) return undefined;
  if (bundle.includes("/AppTranslocation/")) return undefined;
  return bundle;
}

async function download(url: string, dest: string, onProgress?: (pct: number) => void): Promise<void> {
  const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": `dbchat/${app.getVersion()}` } });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  let got = 0;
  const src = Readable.fromWeb(res.body as unknown as import("stream/web").ReadableStream);
  src.on("data", (c: Buffer) => { got += c.length; if (total) onProgress?.(got / total); });
  await pipeline(src, createWriteStream(dest));
}

const SWAP_SCRIPT = `#!/bin/bash
# dbchat self-update: wait for the app to exit, swap the bundle, relaunch.
set -u
PID="$1"; DMG="$2"; APP="$3"; LOG="$4"
exec >>"$LOG" 2>&1
echo "--- $(date) update start pid=$PID dmg=$DMG app=$APP"
for _ in $(seq 1 120); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
MOUNT="$(hdiutil attach -nobrowse -readonly "$DMG" | grep -Eo '/Volumes/.*' | head -1)"
[[ -n "$MOUNT" ]] || { echo "mount failed"; open "$APP"; exit 1; }
SRC="$(find "$MOUNT" -maxdepth 1 -name '*.app' | head -1)"
if [[ -z "$SRC" ]]; then echo "no .app in dmg"; hdiutil detach "$MOUNT" -quiet; open "$APP"; exit 1; fi
STAGE="$APP.update-$$"
if ditto "$SRC" "$STAGE"; then
  rm -rf "$APP.old"; mv "$APP" "$APP.old" && mv "$STAGE" "$APP" && rm -rf "$APP.old"
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
  echo "installed"
else
  echo "ditto failed"; rm -rf "$STAGE"
fi
hdiutil detach "$MOUNT" -quiet || true
rm -rf "$(dirname "$DMG")"
open "$APP"
echo "--- done"
`;

export class Updater {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private readonly opts: UpdaterOptions;
  private state: UpdateState;
  private readonly listeners = new Set<(s: UpdateState) => void>();
  /** Downloaded-and-staged install, waiting for a restart. */
  private staged: { script: string; dmg: string; bundle: string; logFile: string } | undefined;
  constructor(opts: UpdaterOptions) {
    this.opts = opts;
    this.state = { status: "idle", current: app.getVersion() };
  }

  getState(): UpdateState { return this.state; }
  onChange(cb: (s: UpdateState) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }
  private setState(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    for (const cb of this.listeners) cb(this.state);
  }

  /** Background checks: on launch and periodically. No-op unless running as a packaged macOS app. */
  start(): void {
    if (!installedAppBundle()) { this.log("disabled (not an installed packaged build)"); return; }
    setTimeout(() => void this.check({ interactive: false }), STARTUP_DELAY_MS).unref();
    this.timer = setInterval(() => void this.check({ interactive: false }), CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }

  /**
   * Fetch the latest release and update state. Interactive (menu) mode shows native dialogs; silent mode
   * (background timer, sidebar icon) only updates state so the renderer can render it.
   */
  async check(o: { interactive: boolean }): Promise<void> {
    if (this.busy || this.state.status === "downloading" || this.state.status === "ready") return;
    this.busy = true;
    try {
      const bundle = installedAppBundle();
      if (!bundle) {
        if (o.interactive) await dialog.showMessageBox({ type: "info", message: "Updates are only available for the installed macOS app.", detail: "Move dbchat.app to /Applications (or run the installer) to enable in-app updates." });
        return;
      }
      this.setState({ status: "checking", error: undefined });
      const current = app.getVersion();
      const latest = await fetchLatestRelease(this.opts.repo);
      const state = this.readState();
      this.writeState({ ...state, lastCheck: new Date().toISOString() });
      if (!latest || compareVersions(latest.version, current) <= 0) {
        this.log(`up to date (${current}${latest ? `, latest ${latest.version}` : ", no release"})`);
        this.setState({ status: "idle", latest: undefined });
        if (o.interactive) await dialog.showMessageBox({ type: "info", message: "You’re up to date.", detail: `dbchat ${current} is the latest version.` });
        return;
      }
      this.log(`update available: ${current} → ${latest.version}`);
      this.setState({ status: "available", latest: { version: latest.version, notes: latest.notes, url: latest.url } });
      if (!o.interactive) return;
      const { response } = await dialog.showMessageBox({
        type: "info",
        message: `dbchat ${latest.version} is available`,
        detail: `You have ${current}. The update downloads in the background, then dbchat restarts to install it.\n\n${latest.notes.slice(0, 1200)}`.trim(),
        buttons: ["Download & Install", "Release Notes", "Later"],
        cancelId: 2,
        defaultId: 0,
      });
      if (response === 1) { void shell.openExternal(latest.url); return; }
      if (response === 2) return;
      this.busy = false;
      await this.download();
      if ((this.state as UpdateState).status === "ready") {
        const r = await dialog.showMessageBox({
          type: "info",
          message: `Restart to install dbchat ${latest.version}?`,
          detail: "dbchat will quit, replace itself, and reopen in a few seconds.",
          buttons: ["Restart Now", "Later"],
          cancelId: 1,
          defaultId: 0,
        });
        if (r.response === 0) this.install(); else this.log("install deferred by user");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`check failed: ${msg}`);
      this.setState({ status: "error", error: msg });
      if (o.interactive) await dialog.showMessageBox({ type: "error", message: "Couldn’t check for updates", detail: msg });
    } finally {
      this.busy = false;
    }
  }

  /** Download the available release and stage the swap script. Resolves with status "ready" (or "error"). */
  async download(): Promise<void> {
    if (this.busy) return;
    const rel = this.state.latest;
    const bundle = installedAppBundle();
    if (!rel || !bundle || this.state.status !== "available") return;
    this.busy = true;
    try {
      const dir = mkdtempSync(join(tmpdir(), "dbchat-update-"));
      const dmg = join(dir, `dbchat-${rel.version}-arm64.dmg`);
      const full = await fetchLatestRelease(this.opts.repo);
      if (!full || full.version !== rel.version) throw new Error("release changed while downloading; check again");
      this.setState({ status: "downloading", progress: 0 });
      let lastPct = -1;
      this.log(`downloading ${full.dmgUrl}`);
      await download(full.dmgUrl, dmg, (p) => {
        const pct = Math.floor(p * 100);
        if (pct !== lastPct) { lastPct = pct; app.dock?.setBadge?.(`${pct}%`); this.setState({ progress: p }); }
      });
      app.dock?.setBadge?.("");
      if (!existsSync(dmg)) throw new Error("download produced no file");
      const script = join(dir, "swap.sh");
      writeFileSync(script, SWAP_SCRIPT);
      chmodSync(script, 0o755);
      const logFile = join(app.getPath("userData"), "logs", "update.log");
      this.staged = { script, dmg, bundle, logFile };
      this.setState({ status: "ready", progress: 1 });
    } catch (e) {
      app.dock?.setBadge?.("");
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`download failed: ${msg}`);
      this.setState({ status: "error", error: msg });
    } finally {
      this.busy = false;
    }
  }

  /** Quit and run the staged swap script. No-op unless a download is ready. */
  install(): void {
    const st = this.staged;
    if (!st || this.state.status !== "ready") return;
    this.log(`spawning swap script; target ${st.bundle}`);
    const child = spawn("/bin/bash", [st.script, String(process.pid), st.dmg, st.bundle, st.logFile], { detached: true, stdio: "ignore" });
    child.unref();
    this.opts.quit();
  }

  private readState(): State {
    try { return JSON.parse(readFileSync(this.opts.stateFile, "utf8")) as State; } catch { return {}; }
  }
  private writeState(s: State): void {
    try { writeFileSync(this.opts.stateFile, JSON.stringify(s)); } catch {}
  }
  private log(line: string): void { this.opts.log?.(`updater: ${line}`); }
}

