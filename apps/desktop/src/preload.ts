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
});

const tag = () => {
  const cls = document.documentElement.classList;
  cls.add("electron");
  if (process.platform === "darwin") cls.add("mac");
};
if (document.documentElement) tag();
else document.addEventListener("DOMContentLoaded", tag, { once: true });
