/** Where things live in dev (repo checkout) vs packaged (.app/Contents/Resources). */
import { app } from "electron";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const isPackaged = app.isPackaged;
// NB: Bun's bundler inlines `__dirname` to the *source* dir, so use app.getAppPath() instead:
// apps/desktop in dev, Contents/Resources/app.asar when packaged (both contain dist/).
const desktopRoot = app.getAppPath();
/** Contents/Resources when packaged. */
const resourcesRoot = process.resourcesPath;

export const paths = {
  /** Sandboxed preload bundle (scripts/build-main.ts). */
  preload: join(desktopRoot, "dist", "preload.cjs"),
  /** Static web build served on app://dbchat. */
  webDist: isPackaged ? join(resourcesRoot, "web") : resolve(desktopRoot, "../web/dist"),
  /** Compiled Bun server binary (apps/server/scripts/build-sidecar.ts). */
  sidecar: isPackaged ? join(resourcesRoot, "bin", "dbchat-server") : resolve(desktopRoot, "sidecar", "dbchat-server"),
  /** Native Claude Code CLI shipped next to the sidecar (optional). */
  claudeCli: isPackaged ? join(resourcesRoot, "bin", "claude") : resolve(desktopRoot, "sidecar", "claude"),
  /** Per-user state: sqlite, AES key, logs. */
  home: () => join(app.getPath("userData"), "dbchat"),
  logs: () => join(app.getPath("userData"), "logs"),
  windowState: () => join(app.getPath("userData"), "window-state.json"),
};

export const hasSidecar = () => existsSync(paths.sidecar);
export const hasWebDist = () => existsSync(join(paths.webDist, "index.html"));
