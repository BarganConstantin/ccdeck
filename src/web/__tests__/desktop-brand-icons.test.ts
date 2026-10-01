// The desktop app's images: the app icon and the tray, on macOS, Windows and
// Linux, all copied from the ccdeck brand kit vendored under desktop/brand.
// Nothing in the build draws the mark any more.
//
// This file replaces "the icons" in desktop-updater.test.ts, which pinned the
// shapes desktop/scripts/icons.mjs used to draw (a grey ring, a ring and a
// dot, an amber disc, a ring with a quarter gone) and that its PNG writer made
// a PNG. Those guarantees were dropped on purpose, with the drawing: the
// product now wears the kit's mark, and what can silently go wrong is
// different. What is pinned is the slot, the name, the size and the template
// rules — never what the artwork looks like, so the next kit passes or fails on
// the same terms. Each case holds one of these:
//
//   · a state shown with the wrong kit image, or the kit's unused "paused"
//     given a meaning nobody chose;
//   · a file quietly re-encoded, edited or swapped, so the vendored copy is no
//     longer the one the README lists — or a binary added under desktop/brand
//     that nobody accounted for;
//   · a macOS template that is not a whole template: kit v1.0's own drew the
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
import { fileTable, neededKitFiles } from "../../../desktop/scripts/vendor-brand-kit.mjs";
// @ts-expect-error — plain .mjs, no types
import { retinaFile, trayIconFile } from "../../../desktop/tray-icon.mjs";

const { BRAND, TRAY_ART, STATES, MACOS_TEMPLATE_STEMS, MACOS_TEMPLATE_SIZES, WINDOWS_TRAY_SIZES, LINUX_TRAY_SIZES, LINUX_ICON_SIZES, iconPlan, writeIcons } = icons;

type PlanEntry = { out: string; from: string };

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const desktop = (...parts: string[]) => readFileSync(join(repo, "desktop", ...parts), "utf8");
const brandFile = (path: string) => readFileSync(join(BRAND, path));
const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
const plan = () => iconPlan() as PlanEntry[];
const sourceOf = (out: string) => {
  const entry = plan().find(e => e.out === out);
  expect(entry, `nothing is written as ${out}`).toBeDefined();
  return entry!.from;
};

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

/** The four-letter element types an .icns carries, in file order. */
function icnsTypes(icns: Buffer): string[] {
  expect(icns.subarray(0, 4).toString("latin1"), "not an .icns").toBe("icns");
  expect(icns.readUInt32BE(4), "the .icns header's length is not the file's").toBe(icns.length);
  const types: string[] = [];
  for (let at = 8; at < icns.length; at += icns.readUInt32BE(at + 4)) types.push(icns.subarray(at, at + 4).toString("latin1"));
  return types;
}

/** An 8-bit RGBA, non-interlaced PNG — what the kit's templates are — as its pixels. */
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
function written<T>(read: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "ccdeck-icons-"));
  try {
    writeIcons(dir);
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

  it("copies, for each state on each platform, the kit file of that state", () => {
    for (const state of STATES) {
      const art = TRAY_ART[state];
      const template = trayIconFile("darwin", state), linux = trayIconFile("linux", state);
      expect(sourceOf(template)).toBe(`kit/04-tray-menu/macos/${MACOS_TEMPLATE_STEMS[art]}.png`);
      expect(sourceOf(retinaFile(template))).toBe(`kit/04-tray-menu/macos/${MACOS_TEMPLATE_STEMS[art]}@2x.png`);
      // The kit's per-state .ico by its own name — for default too, where the
      // kit also keeps v1.0's ccdeck-tray.ico as an alias of the same bytes.
      expect(sourceOf(trayIconFile("win32", state))).toBe(`kit/04-tray-menu/windows/ccdeck-tray-${art}.ico`);
      expect(sourceOf(linux)).toBe(`kit/04-tray-menu/linux/ccdeck-tray-${art}-${LINUX_TRAY_SIZES[""]}.png`);
      expect(sourceOf(retinaFile(linux))).toBe(`kit/04-tray-menu/linux/ccdeck-tray-${art}-${LINUX_TRAY_SIZES["@2x"]}.png`);
    }
    // And what is written is the file, byte for byte.
    written(dir => {
      for (const { out, from } of plan()) expect(sha256(readFileSync(join(dir, out))), out).toBe(sha256(brandFile(from)));
    });
  });

  it("gives every Windows state an entry for each display scale", () => {
    // Windows loads the .ico entry made for its small-icon size; a scale with
    // no entry of its own gets a neighbour resized, which is the blur this
    // shape exists to avoid.
    for (const state of STATES) {
      const from = sourceOf(trayIconFile("win32", state));
      expect(icoEntries(brandFile(from)).map(e => e.size), from).toEqual([...WINDOWS_TRAY_SIZES]);
    }
  });

  it("hands the Linux panel the size it asks for, with its double", () => {
    for (const state of STATES) {
      for (const [suffix, size] of Object.entries(LINUX_TRAY_SIZES as Record<string, number>)) {
        const from = sourceOf(suffix ? retinaFile(trayIconFile("linux", state)) : trayIconFile("linux", state));
        expect(icons.pngSize(brandFile(from)), from).toEqual({ width: size, height: size });
      }
    }
    expect(LINUX_TRAY_SIZES["@2x"]).toBe(2 * LINUX_TRAY_SIZES[""]);
  });
});

describe("the app icon, which is a separate set", () => {
  it("is the kit's launcher file on every platform", () => {
    expect(sourceOf("icon.icns")).toBe("kit/03-app-icons/macos/ccdeck.icns");
    expect(sourceOf("icon.ico")).toBe("kit/03-app-icons/windows/ccdeck.ico");
    expect(sourceOf("icon.png")).toBe("kit/03-app-icons/png/ccdeck-app-1024.png");
    for (const size of LINUX_ICON_SIZES as number[]) {
      expect(sourceOf(`linux/${size}x${size}.png`)).toBe(`kit/03-app-icons/linux/ccdeck-${size}.png`);
    }
  });

  it("is an .icns with every 1x and @2x entry of the iconset it was made from", () => {
    // The ten iconset sizes, by the element types iconutil writes for them:
    // 16, 32, 128, 256, 512 and their @2x.
    const types = icnsTypes(brandFile(sourceOf("icon.icns")));
    for (const type of ["ic04", "ic11", "ic05", "ic12", "ic07", "ic13", "ic08", "ic14", "ic09", "ic10"]) {
      expect(types, `the .icns has no ${type}`).toContain(type);
    }
  });

  it("carries the 256 entry electron-builder requires of a Windows icon", () => {
    expect(icoEntries(brandFile(sourceOf("icon.ico"))).map(e => e.size)).toContain(256);
  });

  it("is never what the tray shows", () => {
    // The rule is the brand's: the app icon has a launcher surface, the tray
    // has its own glyphs. Held twice — by where each tray file comes from, and
    // by its bytes, so a copy of an app icon under a tray name fails too.
    const tray = plan().filter(entry => entry.out.startsWith("tray-"));
    expect(tray.length).toBe(STATES.length * 5);
    for (const { out, from } of tray) expect(from, `${out} is made from an app icon`).not.toMatch(/03-app-icons/);
    const appIcons = new Set(filesUnder(join(BRAND, "kit/03-app-icons")).map(path => sha256(brandFile(`kit/03-app-icons/${path}`))));
    for (const { out, from } of tray) expect(appIcons.has(sha256(brandFile(from))), `${out} is an app icon`).toBe(false);
  });
});

describe("what the build does with the kit", () => {
  it("copies the vendored files, and draws nothing", () => {
    const source = desktop("scripts", "icons.mjs");
    // What used to draw: the coverage sampler, the shapes and the PNG encoder.
    for (const gone of ["inked", "markPng", "appIconPng", "png", "COLOURS"]) {
      expect(Object.keys(icons), `icons.mjs exports ${gone} again`).not.toContain(gone);
    }
    expect(source, "a PNG encoder in the icon build is a drawing").not.toMatch(/deflateSync|node:zlib/);
    expect(source, "geometry in the icon build is a drawing").not.toMatch(/Math\.(hypot|atan2|sin|cos)\b/);
    // And the app makes no image of its own at run time either.
    expect(desktop("main.mjs")).not.toMatch(/nativeImage\.create(FromBuffer|FromBitmap|FromDataURL|Empty)/);
    for (const { from } of plan()) expect(from, `${from} is not a vendored kit file`).toMatch(/^kit\//);
  });

  it("writes exactly the plan into dist/icons, and nothing an older build left", () => {
    written(dir => expect(filesUnder(dir)).toEqual(plan().map(e => e.out).sort()));
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
    expect(neededKitFiles().map((path: string) => `kit/${path}`)).toEqual(files);
    expect(desktop("brand", "README.md")).toContain(`<!-- files:start -->\n${fileTable()}\n<!-- files:end -->`);
    expect(desktop("scripts", "icons.mjs")).toMatch(/^export const KIT_VERSION = "\d+\.\d+\.\d+";$/m);
  });

  it("are each the size their name says", () => {
    // The kit names its rasters by size; a file whose pixels disagree with its
    // name is installed or picked at the wrong size.
    for (const path of files.filter(p => p.endsWith(".png"))) {
      const sized = /-(\d+)\.png$/.exec(path);
      const template = /Template(@2x)?\.png$/.exec(path);
      const want = sized ? Number(sized[1]) : template ? MACOS_TEMPLATE_SIZES[template[1] ?? ""] : NaN;
      expect(icons.pngSize(brandFile(path)), path).toEqual({ width: want, height: want });
    }
  });
});

describe("the macOS menu-bar templates", () => {
  const stems = MACOS_TEMPLATE_STEMS as Record<string, string>;
  const sizes = MACOS_TEMPLATE_SIZES as Record<string, number>;
  const source = (art: string, suffix: string) => {
    const state = STATES.find((s: string) => TRAY_ART[s] === art);
    return sourceOf(suffix ? retinaFile(trayIconFile("darwin", state)) : trayIconFile("darwin", state));
  };

  /** A template's pixels, and the facts the cases below read off them. */
  function measure(art: string, suffix: string) {
    const size = sizes[suffix];
    const { size: actual, px } = rgba(brandFile(source(art, suffix)));
    expect(actual).toBe(size);
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
    return { size, px, x0, y0, x1, y1, ink: ink / (size * size), coloured };
  }

  it("are named the way Electron recognises a template, with the @2x at twice the size", () => {
    // Electron marks an image as a template by "Template" ending its name,
    // and loads the @2x beside it by name.
    for (const art of Object.keys(stems)) {
      for (const suffix of Object.keys(sizes)) expect(source(art, suffix)).toMatch(/Template(@2x)?\.png$/);
    }
    expect(sizes["@2x"]).toBe(2 * sizes[""]);
  });

  // These hold for any artwork: they are about the template being whole and
  // being a template, not about what the mark looks like.
  for (const [art, stem] of Object.entries(stems)) {
    for (const [suffix, size] of Object.entries(sizes)) {
      it(`${stem}${suffix}.png is a whole mark, black on transparent, at ${size} px`, () => {
        const m = measure(art, suffix);
        // Whole means spread over the square. Kit v1.0's own default template
        // drew in a 2×2 pixel corner of its 18: ink across 2 of 18 pixels,
        // 0.6 % of the square inked.
        expect(m.x1 - m.x0 + 1, "the mark spans too little of the width: cut off").toBeGreaterThanOrEqual(size / 2);
        expect(m.y1 - m.y0 + 1, "the mark spans too little of the height: cut off").toBeGreaterThanOrEqual(size / 2);
        expect(m.ink, "almost nothing is inked: a fragment of the mark").toBeGreaterThan(0.15);
        // macOS reads only the alpha of a template; a colour in it is the
        // gradient or a status colour leaking in.
        expect(m.coloured, "a template is black and alpha, nothing else").toBe(0);
      });
    }
  }

  for (const [suffix, size] of Object.entries(sizes)) {
    it(`the default at ${size} px sits centred in its square`, () => {
      // A mark cut off at one edge, or drawn into a corner, is off centre.
      const m = measure("default", suffix);
      expect(Math.abs(m.x0 - (size - 1 - m.x1)), "off centre left to right").toBeLessThanOrEqual(size / 18);
      expect(Math.abs(m.y0 - (size - 1 - m.y1)), "off centre top to bottom").toBeLessThanOrEqual(size / 18);
    });

    it(`every state at ${size} px is the default mark with a badge, never a recolouring`, () => {
      // The kit's status badges sit top right, with a knockout into the mark.
      // Outside that quarter each state is the default, pixel for pixel;
      // inside it, something is added.
      const base = measure("default", suffix);
      const badgeQuarter = (x: number, y: number) => x >= size / 2 && y < size / 2;
      for (const art of Object.keys(stems).filter(a => a !== "default")) {
        const m = measure(art, suffix);
        let outside = 0, inside = 0;
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            if (m.px.readUInt32BE((y * size + x) * 4) === base.px.readUInt32BE((y * size + x) * 4)) continue;
            if (badgeQuarter(x, y)) inside++;
            else outside++;
          }
        }
        expect(outside, `${art} changes the mark outside the badge's quarter`).toBe(0);
        expect(inside, `${art} adds nothing to the default`).toBeGreaterThan(0);
      }
    });
  }
});
