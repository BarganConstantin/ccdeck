// Every image the desktop app needs, drawn from the favicon's own geometry
// (src/web/ambient.ts `mark`) and written as PNG — so the app's icon, its tray
// states and the tab's favicon are one drawing, and no binary is tracked in git
// (tracked-binaries.test.ts allows exactly two).
//
//   idle     ring                          grey
//   running  ring and a centre dot         blue
//   waiting  a full disc                   amber
//   offline  the ring with a quarter gone  red
//
// On a 32-unit canvas: ring radius 12, stroke 5; dot radius 5; disc radius
// 14.5; the offline gap spans 212°–302° measured clockwise from 3 o'clock (the
// favicon's dash pattern rotated by -58°), which is the upper right.
//
// macOS gets TEMPLATE images: black on transparent, which the menu bar tints
// for a light or dark bar. The shape alone carries the state there, which is
// why the four shapes differ and not only their colours. Windows and Linux get
// the coloured ones.
//
// Pure node — zlib and a hand-rolled PNG writer — so the build needs nothing
// installed to draw them.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

export const COLOURS = {
  idle: [0x7e, 0x82, 0x8c],
  running: [0x2a, 0x90, 0xd4],
  waiting: [0xc9, 0x7d, 0x12],
  offline: [0xe0, 0x52, 0x52],
};
export const STATES = Object.keys(COLOURS);

/** Is this point of the 32-unit canvas inked, for this state? */
export function inked(state, x, y) {
  const dx = x - 16, dy = y - 16;
  const r = Math.hypot(dx, dy);
  if (state === "waiting") return r <= 14.5;
  const onRing = r >= 9.5 && r <= 14.5;
  if (state === "offline") {
    const deg = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    return onRing && !(deg >= 212 && deg <= 302);
  }
  if (state === "running") return onRing || r <= 5;
  return onRing;
}

/** Coverage of one output pixel, 0..1, from an n×n grid of samples. */
function coverage(state, px, py, size, n = 5) {
  let hit = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = ((px + (i + 0.5) / n) / size) * 32;
      const y = ((py + (j + 0.5) / n) / size) * 32;
      if (inked(state, x, y)) hit++;
    }
  }
  return hit / (n * n);
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGBA pixels (size×size×4) as a PNG file. */
export function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** One state's mark, in `rgb`, on transparent. */
export function markPng(state, size, rgb) {
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = coverage(state, x, y, size);
      const o = (y * size + x) * 4;
      px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2];
      px[o + 3] = Math.round(a * 255);
    }
  }
  return png(size, px);
}

/** The app icon: the running-blue ring on a dark rounded tile, inset the way
 *  Apple's icon grid insets a tile from its canvas. */
export function appIconPng(size = 1024) {
  const px = Buffer.alloc(size * size * 4);
  const inset = size * 0.1, tile = size - 2 * inset, radius = tile * 0.225;
  const bg = [0x1f, 0x1f, 0x1f];
  const n = 3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let tileHit = 0, ringHit = 0;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const sx = x + (i + 0.5) / n, sy = y + (j + 0.5) / n;
          // Inside the rounded tile?
          const cx = Math.min(Math.max(sx, inset + radius), size - inset - radius);
          const cy = Math.min(Math.max(sy, inset + radius), size - inset - radius);
          if (Math.hypot(sx - cx, sy - cy) <= radius) {
            tileHit++;
            // The ring occupies the tile's middle 60%.
            const u = ((sx - inset - tile * 0.2) / (tile * 0.6)) * 32;
            const v = ((sy - inset - tile * 0.2) / (tile * 0.6)) * 32;
            if (inked("idle", u, v)) ringHit++;
          }
        }
      }
      const a = tileHit / (n * n), t = tileHit ? ringHit / tileHit : 0;
      const o = (y * size + x) * 4;
      for (let k = 0; k < 3; k++) px[o + k] = Math.round(bg[k] * (1 - t) + COLOURS.running[k] * t);
      px[o + 3] = Math.round(a * 255);
    }
  }
  return png(size, px);
}

/**
 * The macOS .icns, made with Apple's own sips and iconutil — so the build does
 * not fetch electron-builder's icon toolset, a download GitHub answered with a
 * 504 on two CI runs in a row. macOS only; elsewhere electron-builder makes the
 * .ico and the Linux set from icon.png itself.
 */
export function writeIcns(outDir) {
  const set = join(outDir, "icon.iconset");
  rmSync(set, { recursive: true, force: true });
  mkdirSync(set, { recursive: true });
  const src = join(outDir, "icon.png");
  for (const size of [16, 32, 128, 256, 512]) {
    execFileSync("sips", ["-z", String(size), String(size), src, "--out", join(set, `icon_${size}x${size}.png`)], { stdio: "ignore" });
    execFileSync("sips", ["-z", String(size * 2), String(size * 2), src, "--out", join(set, `icon_${size}x${size}@2x.png`)], { stdio: "ignore" });
  }
  execFileSync("iconutil", ["-c", "icns", set, "-o", join(outDir, "icon.icns")]);
  rmSync(set, { recursive: true, force: true });
}

/**
 * The Windows .ico: a directory of PNG images, which Windows has read since
 * Vista. Written here for the reason the .icns is made with iconutil — so the
 * build fetches no icon toolset from GitHub, whose release downloads answered
 * 504 on the CI runners more than once.
 */
export function icoFile(sizes = [16, 24, 32, 48, 64, 128, 256]) {
  const images = sizes.map(size => ({ size, png: appIconPng(size) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // 0 means 256
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);  // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map(i => i.png)]);
}

/** Write every image into `outDir`. */
export function writeIcons(outDir) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "icon.png"), appIconPng(1024));
  writeFileSync(join(outDir, "icon.ico"), icoFile());
  if (process.platform === "darwin") writeIcns(outDir);
  for (const state of STATES) {
    // macOS menu bar: 16pt, with the @2x the Retina bar asks for. The
    // "Template" suffix is what makes Electron mark the image as a template.
    writeFileSync(join(outDir, `tray-${state}Template.png`), markPng(state, 16, [0, 0, 0]));
    writeFileSync(join(outDir, `tray-${state}Template@2x.png`), markPng(state, 32, [0, 0, 0]));
    // Windows and Linux: coloured, at the sizes their trays pick from.
    writeFileSync(join(outDir, `tray-${state}.png`), markPng(state, 32, COLOURS[state]));
    writeFileSync(join(outDir, `tray-${state}@2x.png`), markPng(state, 64, COLOURS[state]));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const out = join(here, "..", "dist", "icons");
  writeIcons(out);
  console.log(`icons written to ${out}`);
}
