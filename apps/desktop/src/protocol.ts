/**
 * `app://dbchat/...` serves the static web build. A custom scheme (instead of file://) gives the
 * renderer a stable, non-null Origin (`app://dbchat`) that the server's /rpc origin gate can allow.
 * Unknown paths fall back to index.html so TanStack Router deep links survive a reload.
 */
import { net, protocol } from "electron";
import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { pathToFileURL } from "node:url";

export const APP_SCHEME = "app";
export const APP_HOST = "dbchat";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/** Must run before app.whenReady(). */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  ]);
}

/** Run after app.whenReady(). */
export function serveWebDist(webDist: string): void {
  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return new Response("not found", { status: 404 });
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    let file = normalize(join(webDist, rel));
    if (!file.startsWith(webDist) || !existsSync(file) || statSync(file).isDirectory()) file = join(webDist, "index.html");
    return net.fetch(pathToFileURL(file).toString());
  });
}
