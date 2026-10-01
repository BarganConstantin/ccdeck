// Every image the desktop app ships, copied unchanged from the ccdeck brand kit
// vendored under desktop/brand/kit. Nothing here draws the mark. Which kit file
// serves which slot, and why, is desktop/brand/README.md.
//
// The tray says what the tab's favicon says, and both take the kit's mark with
// the kit's status badge for the state, on the same map:
//
//   idle     default
//   waiting  waiting
//   running  syncing
//   offline  error
//
// The kit's fifth state, paused, has no product state behind it and is unused.
// The state is a badge on an unchanged mark, never a recolouring.
//
// Each platform gets the kit's own version of the tray:
//
//   macOS    the monochrome templates, 18 pt with the @2x, which the menu bar
//            tints for a light or a dark bar.
//   Windows  the state's .ico, which carries an entry for every display scale,
//            so Windows loads the one made for its DPI.
//   Linux    the state's colour PNGs at 24 with the 48 beside it: the size a
//            panel asks for, and its double for a HiDPI panel.
//
// The app icon is a separate set and never stands in for the tray.
//
// Pure node, and nothing is downloaded or built: the kit ships the .icns and
// the .ico ready made. electron-builder's icon toolset is a GitHub download
// that answered 504 on two CI runs in a row.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { retinaFile, trayIconFile } from "../tray-icon.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** Where the vendored kit files live: desktop/brand/kit/ holds them. */
export const BRAND = join(here, "..", "brand");

/**
 * The one kit version everything under desktop/brand/kit is a copy of, file
 * for file at the same relative path. scripts/vendor-brand-kit.mjs refuses a
 * kit whose VERSION is not this, so taking a new kit starts by changing it.
 */
export const KIT_VERSION = "1.1.0";

/** Each product state's kit state, the map the tab's favicon follows too. */
export const TRAY_ART = Object.freeze({
  idle: "default",
  waiting: "waiting",
  running: "syncing",
  offline: "error",
});
export const STATES = Object.keys(TRAY_ART);

/** The kit's names for its macOS templates. */
export const MACOS_TEMPLATE_STEMS = Object.freeze({
  default: "ccdeckTemplate",
  waiting: "ccdeckWaitingTemplate",
  syncing: "ccdeckSyncingTemplate",
  error: "ccdeckErrorTemplate",
});

/** The menu-bar template's pixel size, 1x and Retina: the kit's 18 pt. */
export const MACOS_TEMPLATE_SIZES = Object.freeze({ "": 18, "@2x": 36 });

/** The Windows tray at 100, 125, 150, 200, 250, 300 and 400 % — every entry a
 *  state's .ico has to carry so no scale is a resized neighbour. */
export const WINDOWS_TRAY_SIZES = Object.freeze([16, 20, 24, 32, 40, 48, 64]);

/** The Linux tray pair: what a panel asks for, and its double. */
export const LINUX_TRAY_SIZES = Object.freeze({ "": 24, "@2x": 48 });

/**
 * The sizes the Linux app icon is installed at.
 *
 * Every one of them is declared by the hicolor theme, and that is the whole
 * point. Left to make the set itself from icon.png, electron-builder wrote a
 * single file — hicolor/1024x1024 — and hicolor's index.theme stops at 512, so
 * GTK never looked in that directory: the app had no icon anywhere on Linux,
 * in the dock, the switcher or the menu, while macOS and Windows were fine
 * because each takes ONE file that carries every size inside it (.icns, .ico).
 * A png in an undeclared directory is not a small icon, it is no icon.
 */
export const LINUX_ICON_SIZES = Object.freeze([16, 22, 24, 32, 48, 64, 128, 256, 512]);

/** What is written into dist/icons, and the file under desktop/brand each is a copy of. */
export function iconPlan() {
  const plan = [
    { out: "icon.png", from: "kit/03-app-icons/png/ccdeck-app-1024.png" },
    { out: "icon.icns", from: "kit/03-app-icons/macos/ccdeck.icns" },
    { out: "icon.ico", from: "kit/03-app-icons/windows/ccdeck.ico" },
  ];
  // Named the way electron-builder reads an icon directory: the size is in the
  // filename, and it installs each one under the hicolor size that matches.
  for (const size of LINUX_ICON_SIZES) {
    plan.push({ out: `linux/${size}x${size}.png`, from: `kit/03-app-icons/linux/ccdeck-${size}.png` });
  }
  for (const state of STATES) {
    const art = TRAY_ART[state];
    const template = trayIconFile("darwin", state);
    plan.push({ out: template, from: `kit/04-tray-menu/macos/${MACOS_TEMPLATE_STEMS[art]}.png` });
    plan.push({ out: retinaFile(template), from: `kit/04-tray-menu/macos/${MACOS_TEMPLATE_STEMS[art]}@2x.png` });
    plan.push({ out: trayIconFile("win32", state), from: `kit/04-tray-menu/windows/ccdeck-tray-${art}.ico` });
    const linux = trayIconFile("linux", state);
    plan.push({ out: linux, from: `kit/04-tray-menu/linux/ccdeck-tray-${art}-${LINUX_TRAY_SIZES[""]}.png` });
    plan.push({ out: retinaFile(linux), from: `kit/04-tray-menu/linux/ccdeck-tray-${art}-${LINUX_TRAY_SIZES["@2x"]}.png` });
  }
  return plan;
}

/** A PNG file's pixel size, read off its IHDR chunk. */
export function pngSize(png) {
  if (png.subarray(1, 4).toString("latin1") !== "PNG" || png.subarray(12, 16).toString("latin1") !== "IHDR") {
    throw new Error("not a PNG file");
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Write every image into `outDir`, which is emptied first so it holds the plan
 *  and nothing an older build left there. */
export function writeIcons(outDir, { brand = BRAND } = {}) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "linux"), { recursive: true });
  for (const { out, from } of iconPlan()) writeFileSync(join(outDir, out), readFileSync(join(brand, from)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = join(here, "..", "dist", "icons");
  writeIcons(out);
  console.log(`icons written to ${out}`);
}
