/** Sandboxed preload: exposes the server URL and tags <html> so CSS can adapt to the shell. */
import { contextBridge, ipcRenderer } from "electron";

const serverArg = process.argv.find((a) => a.startsWith("--dbchat-server="));
const serverUrl = serverArg ? serverArg.slice("--dbchat-server=".length) : undefined;
const canCheckForUpdates = process.argv.includes("--dbchat-can-check-for-updates");

contextBridge.exposeInMainWorld("dbchat", {
  serverUrl,
  platform: process.platform,
  isElectron: true,
  canCheckForUpdates,
  checkForUpdates: () => ipcRenderer.invoke("dbchat:check-for-updates") as Promise<void>,
  updater: {
    getState: () => ipcRenderer.invoke("dbchat:update:state"),
    check: () => ipcRenderer.invoke("dbchat:update:check") as Promise<void>,
    download: () => ipcRenderer.invoke("dbchat:update:download") as Promise<void>,
    install: () => ipcRenderer.invoke("dbchat:update:install") as Promise<void>,
    onChange: (cb: (state: unknown) => void) => {
      const handler = (_e: unknown, state: unknown) => cb(state);
      ipcRenderer.on("dbchat:update:changed", handler);
      return () => { ipcRenderer.removeListener("dbchat:update:changed", handler); };
    },
  },
});

const tag = () => {
  const cls = document.documentElement.classList;
  cls.add("electron");
  if (process.platform === "darwin") cls.add("mac");
};
if (document.documentElement) tag();
else document.addEventListener("DOMContentLoaded", tag, { once: true });
