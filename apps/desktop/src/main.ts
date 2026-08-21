/**
 * dbchat desktop shell.
 *
 * Packaged / default:  spawn the Bun server sidecar on a free port, serve apps/web/dist on
 *                      app://dbchat, open the window with `?server=ws://127.0.0.1:<port>/rpc`.
 * Dev (DBCHAT_DEV_URL): load the Vite dev server; the API server is started separately by
 *                      scripts/dev-desktop.ts (DBCHAT_RPC_URL, default ws://127.0.0.1:4800/rpc).
 * --smoke [--smoke-out=<png>]: load, wait for /health + the connections list, screenshot, exit 0.
 */
import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from "electron";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { installAppMenu } from "./menu.ts";
import { hasSidecar, hasWebDist, isPackaged, paths } from "./paths.ts";
import { APP_ORIGIN, registerAppScheme, serveWebDist } from "./protocol.ts";
import { Sidecar, waitForHealth } from "./sidecar.ts";
import { Updater } from "./updater.ts";
import { createMainWindow, syncNativeTheme } from "./window.ts";

const argv = process.argv.slice(1);
const SMOKE = argv.includes("--smoke");
const smokePath = argv.find((a) => a.startsWith("--smoke-path="))?.slice("--smoke-path=".length);
const smokeOut = resolve(argv.find((a) => a.startsWith("--smoke-out="))?.slice("--smoke-out=".length) ?? join(process.cwd(), "smoke.png"));
const DEV_URL = process.env.DBCHAT_DEV_URL;
const isDev = !isPackaged;
const UPDATE_REPO = process.env.DBCHAT_UPDATE_REPO ?? "sonyabytes/dbchat";

app.setName("dbchat");
// Renderer heap: a 1.7 MB SPA has no business growing past ~256 MB; a lower ceiling makes V8 GC sooner.
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=256");
if (SMOKE) app.setPath("userData", mkdtempSync(join(tmpdir(), "dbchat-smoke-")));
registerAppScheme();

if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  });
}

let sidecar: Sidecar | undefined;
let mainWindow: BrowserWindow | undefined;
let updater: Updater | undefined;
const log = (line: string) => {
  const msg = `[desktop] ${line}`;
  console.log(msg);
  try {
    mkdirSync(paths.logs(), { recursive: true });
    writeFileSync(join(paths.logs(), "desktop.log"), `${new Date().toISOString()} ${line}\n`, { flag: "a" });
  } catch {}
};

function fatal(title: string, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  log(`FATAL ${title}: ${message}`);
  if (SMOKE) {
    console.error(`[smoke] FAIL ${title}: ${message}`);
  } else {
    dialog.showErrorBox(title, message);
  }
  const s = sidecar;
  sidecar = undefined;
  void (s ? s.stop() : Promise.resolve()).then(() => app.exit(1));
  setTimeout(() => process.exit(1), 3000).unref();
  throw error;
}

async function resolveServer(): Promise<{ rpcUrl: string; httpUrl: string; appUrl: string }> {
  if (DEV_URL) {
    const rpcUrl = process.env.DBCHAT_RPC_URL ?? "ws://127.0.0.1:4800/rpc";
    const httpUrl = rpcUrl.replace(/^ws/, "http").replace(/\/rpc$/, "");
    log(`dev mode: renderer ${DEV_URL}, server ${rpcUrl}`);
    await waitForHealth(`${httpUrl}/health`, 60_000);
    return { rpcUrl, httpUrl, appUrl: DEV_URL };
  }
  if (!hasSidecar()) throw new Error(`server binary missing at ${paths.sidecar}. Run: bun run build:sidecar`);
  if (!hasWebDist()) throw new Error(`web build missing at ${paths.webDist}. Run: bun run --filter @dbchat/web build`);
  serveWebDist(paths.webDist);
  sidecar = await Sidecar.start({
    binary: paths.sidecar,
    claudeCli: paths.claudeCli,
    home: paths.home(),
    logsDir: paths.logs(),
    allowedOrigins: [APP_ORIGIN],
    log,
    onFatal: (e) => fatal("dbchat server stopped", e),
  });
  log(`sidecar up on ${sidecar.httpUrl} (home ${paths.home()})`);
  return { rpcUrl: sidecar.rpcUrl, httpUrl: sidecar.httpUrl, appUrl: `${APP_ORIGIN}/` };
}

async function runSmoke(win: BrowserWindow, httpUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  const probe = `(() => {
    const t = (document.body?.innerText ?? "").toLowerCase();
    const h1 = ${smokePath ? "true" : '!!document.querySelector("h1")'};
    const skeletons = document.querySelectorAll('[data-slot="skeleton"]').length;
    const err = t.includes("can’t reach") || t.includes("server unreachable");
    const listed = ${smokePath ? "true" : 't.includes("no connections yet") || t.includes("open →")'};
    return { h1, skeletons, err, listed, ready: h1 && !err && skeletons === 0 && listed, title: document.title, url: location.href, htmlClass: document.documentElement.className, bridge: typeof window.dbchat };
  })()`;
  let last: unknown;
  while (Date.now() < deadline) {
    const health = await fetch(`${httpUrl}/health`).then((r) => r.ok).catch(() => false);
    last = await win.webContents.executeJavaScript(probe, true).catch((e) => ({ error: String(e) }));
    if (health && (last as { ready?: boolean })?.ready) {
      await new Promise((r) => setTimeout(r, 400)); // let fonts/paint settle
      const img = await win.webContents.capturePage();
      mkdirSync(dirname(smokeOut), { recursive: true });
      writeFileSync(smokeOut, img.toPNG());
      console.log(`[smoke] OK ${JSON.stringify(last)} → ${smokeOut}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`renderer never became ready: ${JSON.stringify(last)}`);
}

async function main(): Promise<void> {
  await app.whenReady();
  if (!SMOKE && !DEV_URL) {
    updater = new Updater({ repo: UPDATE_REPO, stateFile: paths.updaterState(), log, quit: () => app.quit() });
  }
  ipcMain.handle("dbchat:check-for-updates", async () => {
    if (updater) await updater.check({ interactive: true });
  });
  ipcMain.handle("dbchat:update:state", () => updater?.getState());
  ipcMain.handle("dbchat:update:check", async () => { await updater?.check({ interactive: false }); });
  ipcMain.handle("dbchat:update:download", async () => { await updater?.download(); });
  ipcMain.handle("dbchat:update:install", () => { updater?.install(); });
  updater?.onChange((st) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("dbchat:update:changed", st);
  });
  installAppMenu({ isDev, checkForUpdates: updater ? () => void updater?.check({ interactive: true }) : undefined });
  const server = await resolveServer();
  const url = new URL(server.appUrl);
  if (SMOKE && smokePath) url.pathname = smokePath;
  url.searchParams.set("server", server.rpcUrl);

  mainWindow = createMainWindow({ preload: paths.preload, stateFile: paths.windowState(), serverUrl: server.rpcUrl, canCheckForUpdates: updater !== undefined, show: !SMOKE });
  syncNativeTheme(mainWindow);
  mainWindow.on("closed", () => { mainWindow = undefined; });
  nativeTheme.on("updated", () => {});

  await mainWindow.loadURL(url.toString());
  updater?.start();
  if (SMOKE) {
    try {
      await runSmoke(mainWindow, server.httpUrl);
      app.quit();
    } catch (e) {
      fatal("smoke failed", e);
    }
  }
}

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && sidecar) {
    const url = new URL(`${APP_ORIGIN}/`);
    url.searchParams.set("server", sidecar.rpcUrl);
    mainWindow = createMainWindow({ preload: paths.preload, stateFile: paths.windowState(), serverUrl: sidecar.rpcUrl, canCheckForUpdates: updater !== undefined });
    syncNativeTheme(mainWindow);
    void mainWindow.loadURL(url.toString());
  }
});
app.on("window-all-closed", () => { if (process.platform !== "darwin" || SMOKE) app.quit(); });
// Hold the quit until the sidecar is gone (SIGTERM, SIGKILL after 1.5s); then exit for real.
let quitting = false;
app.on("before-quit", (e) => {
  if (quitting || !sidecar) return;
  quitting = true;
  e.preventDefault();
  const s = sidecar;
  sidecar = undefined;
  void s.stop().then(() => { log("sidecar stopped"); app.exit(0); });
});

main().catch((e) => fatal("dbchat failed to start", e));
