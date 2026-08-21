import { app, Menu, type MenuItemConstructorOptions, shell } from "electron";

export function installAppMenu(opts: { readonly isDev: boolean; readonly checkForUpdates?: (() => void) | undefined }): void {
  const isMac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{ label: app.name, submenu: [{ role: "about" }, ...(opts.checkForUpdates ? [{ label: "Check for Updates…", click: opts.checkForUpdates } satisfies MenuItemConstructorOptions] : []), { type: "separator" }, { role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] } satisfies MenuItemConstructorOptions]
      : []),
    { label: "File", submenu: [isMac ? { role: "close" } : { role: "quit" }] },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        ...(opts.isDev ? [{ role: "toggleDevTools" } satisfies MenuItemConstructorOptions] : []),
        { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, ...(isMac ? [{ type: "separator" } as const, { role: "front" } as const] : [{ role: "close" } as const])] },
    { role: "help", submenu: [{ label: "dbchat on GitHub", click: () => void shell.openExternal("https://github.com/sonyabytes/dbchat") }, ...(!isMac && opts.checkForUpdates ? [{ label: "Check for Updates…", click: opts.checkForUpdates } satisfies MenuItemConstructorOptions] : [])] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
