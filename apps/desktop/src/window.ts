import { BrowserWindow, nativeTheme, screen, shell } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface Bounds { x?: number; y?: number; width: number; height: number; maximized?: boolean }
const DEFAULT: Bounds = { width: 1280, height: 820 };

function readBounds(file: string): Bounds {
  try {
    if (!existsSync(file)) return DEFAULT;
    const b = JSON.parse(readFileSync(file, "utf8")) as Bounds;
    if (typeof b.width !== "number" || typeof b.height !== "number") return DEFAULT;
    // Drop the position if it is no longer on any display.
    if (b.x !== undefined && b.y !== undefined) {
      const onScreen = screen.getAllDisplays().some((d) => {
        const a = d.workArea;
        return b.x! >= a.x - 50 && b.y! >= a.y - 50 && b.x! < a.x + a.width && b.y! < a.y + a.height;
      });
      if (!onScreen) { delete b.x; delete b.y; }
    }
    return b;
  } catch {
    return DEFAULT;
  }
}

export interface CreateWindowOptions {
  readonly preload: string;
  readonly stateFile: string;
  /** Extra CLI args for the preload (it reads `--dbchat-server=`). */
  readonly serverUrl: string;
  readonly show?: boolean;
}

export function createMainWindow(opts: CreateWindowOptions): BrowserWindow {
  const saved = readBounds(opts.stateFile);
  const isMac = process.platform === "darwin";
  const win = new BrowserWindow({
    ...(saved.x !== undefined ? { x: saved.x, y: saved.y } : {}),
    width: saved.width,
    height: saved.height,
    minWidth: 800,
    minHeight: 500,
    show: opts.show ?? false,
    title: "dbchat",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#16171a" : "#ffffff",
    ...(isMac ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 18 } } : {}),
    webPreferences: {
      preload: opts.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: [`--dbchat-server=${opts.serverUrl}`],
    },
  });
  if (saved.maximized) win.maximize();

  // Persist bounds (debounced).
  let t: NodeJS.Timeout | undefined;
  const persist = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      try {
        const b = win.isMaximized() ? { ...win.getNormalBounds(), maximized: true } : { ...win.getBounds(), maximized: false };
        mkdirSync(dirname(opts.stateFile), { recursive: true });
        writeFileSync(opts.stateFile, JSON.stringify(b));
      } catch {}
    }, 400);
  };
  win.on("resize", persist);
  win.on("move", persist);
  win.on("maximize", persist);
  win.on("unmaximize", persist);

  // External links → default browser; never navigate the shell away from the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    const cur = new URL(win.webContents.getURL());
    const next = new URL(url);
    if (next.origin !== cur.origin) {
      e.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });

  win.webContents.on("preload-error", (_e, path, error) => console.error(`[desktop] preload failed: ${path}: ${error.message}`));
  win.webContents.on("console-message", (ev) => { if (ev.level === "error") console.error(`[renderer] ${ev.message}`); });

  win.once("ready-to-show", () => { if (opts.show !== false) win.show(); });
  return win;
}

/** Follow the renderer's theme (it toggles `dark` on <html>); keeps the native chrome in sync. */
export function syncNativeTheme(win: BrowserWindow): void {
  const apply = async () => {
    try {
      const dark = await win.webContents.executeJavaScript("document.documentElement.classList.contains('dark')", true);
      nativeTheme.themeSource = dark ? "dark" : "light";
      win.setBackgroundColor(dark ? "#16171a" : "#ffffff");
    } catch {}
  };
  win.webContents.on("did-finish-load", () => {
    void apply();
    // Observe class changes on <html> and report back through the document title hack-free channel: console message.
    void win.webContents.executeJavaScript(
      `new MutationObserver(() => console.debug('dbchat:theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light'))
         .observe(document.documentElement, { attributes: true, attributeFilter: ['class'] }); void 0;`,
      true,
    );
  });
  win.webContents.on("console-message", (event) => {
    const m = /^dbchat:theme (dark|light)$/.exec(event.message);
    if (m) {
      nativeTheme.themeSource = m[1] as "dark" | "light";
      win.setBackgroundColor(m[1] === "dark" ? "#16171a" : "#ffffff");
    }
  });
}
