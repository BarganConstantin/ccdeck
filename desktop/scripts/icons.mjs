// Every image the desktop app ships, taken from the ccdeck brand kit (v1.0.0)
// vendored under desktop/brand: copied unchanged, or packed unchanged into the
// container a platform asks for. Nothing here draws the mark. Which kit file
// serves which slot, and why, is desktop/brand/README.md.
//
// The tray says what the tab's favicon says, and both take the kit's mark with
// the kit's overlay for the state, on the same map:
//
//   idle     default   the mark alone
//   waiting  waiting   the mark and a dot, top right
//   running  syncing   the mark and a turning arrow, top right
//   offline  error     the mark and a ringed "!", top right
//
// The kit's fifth state, paused, has no product state behind it and is unused.
// The state is an overlay on an unchanged mark, never a recolouring.
//
// Each platform gets the kit's own version of the tray:
//
//   macOS    monochrome templates, which the menu bar tints for a light or a
//            dark bar. Kit v1.0's own templates are cut off, so for now these
//            are rendered from its masters (MACOS_TEMPLATES_FROM, below).
//   Windows  the kit's tray .ico for idle; for the other three, the kit's PNGs
//            of that state packed into an .ico at the sizes the kit's own .ico
//            carries, so Windows picks the entry made for its DPI.
//   Linux    the kit's colour PNGs, 32 and 64, the pair the app has always
//            handed the panel.
//
// The app icon is a separate set and never stands in for the tray.
//
// Pure node, and nothing is downloaded: the .icns is made by Apple's iconutil
// on a Mac, and the .ico is a directory of PNG files Windows has read since
// Vista. electron-builder's icon toolset is a GitHub download that answered
// 504 on two CI runs in a row.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { retinaFile, trayIconFile } from "../tray-icon.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** Where the vendored kit files (kit/) and the rendered templates (rendered/) live. */
export const BRAND = join(here, "..", "brand");

/**
 * The one kit version everything under desktop/brand/kit is a copy of, file
 * for file at the same relative path. scripts/vendor-brand-kit.mjs refuses a
 * kit whose VERSION is not this, so taking a new kit starts by changing it.
 */
export const KIT_VERSION = "1.0.0";

/**
 * Where the macOS menu-bar templates come from. "rendered": kit v1.0's own
 * templates draw the mark cut off, so they are rendered from its monochrome
 * masters by scripts/render-tray-templates.mjs — a workaround for that kit
 * version, nothing more. "kit": a kit whose 04-tray-menu/macos templates are
 * whole is copied like every other file. The build switches on this one line;
 * then vendor-brand-kit.mjs takes the kit's templates and drops rendered/, the
 * template checks in desktop-brand-icons.test.ts say whether they really are
 * whole, and the render script goes with that test file's "kit v1.0
 * workaround" block, which fails until it is deleted.
 */
export const MACOS_TEMPLATES_FROM = "rendered";

/** Each product state's kit state, the map the tab's favicon follows too. */
export const TRAY_ART = Object.freeze({
  idle: "default",
  waiting: "waiting",
  running: "syncing",
  offline: "error",
});
export const STATES = Object.keys(TRAY_ART);

/** The kit's names for its macOS templates, which the rendered ones keep. */
export const MACOS_TEMPLATE_STEMS = Object.freeze({
  default: "ccdeckTemplate",
  waiting: "ccdeckWaitingTemplate",
  syncing: "ccdeckSyncingTemplate",
  error: "ccdeckErrorTemplate",
});

/** The menu-bar template's pixel size, 1x and Retina: the kit's 18 pt. */
export const MACOS_TEMPLATE_SIZES = Object.freeze({ "": 18, "@2x": 36 });

/** The entries of the kit's ccdeck-tray.ico, which every state's .ico repeats. */
export const WINDOWS_TRAY_SIZES = Object.freeze([16, 20, 24, 32, 48, 64]);

/** The Linux tray pair: the 1x and the @2x Electron hands the panel. */
export const LINUX_TRAY_SIZES = Object.freeze({ "": 32, "@2x": 64 });

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
export const LINUX_ICON_SIZES = Object.freeze([16, 24, 32, 48, 64, 128, 256, 512]);

/** The kit's Linux launcher set has no 24; its own 24 px app export fills it,
 *  drawn for that size like the 16, 32 and 48 beside it. */
function linuxIconSource(size) {
  return size === 24 ? "kit/03-app-icons/png/ccdeck-app-24.png" : `kit/03-app-icons/linux/ccdeck-${size}.png`;
}

function macosTemplateSource(art, suffix) {
  const name = `${MACOS_TEMPLATE_STEMS[art]}${suffix}.png`;
  return MACOS_TEMPLATES_FROM === "kit" ? `kit/04-tray-menu/macos/${name}` : `rendered/macos/${name}`;
}

/** The kit masters a render of the templates reads; none when they are copied. */
export function macosTemplateMasters() {
  if (MACOS_TEMPLATES_FROM === "kit") return [];
  return Object.keys(MACOS_TEMPLATE_STEMS).map(art => `kit/04-tray-menu/generic/svg/ccdeck-tray-${art}.svg`);
}

function windowsTraySources(art) {
  if (art === "default") return ["kit/04-tray-menu/windows/ccdeck-tray.ico"];
  return WINDOWS_TRAY_SIZES.map(size => `kit/04-tray-menu/windows/ccdeck-tray-${art}-${size}.png`);
}

/**
 * What is written into dist/icons, and from which files under desktop/brand.
 * `pack` names a container made from the sources: "ico" packs PNGs into an
 * .ico, "icns" runs iconutil on an iconset (macOS only). Without it the one
 * source is copied as it is.
 */
export function iconPlan() {
  const plan = [
    { out: "icon.png", from: ["kit/03-app-icons/png/ccdeck-app-1024.png"] },
    { out: "icon.ico", from: ["kit/03-app-icons/windows/ccdeck.ico"] },
    { out: "icon.icns", from: ["kit/03-app-icons/macos.iconset"], pack: "icns" },
  ];
  // Named the way electron-builder reads an icon directory: the size is in the
  // filename, and it installs each one under the hicolor size that matches.
  for (const size of LINUX_ICON_SIZES) {
    plan.push({ out: `linux/${size}x${size}.png`, from: [linuxIconSource(size)] });
  }
  for (const state of STATES) {
    const art = TRAY_ART[state];
    const template = trayIconFile("darwin", state);
    plan.push({ out: template, from: [macosTemplateSource(art, "")] });
    plan.push({ out: retinaFile(template), from: [macosTemplateSource(art, "@2x")] });
    const sources = windowsTraySources(art);
    plan.push({ out: trayIconFile("win32", state), from: sources, ...(sources.length > 1 ? { pack: "ico" } : {}) });
    const linux = trayIconFile("linux", state);
    plan.push({ out: linux, from: [`kit/04-tray-menu/linux/ccdeck-tray-${art}-${LINUX_TRAY_SIZES[""]}.png`] });
    plan.push({ out: retinaFile(linux), from: [`kit/04-tray-menu/linux/ccdeck-tray-${art}-${LINUX_TRAY_SIZES["@2x"]}.png`] });
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

/** PNG files, unchanged, as the entries of one .ico. */
export function packIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const png of pngs) {
    const { width, height } = pngSize(png);
    if (width !== height || width > 256) throw new Error(`an .ico entry is square and at most 256, not ${width}x${height}`);
    const e = Buffer.alloc(16);
    e[0] = width >= 256 ? 0 : width; // 0 means 256
    e[1] = height >= 256 ? 0 : height;
    e.writeUInt16LE(1, 4);  // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs]);
}

/** The macOS .icns, from the kit's iconset as it is: every 1x and @2x entry. */
function writeIcns(iconset, out) {
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", out]);
}

/** Write every image into `outDir`, which is emptied first so it holds the plan
 *  and nothing an older build left there. */
export function writeIcons(outDir, { brand = BRAND, platform = process.platform } = {}) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "linux"), { recursive: true });
  for (const { out, from, pack } of iconPlan()) {
    const sources = from.map(path => join(brand, path));
    if (pack === "icns") {
      if (platform === "darwin") writeIcns(sources[0], join(outDir, out));
    } else if (pack === "ico") {
      writeFileSync(join(outDir, out), packIco(sources.map(path => readFileSync(path))));
    } else {
      writeFileSync(join(outDir, out), readFileSync(sources[0]));
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = join(here, "..", "dist", "icons");
  writeIcons(out);
  console.log(`icons written to ${out}`);
}
