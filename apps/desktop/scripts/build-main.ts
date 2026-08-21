#!/usr/bin/env bun
/** Bundles src/main.ts + src/preload.ts → dist/*.cjs (CommonJS, `electron` external). */
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
rmSync(resolve(root, "dist"), { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: [resolve(root, "src/main.ts"), resolve(root, "src/preload.ts")],
  outdir: resolve(root, "dist"),
  target: "node",
  format: "cjs",
  external: ["electron"],
  naming: "[name].cjs",
  sourcemap: "linked",
  define: { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production") },
});
if (!result.success) {
  for (const l of result.logs) console.error(l);
  process.exit(1);
}
console.log(`[desktop] built ${result.outputs.map((o) => o.path.replace(root + "/", "")).join(", ")}`);
