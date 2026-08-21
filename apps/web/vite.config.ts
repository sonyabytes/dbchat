import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Under portless (scripts/dev.ts) PORTLESS_URL is https://[<branch>.]dbchat.localhost and the API server is the
 * same host with "dbchat" → "dbchat-api". Point the RPC client there and route HMR through the proxy (port 443).
 */
const publicUrl = process.env.PORTLESS_URL ? new URL(process.env.PORTLESS_URL) : undefined;
const rpcUrl = process.env.VITE_DBCHAT_RPC_URL ?? (publicUrl ? `${publicUrl.protocol === "https:" ? "wss" : "ws"}://${publicUrl.hostname.replace(/dbchat\.localhost$/, "dbchat-api.localhost")}${publicUrl.port ? `:${publicUrl.port}` : ""}/rpc` : undefined);
const port = Number(process.env.PORT) || 5173;

export default defineConfig({
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: false, routesDirectory: "./src/routes", generatedRouteTree: "./src/routeTree.gen.ts" }),
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  define: rpcUrl ? { "import.meta.env.VITE_DBCHAT_RPC_URL": JSON.stringify(rpcUrl) } : {},
  server: {
    port,
    strictPort: true,
    hmr: publicUrl ? { protocol: publicUrl.protocol === "https:" ? "wss" : "ws", host: publicUrl.hostname, clientPort: Number(publicUrl.port) || (publicUrl.protocol === "https:" ? 443 : 80) } : undefined,
  },
});
