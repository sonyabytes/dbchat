#!/usr/bin/env bun
/**
 * Dev entry used under portless (see scripts/dev.ts). Portless hands us PORT and PORTLESS_URL
 * (https://[<branch>.]dbchat-api.localhost); the web app lives at the same host minus "-api",
 * so allow that origin for CORS / the /rpc WebSocket upgrade, then run the normal watch server.
 */
const apiUrl = process.env.PORTLESS_URL;
const origins = new Set((process.env.DBCHAT_ALLOWED_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173").split(",").map((s) => s.trim()).filter(Boolean));
if (apiUrl) {
  origins.add(apiUrl);
  origins.add(apiUrl.replace("dbchat-api.", "dbchat."));
}
const child = Bun.spawn(["bun", "--watch", "src/main.ts"], {
  stdio: ["inherit", "inherit", "inherit"],
  env: { ...process.env, DBCHAT_ALLOWED_ORIGINS: [...origins].join(",") },
});
process.on("SIGINT", () => child.kill());
process.on("SIGTERM", () => child.kill());
process.exit(await child.exited);
