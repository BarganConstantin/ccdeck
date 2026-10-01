// The desktop app's images: the app icon and the tray, on macOS, Windows and
// Linux, all taken from the ccdeck brand kit vendored under desktop/brand.
// Nothing in the build draws the mark any more.
//
// This file replaces "the icons" in desktop-updater.test.ts, which pinned the
// shapes desktop/scripts/icons.mjs used to draw (a grey ring, a ring and a
// dot, an amber disc, a ring with a quarter gone) and that its PNG writer made
// a PNG. Those guarantees were dropped on purpose, with the drawing: the
// product now wears the kit's mark, and what can silently go wrong is
// different. What is pinned is the slot, the name, the size and the template
// rules — never what the artwork looks like, so a new kit passes or fails on
// the same terms. Each case holds one of these:
//
//   · a state shown with the wrong kit image, or the kit's unused "paused"
//     given a meaning nobody chose;
//   · a file quietly re-encoded, edited or swapped, so the vendored copy is no
//     longer the one the README lists — or a binary added under desktop/brand
//     that nobody accounted for;
//   · a macOS template that is not a whole template: kit v1.0's own draw the
//     mark cut off, in a 2×2 pixel corner of the 18 px default;
//   · the app icon shrunk into the tray, which the brand rules forbid;
//   · a drawing creeping back into code.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { rmTempDir } from "./rm-temp-dir";
import { ambientSignal } from "../ambient";
// @ts-expect-error — plain .mjs, no types
import * as icons from "../../../desktop/scripts/icons.mjs";
// @ts-expect-error — plain .mjs, no types
import { withWholeMaskRegion } from "../../../desktop/scripts/render-tray-templates.mjs";
// @ts-expect-error — plain .mjs, no types
import { fileTable, neededKitFiles } from "../../../desktop/scripts/vendor-brand-kit.mjs";
// @ts-expect-error — plain .mjs, no types
import { retinaFile, trayIconFile } from "../../../desktop/tray-icon.mjs";

const { BRAND, TRAY_ART, STATES, MACOS_TEMPLATE_STEMS, MACOS_TEMPLATE_SIZES, MACOS_TEMPLATES_FROM, WINDOWS_TRAY_SIZES, LINUX_TRAY_SIZES, iconPlan, writeIcons } = icons;

type PlanEntry = { out: string; from: string[]; pack?: "ico" | "icns" };

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const desktop = (...parts: string[]) => readFileSync(join(repo, "desktop", ...parts), "utf8");
const brandFile = (path: string) => readFileSync(join(BRAND, path));
const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

/** Every file under a directory, as paths relative to it. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter(path => statSync(join(dir, path)).isFile())
    .map(path => path.split("\\").join("/"))
    .sort();
}

/** The .ico's entries: each one's declared size and its PNG bytes. */
function icoEntries(ico: Buffer): { size: number; png: Buffer }[] {
  expect(ico.readUInt16LE(0), "an .ico starts with a reserved zero").toBe(0);
  expect(ico.readUInt16LE(2), "type 1 is an icon").toBe(1);
  return Array.from({ length: ico.readUInt16LE(4) }, (_, i) => {
    const e = ico.subarray(6 + 16 * i, 22 + 16 * i);
    const png = ico.subarray(e.readUInt32LE(12), e.readUInt32LE(12) + e.readUInt32LE(8));
    return { size: e[0] || 256, png: Buffer.from(png) };
  });
}

/** An 8-bit RGBA, non-interlaced PNG — what resvg writes — as its pixels. */
function rgba(png: Buffer): { size: number; px: Buffer } {
  expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
  let at = 8, width = 0, height = 0;
  const idat: Buffer[] = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at), type = png.subarray(at + 4, at + 8).toString("latin1");
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect([data[8], data[9], data[12]], "a template is 8-bit RGBA, not interlaced").toEqual([8, 6, 0]);
    }
    if (type === "IDAT") idat.push(data);
    at += 12 + length;
  }
  expect(width, "not square").toBe(height);
  const raw = inflateSync(Buffer.concat(idat)), stride = width * 4;
  const px = Buffer.alloc(width * height * 4), prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? px[y * stride + i - 4] : 0, b = prev[i], c = i >= 4 ? prev[i - 4] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predicted = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      px[y * stride + i] = (row[i] + predicted) & 255;
    }
    px.copy(prev, 0, y * stride, (y + 1) * stride);
  }
  return { size: width, px };
}

/** Write the build's dist/icons into a temp directory, hand it over, delete it. */
function written<T>(read: (dir: string) => T, platform = "linux"): T {
  const dir = mkdtempSync(join(tmpdir(), "ccdeck-icons-"));
  try {
    writeIcons(dir, { platform });
    return read(dir);
  } finally {
    rmTempDir(dir);
  }
}

/** The README's file table: `path` | `sha256`, for every file under desktop/brand. */
function readmeHashes(): Map<string, string> {
  const rows = [...desktop("brand", "README.md").matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \|/gm)];
  return new Map(rows.map(m => [m[1], m[2]]));
}

describe("which kit image each tray state wears", () => {
  it("gives every state the product has a kit state, on the owner's map, and leaves paused unused", () => {
    // The product's states are what the page's own reducer can say, read off
    // it rather than restated: the tray model calls this same function.
    const said = new Set<string>();
    for (const connected of [true, false]) {
      for (const waiting of [0, 1]) {
        for (const running of [0, 1]) said.add(ambientSignal({ waiting, running, connected }).icon);
      }
    }
    expect([...said].sort(), "a state the page can show has no kit image, or the map names one it cannot").toEqual([...STATES].sort());
    expect(TRAY_ART).toEqual({ idle: "default", waiting: "waiting", running: "syncing", offline: "error" });
    expect(Object.values(TRAY_ART), "paused has no product state behind it; giving it one is a product decision").not.toContain("paused");
  });

  it("is named by one function the app and the build both read", () => {
    expect(desktop("main.mjs")).toContain('import { trayIconFile } from "./tray-icon.mjs";');
    expect(desktop("main.mjs")).toMatch(/nativeImage\.createFromPath\(join\(icons, trayIconFile\(process\.platform, icon\)\)\)/);
    expect(desktop("electron-builder.config.cjs"), "main.mjs imports it, so the packed app needs it").toContain('"tray-icon.mjs"');
    expect(trayIconFile("darwin", "idle")).toBe("tray-idleTemplate.png");
    expect(retinaFile(trayIconFile("darwin", "idle"))).toBe("tray-idleTemplate@2x.png");
    expect(trayIconFile("win32", "idle")).toBe("tray-idle.ico");
    expect(trayIconFile("linux", "idle")).toBe("tray-idle.png");
  });

  it("writes, for each state on each platform, the kit file that state maps to", () => {
    const kitIco = brandFile("kit/04-tray-menu/windows/ccdeck-tray.ico");
    written(dir => {
      const out = (name: string) => readFileSync(join(dir, name));
      for (const state of STATES) {
        const art = TRAY_ART[state];
        // macOS: the template of that kit state, 1x and Retina, by the kit's
        // name for it — rendered or the kit's own, whichever the plan reads.
        const where = MACOS_TEMPLATES_FROM === "kit" ? "kit/04-tray-menu/macos" : "rendered/macos";
        const template = trayIconFile("darwin", state);
        expect(sha256(out(template)), `${template}`).toBe(sha256(brandFile(`${where}/${MACOS_TEMPLATE_STEMS[art]}.png`)));
        expect(sha256(out(retinaFile(template))), `${retinaFile(template)}`).toBe(sha256(brandFile(`${where}/${MACOS_TEMPLATE_STEMS[art]}@2x.png`)));
        // Linux: the kit's colour PNGs at the pair the app hands the panel.
        const linux = trayIconFile("linux", state);
        expect(sha256(out(linux)), linux).toBe(sha256(brandFile(`kit/04-tray-menu/linux/ccdeck-tray-${art}-${LINUX_TRAY_SIZES[""]}.png`)));
        expect(sha256(out(retinaFile(linux))), retinaFile(linux)).toBe(sha256(brandFile(`kit/04-tray-menu/linux/ccdeck-tray-${art}-${LINUX_TRAY_SIZES["@2x"]}.png`)));
        // Windows: the kit's own .ico for default; for the rest, that state's
        // kit PNGs, unchanged, as the entries of an .ico laid out like it.
        const ico = out(trayIconFile("win32", state));
        if (art === "default") {
          expect(sha256(ico), "idle is the kit's ccdeck-tray.ico itself").toBe(sha256(kitIco));
        } else {
          const entries = icoEntries(ico);
          expect(entries.map(e => e.size)).toEqual([...WINDOWS_TRAY_SIZES]);
          entries.forEach(({ size, png }) => expect(sha256(png), `${state} ${size}`).toBe(sha256(brandFile(`kit/04-tray-menu/windows/ccdeck-tray-${art}-${size}.png`))));
        }
      }
    });
  });

  it("packs every Windows state at the sizes the kit's own tray .ico carries", () => {
    // So no state is blurrier than idle at some DPI: Windows loads the entry
    // made for its small-icon size, and every state has the same entries.
    expect(icoEntries(brandFile("kit/04-tray-menu/windows/ccdeck-tray.ico")).map(e => e.size)).toEqual([...WINDOWS_TRAY_SIZES]);
  });
});

describe("the app icon, which is a separate set", () => {
  it("is the kit's launcher set on every platform", () => {
    written(dir => {
      const out = (name: string) => sha256(readFileSync(join(dir, name)));
      expect(out("icon.png"), "the 1024 master").toBe(sha256(brandFile("kit/03-app-icons/png/ccdeck-app-1024.png")));
      expect(out("icon.ico"), "the Windows launcher icon").toBe(sha256(brandFile("kit/03-app-icons/windows/ccdeck.ico")));
      for (const size of icons.LINUX_ICON_SIZES as number[]) {
        const from = size === 24 ? "kit/03-app-icons/png/ccdeck-app-24.png" : `kit/03-app-icons/linux/ccdeck-${size}.png`;
        expect(out(`linux/${size}x${size}.png`), `linux ${size}`).toBe(sha256(brandFile(from)));
      }
    });
  });

  it("carries the 256 entry electron-builder requires of a Windows icon", () => {
    expect(icoEntries(brandFile("kit/03-app-icons/windows/ccdeck.ico")).map(e => e.size)).toContain(256);
  });

  it("makes the .icns from the kit's iconset as it is, every 1x and @2x pair in it", () => {
    // iconutil, which only a Mac has, packs the directory it is handed; what
    // can go wrong on this side is handing it less than the whole iconset.
    const icns = (iconPlan() as PlanEntry[]).find(e => e.out === "icon.icns")!;
    expect(icns).toMatchObject({ from: ["kit/03-app-icons/macos.iconset"], pack: "icns" });
    const pairs = [16, 32, 128, 256, 512].flatMap(n => [`icon_${n}x${n}.png`, `icon_${n}x${n}@2x.png`]).sort();
    expect(filesUnder(join(BRAND, icns.from[0]))).toEqual(pairs);
  });

  it("is never what the tray shows", () => {
    // The rule is the brand's: the app icon has a launcher surface, the tray
    // has its own glyphs. Held twice — by where each tray file comes from, and
    // by its bytes, so a copy of an app icon under a tray name fails too.
    const tray = (iconPlan() as PlanEntry[]).filter(entry => entry.out.startsWith("tray-"));
    expect(tray.length).toBe(STATES.length * 5);
    for (const { out, from } of tray) {
      for (const path of from) expect(path, `${out} is made from an app icon`).not.toMatch(/03-app-icons/);
    }
    const appIcons = new Set(filesUnder(join(BRAND, "kit/03-app-icons")).map(path => sha256(brandFile(`kit/03-app-icons/${path}`))));
    written(dir => {
      for (const name of readdirSync(dir).filter(name => name.startsWith("tray-"))) {
        expect(appIcons.has(sha256(readFileSync(join(dir, name)))), `${name} is an app icon`).toBe(false);
      }
    });
  });
});

describe("what the build does with the kit", () => {
  it("copies and packs the vendored files, and draws nothing", () => {
    const source = desktop("scripts", "icons.mjs");
    // What used to draw: the coverage sampler, the shapes and the PNG encoder.
    for (const gone of ["inked", "markPng", "appIconPng", "png", "COLOURS"]) {
      expect(Object.keys(icons), `icons.mjs exports ${gone} again`).not.toContain(gone);
    }
    expect(source, "a PNG encoder in the icon build is a drawing").not.toMatch(/deflateSync|node:zlib/);
    expect(source, "geometry in the icon build is a drawing").not.toMatch(/Math\.(hypot|atan2|sin|cos)\b/);
    // And the app makes no image of its own at run time either.
    expect(desktop("main.mjs")).not.toMatch(/nativeImage\.create(FromBuffer|FromBitmap|FromDataURL|Empty)/);
    for (const { from } of iconPlan() as PlanEntry[]) {
      for (const path of from) expect(path, `${path} is not a vendored or rendered brand file`).toMatch(/^(kit|rendered)\//);
    }
  });

  it("writes exactly the plan into dist/icons, and nothing an older build left", () => {
    const planned = (iconPlan() as PlanEntry[]).map(e => e.out).filter(out => out !== "icon.icns").sort();
    written(dir => expect(filesUnder(dir)).toEqual(planned));
  });

  it("refuses to pack an .ico entry Windows would misread", () => {
    expect(() => icons.packIco([brandFile("kit/03-app-icons/png/ccdeck-app-1024.png")])).toThrow(/at most 256/);
    expect(() => icons.packIco([Buffer.from("not a png")])).toThrow(/not a PNG/);
  });
});

describe("the vendored files", () => {
  const files = filesUnder(BRAND).filter(path => path !== "README.md");

  it("are each listed in desktop/brand/README.md with the SHA-256 they really have", () => {
    // The README's table is the provenance — every kit/ file is the kit's file
    // at the same relative path, unchanged — and it is only a claim until this
    // checks it. A file re-saved by an image editor, or one added without a
    // row, fails here.
    const listed = readmeHashes();
    expect([...listed.keys()].sort(), "the README's table and the files under desktop/brand differ").toEqual(files);
    for (const path of files) expect(sha256(brandFile(path)), path).toBe(listed.get(path));
  });

  it("are what vendor-brand-kit.mjs would copy and list, so the next kit is one command", () => {
    // Nothing vendored that the plan does not read, nothing it reads missing,
    // and the README's table exactly the one the script writes.
    expect(neededKitFiles(join(BRAND, "kit"))).toEqual(filesUnder(join(BRAND, "kit")));
    expect(desktop("brand", "README.md")).toContain(`<!-- files:start -->\n${fileTable()}\n<!-- files:end -->`);
    expect(desktop("scripts", "icons.mjs")).toMatch(/^export const KIT_VERSION = "\d+\.\d+\.\d+";$/m);
  });

  it("are each the size their name says", () => {
    // The kit names its rasters by size; a file whose pixels disagree with its
    // name is installed or picked at the wrong size.
    for (const path of files.filter(p => p.endsWith(".png"))) {
      const iconset = /icon_(\d+)x\1(@2x)?\.png$/.exec(path);
      const sized = /-(\d+)\.png$/.exec(path);
      const template = /Template(@2x)?\.png$/.exec(path);
      const want = iconset ? Number(iconset[1]) * (iconset[2] ? 2 : 1)
        : sized ? Number(sized[1])
        : template ? MACOS_TEMPLATE_SIZES[template[1] ?? ""]
        : NaN;
      expect(icons.pngSize(brandFile(path)), path).toEqual({ width: want, height: want });
    }
  });
});

describe("the macOS menu-bar templates", () => {
  // Where the plan takes each template from: rendered from the kit's masters
  // while kit v1.0's own are cut off, the kit's own once MACOS_TEMPLATES_FROM
  // says "kit" — and then these same checks say whether they are whole.
  const templateSource = (art: string, suffix: string): string => {
    const state = STATES.find((s: string) => TRAY_ART[s] === art);
    const out = suffix ? retinaFile(trayIconFile("darwin", state)) : trayIconFile("darwin", state);
    return (iconPlan() as PlanEntry[]).find(entry => entry.out === out)!.from[0];
  };
  const stems = MACOS_TEMPLATE_STEMS as Record<string, string>;
  const sizes = MACOS_TEMPLATE_SIZES as Record<string, number>;

  it("are the four the app uses, under the kit's names, and no others", () => {
    const where = MACOS_TEMPLATES_FROM === "kit" ? "kit/04-tray-menu/macos" : "rendered/macos";
    const expected = Object.values(stems).flatMap(stem => Object.keys(sizes).map(suffix => `${where}/${stem}${suffix}.png`)).sort();
    expect(Object.keys(stems).flatMap(art => Object.keys(sizes).map(suffix => templateSource(art, suffix))).sort()).toEqual(expected);
    // Electron marks an image as a template by this name, and only by it.
    for (const path of expected) expect(path).toMatch(/Template(@2x)?\.png$/);
  });

  /** A template's pixels, and the facts the cases below read off them. */
  function measure(art: string, suffix: string) {
    const size = sizes[suffix];
    const { size: actual, px } = rgba(brandFile(templateSource(art, suffix)));
    expect(actual).toBe(size);
    const alpha = (x: number, y: number) => px[(y * size + x) * 4 + 3];
    let x0 = size, y0 = size, x1 = -1, y1 = -1, ink = 0, coloured = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const o = (y * size + x) * 4;
        if (!px[o + 3]) continue;
        ink += px[o + 3] / 255;
        if (px[o] || px[o + 1] || px[o + 2]) coloured++;
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    }
    return { size, px, alpha, x0, y0, x1, y1, ink: ink / (size * size), coloured };
  }

  // These hold for any artwork: they are about the template being whole and
  // being a template, not about what the mark looks like.
  for (const [art, stem] of Object.entries(stems)) {
    for (const [suffix, size] of Object.entries(sizes)) {
      it(`${stem}${suffix}.png is a whole mark, black on transparent, at ${size} px`, () => {
        const m = measure(art, suffix);
        // Whole means spread over the square and centred in it. Kit v1.0's own
        // default template draws in a 2×2 pixel corner of its 18: ink across
        // 2 of 18 pixels, 0.6 % of the square inked, 2 pixels of margin on the
        // top and left against 14 on the bottom and right.
        expect(m.x1 - m.x0 + 1, "the mark spans too little of the width: cut off").toBeGreaterThanOrEqual(size * 0.8);
        expect(m.y1 - m.y0 + 1, "the mark spans too little of the height: cut off").toBeGreaterThanOrEqual(size * 0.8);
        expect(Math.abs(m.y0 - (size - 1 - m.y1)), "the mark is not centred top to bottom: cut off").toBeLessThanOrEqual(size / 18);
        expect(m.ink, "almost nothing is inked: a fragment of the mark").toBeGreaterThan(0.2);
        // macOS reads only the alpha of a template; a colour in it is the
        // gradient or a status colour leaking in.
        expect(m.coloured, "a template is black and alpha, nothing else").toBe(0);
      });
    }
  }

  for (const [suffix, size] of Object.entries(sizes)) {
    it(`every state at ${size} px is the default mark with an overlay, never a recolouring`, () => {
      // The kit's status overlays sit top right. Outside that quarter each
      // state is the default, pixel for pixel; inside it, something is added.
      const base = measure("default", suffix);
      const overlayQuarter = (x: number, y: number) => x >= size / 2 && y < size / 2;
      for (const art of Object.keys(stems).filter(a => a !== "default")) {
        const m = measure(art, suffix);
        let outside = 0, inside = 0;
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            if (m.px.readUInt32BE((y * size + x) * 4) === base.px.readUInt32BE((y * size + x) * 4)) continue;
            if (overlayQuarter(x, y)) inside++;
            else outside++;
          }
        }
        expect(outside, `${art} changes the mark outside the overlay's quarter`).toBe(0);
        expect(inside, `${art} adds nothing to the default`).toBeGreaterThan(0);
      }
    });
  }
});

// KIT v1.0 WORKAROUND. Kit v1.0's own templates are cut off, so the plan reads
// templates rendered from its masters by scripts/render-tray-templates.mjs.
// This block checks that render and nothing else; it goes, with that script and
// desktop/brand/rendered, on the day MACOS_TEMPLATES_FROM in icons.mjs becomes
// "kit". Left in place after that switch it fails loudly, because the files it
// reads are gone — which is the reminder.
describe("the kit v1.0 workaround: templates rendered from the masters", () => {
  const stems = MACOS_TEMPLATE_STEMS as Record<string, string>;
  const sizes = MACOS_TEMPLATE_SIZES as Record<string, number>;

  it("renders one template per state and size, and nothing else", () => {
    const expected = Object.values(stems).flatMap(stem => Object.keys(sizes).map(suffix => `${stem}${suffix}.png`)).sort();
    expect(filesUnder(join(BRAND, "rendered/macos")), "a template rendered for no state, or a state not rendered").toEqual(expected);
  });

  // The masters' mask region stops at 8 units where the outer curves reach
  // 5.9, so a render of a master as delivered shaves the four apexes flat: at
  // 18 px the apex pixel is left at 111 of 255, where the whole curve inks it
  // to about 220, and at 36 px the margin row is empty.
  for (const [suffix, size] of Object.entries(sizes)) {
    it(`the rendered default at ${size} px is not shaved by the masters' mask`, () => {
      const { px } = rgba(brandFile(`rendered/macos/${stems.default}${suffix}.png`));
      const alpha = (x: number, y: number) => px[(y * size + x) * 4 + 3];
      const margin = size / 18, last = size - margin - 1, line = [...Array(size).keys()];
      const apex = {
        top: Math.max(...line.map(x => alpha(x, margin))),
        left: Math.max(...line.map(y => alpha(margin, y))),
        bottom: Math.max(...line.map(x => alpha(x, last))),
        right: Math.max(...line.map(y => alpha(last, y))),
      };
      for (const [side, value] of Object.entries(apex)) expect(value, `the ${side} curve is shaved`).toBeGreaterThanOrEqual(160);
    });
  }

  it("renders a working copy that differs from the master only by the mask region", () => {
    const ADDED = ' maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100"';
    for (const art of Object.keys(stems)) {
      const master = brandFile(`kit/04-tray-menu/generic/svg/ccdeck-tray-${art}.svg`).toString("utf8");
      const copy: string = withWholeMaskRegion(master);
      expect(copy).toContain(`<mask id="cut"${ADDED}>`);
      expect(copy.replace(ADDED, ""), "the working copy differs from the master by more than the mask region").toBe(master);
    }
    // A master shaped differently — a re-exported kit that fixed the mask, or
    // changed it — is refused rather than rendered unseen.
    expect(() => withWholeMaskRegion('<svg viewBox="0 0 100 100"></svg>')).toThrow(/exactly one/);
    expect(() => withWholeMaskRegion('<svg viewBox="0 0 100 100"><mask id="cut"><mask id="cut"></svg>')).toThrow(/exactly one/);
  });
});
