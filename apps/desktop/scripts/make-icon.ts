#!/usr/bin/env bun
/**
 * Placeholder app icon: 1024px rounded square with "db" → resources/icon.png + resources/icon.icns.
 * Uses only macOS built-ins (`sips`, `iconutil`) plus a hand-written PNG encoder (no deps).
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const out = resolve(import.meta.dir, "../resources");
mkdirSync(out, { recursive: true });
const N = 1024;
const px = new Uint8Array(N * N * 4);

// Glyph bitmaps (5x7) for "d" and "b".
const glyphs: Record<string, string[]> = {
  d: ["....#", "....#", ".####", "#...#", "#...#", "#...#", ".####"],
  b: ["#....", "#....", "####.", "#...#", "#...#", "#...#", "####."],
};
const cell = 62; // pixel size of one glyph cell
const textW = (5 * 2 + 1) * cell;
const textH = 7 * cell;
const x0 = Math.floor((N - textW) / 2);
const y0 = Math.floor((N - textH) / 2) + 10;
const glyphOn = (x: number, y: number) => {
  if (x < x0 || y < y0 || x >= x0 + textW || y >= y0 + textH) return false;
  const col = Math.floor((x - x0) / cell), row = Math.floor((y - y0) / cell);
  const which = col < 5 ? "d" : col > 5 ? "b" : null;
  if (!which) return false;
  return glyphs[which][row][col < 5 ? col : col - 6] === "#";
};

const radius = 230, margin = 100; // macOS icons keep a transparent margin
const inSquircle = (x: number, y: number) => {
  const l = margin, t = margin, r = N - margin, b = N - margin;
  if (x < l || x >= r || y < t || y >= b) return false;
  const cx = x < l + radius ? l + radius : x >= r - radius ? r - radius - 1 : x;
  const cy = y < t + radius ? t + radius : y >= b - radius ? b - radius - 1 : y;
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
};

for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const i = (y * N + x) * 4;
    if (!inSquircle(x, y)) continue;
    // vertical gradient: deep indigo → violet
    const tt = (y - margin) / (N - 2 * margin);
    let r = Math.round(40 + 30 * tt), g = Math.round(44 + 20 * tt), b = Math.round(120 + 80 * tt);
    if (glyphOn(x, y)) { r = 245; g = 245; b = 250; }
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  }
}

// Minimal PNG encoder (RGBA8, no filter).
const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf: Uint8Array) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Uint8Array) => {
  const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, data.length);
  const td = new Uint8Array(4 + data.length); td.set(new TextEncoder().encode(type)); td.set(data, 4);
  const crc = new Uint8Array(4); new DataView(crc.buffer).setUint32(0, crc32(td));
  return [len, td, crc];
};
const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer);
dv.setUint32(0, N); dv.setUint32(4, N); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const raw = new Uint8Array(N * (N * 4 + 1));
for (let y = 0; y < N; y++) { raw[y * (N * 4 + 1)] = 0; raw.set(px.subarray(y * N * 4, (y + 1) * N * 4), y * (N * 4 + 1) + 1); }
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  ...chunk("IHDR", ihdr), ...chunk("IDAT", new Uint8Array(deflateSync(raw))), ...chunk("IEND", new Uint8Array(0)),
].map((b) => Buffer.from(b)));
writeFileSync(resolve(out, "icon.png"), png);
console.log(`[icon] wrote ${resolve(out, "icon.png")}`);

if (process.platform === "darwin") {
  const iconset = resolve(out, "icon.iconset");
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset);
  for (const s of [16, 32, 128, 256, 512]) {
    for (const [suffix, size] of [["", s], ["@2x", s * 2]] as const) {
      Bun.spawnSync(["sips", "-z", String(size), String(size), resolve(out, "icon.png"), "--out", resolve(iconset, `icon_${s}x${s}${suffix}.png`)], { stdout: "ignore" });
    }
  }
  const r = Bun.spawnSync(["iconutil", "-c", "icns", iconset, "-o", resolve(out, "icon.icns")], { stderr: "inherit" });
  rmSync(iconset, { recursive: true, force: true });
  if (r.exitCode === 0) console.log(`[icon] wrote ${resolve(out, "icon.icns")}`);
  else console.warn("[icon] iconutil failed; electron-builder will use the default icon");
}
