// The deck as an installed application, and the one case where it refuses to be.
//
// A manifest buys a real icon in three places at once — the macOS Dock, the
// Windows taskbar, the Linux application launcher — and the browser draws the
// install control itself, so the deck adds no UI and has nothing to nag about.
// What it costs is a promise: an installed app is pinned to an ORIGIN, an origin
// includes the port, and bin/deck.js answers a refused bind by taking a RANDOM
// port out of 4318–4400. An app installed against one of those is a dead tile by
// the next boot, and a second one appears beside it, and a third.
//
// So most of this file is about the parts that silently stop working: a manifest
// served as the wrong type is fetched, not parsed, and no install is offered
// with nothing in the console to say why; an icon list missing 192 or 512 fails
// Chrome's installability check the same quiet way; a maskable icon that is just
// the `any` icon with a second purpose on it gets its ring clipped by the mask
// on Android and looks like a letter. None of those can be noticed by looking at
// the deck, which is what makes them worth a test.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { offerManifest, MANIFEST_PATH } from "../../server/app-manifest.mjs";
import { sourceOf } from "./client-source";
import { sheetText } from "./sheet-source";
import { pngPixels } from "./png-pixels";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const PUBLIC = (name: string) => fileURLToPath(new URL(`../public/${name}`, import.meta.url));

const manifest = JSON.parse(read("../public/manifest.webmanifest"));
const html = read("../index.html");
const css = sheetText();
const app = read("../App.tsx");
const server = read("../../server/index.mjs");
const cache = read("../../server/static-cache.mjs");

interface Icon { src: string; sizes: string; type: string; purpose: string }
const icons: Icon[] = manifest.icons;

/** Width and height out of a PNG's IHDR: 8 bytes of signature, a 4-byte length,
 *  "IHDR", then two big-endian 32-bit integers. Read rather than trusted,
 *  because `sizes` in a manifest is a claim and Chrome checks the file. */
function pngSize(path: string): { width: number; height: number } {
  const buf = readFileSync(path);
  expect(buf.subarray(1, 4).toString("latin1")).toBe("PNG");
  expect(buf.subarray(12, 16).toString("latin1")).toBe("IHDR");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("the manifest Chrome will accept", () => {
  it("carries the fields an install is refused without", () => {
    expect(manifest.name).toBe("ccdeck");
    expect(manifest.short_name).toBe("ccdeck");
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
  });

  it("has a stable id, so a later start_url does not become a second app", () => {
    expect(manifest.id).toBe("/");
  });

  it("offers both sizes Chrome's installability check asks for", () => {
    const any = icons.filter(i => i.purpose === "any" && i.type === "image/png");
    expect(any.map(i => i.sizes).sort()).toEqual(["192x192", "512x512"]);
  });

  it("draws the maskable icon as its own file, never as a second purpose", () => {
    // One file claiming `any maskable` is allowed by the spec and wrong on
    // every platform that honours it: the `any` art is drawn at 80% of the
    // tile and a mask takes a third of its ring.
    const maskable = icons.filter(i => i.purpose.split(/\s+/).includes("maskable"));
    expect(maskable).toHaveLength(1);
    expect(maskable[0].purpose).toBe("maskable");
    expect(maskable[0].sizes).toBe("512x512");
    const others = icons.filter(i => i !== maskable[0]).map(i => i.src);
    expect(others).not.toContain(maskable[0].src);
  });

  it("names the kit's PNGs and no vector beside them", () => {
    // The kit's own manifest lists three PNGs and nothing else. An SVG entry
    // here is one Chromium may prefer over the PNGs, so the repo's old ring
    // (icon.svg, retired with it) would have outlived the swap in every
    // installed tile while the PNGs looked right in review.
    expect(icons.map(i => i.type)).toEqual(["image/png", "image/png", "image/png"]);
    expect(existsSync(PUBLIC("icon.svg")), "the retired icon.svg is back").toBe(false);
    expect(existsSync(PUBLIC("icon-maskable.svg")), "the retired icon-maskable.svg is back").toBe(false);
  });

  it("ships every file it names, at the size it claims", () => {
    for (const icon of icons) {
      const path = PUBLIC(icon.src);
      expect(existsSync(path), `${icon.src} is named by the manifest`).toBe(true);
      expect(statSync(path).size).toBeGreaterThan(0);
      if (icon.type !== "image/png") continue;
      const [w, h] = icon.sizes.split("x").map(Number);
      expect(pngSize(path)).toEqual({ width: w, height: h });
    }
  });

  it("keeps the maskable art inside the safe zone", () => {
    // 409 of 512 is the circle a mask may cut to, and a mark clipped on one
    // side by an Android mask stops being the mark. This read a circle's radius
    // and stroke out of icon-maskable.svg until the brand kit's icons replaced
    // the repo's own ring: the kit ships the maskable icon as a PNG with no
    // editable source, so the guarantee is now measured where it is delivered,
    // on the pixels. Ink is anything that is not the ground the corners show;
    // the kit's measures 171.5px from the centre at its farthest.
    const { width, height, channels, data } = pngPixels(PUBLIC("icon-maskable-512.png"));
    const at = (x: number, y: number) => data.subarray((y * width + x) * channels, (y * width + x + 1) * channels);
    const ground = [...at(0, 0)];
    for (const [x, y] of [[width - 1, 0], [0, height - 1], [width - 1, height - 1]]) {
      // Full bleed: the ground reaches every corner, because the mask is what
      // shapes this tile and a transparent corner would show through it.
      expect([...at(x, y)], "the maskable icon is not full bleed").toEqual(ground);
    }
    if (channels === 4) expect(ground[3], "the maskable ground is not opaque").toBe(255);
    let ink = 0, farthest = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const px = at(x, y);
        if (px.every((v, i) => Math.abs(v - ground[i]) <= 2)) continue;
        ink++;
        farthest = Math.max(farthest, Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2));
      }
    }
    expect(ink, "no mark was found on the maskable icon — the bound below would pass on nothing")
      .toBeGreaterThan(width * height * 0.05);
    expect(farthest, "the maskable mark reaches past the circle a mask may cut to").toBeLessThanOrEqual(409 / 2);
  });

  it("takes its colours from the dark theme rather than a second palette", () => {
    // :root is the dark theme — styles.css reads a missing data-theme as dark.
    const token = (name: string) =>
      new RegExp(`^\\s*--${name}:\\s*(#[0-9a-f]{6});`, "im").exec(css)?.[1];
    expect(manifest.background_color).toBe(token("bg"));
    expect(manifest.theme_color).toBe(token("panel"));
  });
});

describe("the document that points at it", () => {
  it("links the manifest", () => {
    expect(html).toMatch(/<link rel="manifest" href="\/manifest\.webmanifest"/);
  });

  it("carries a theme-color meta for the standalone window's title bar", () => {
    const content = /<meta name="theme-color" content="(#[0-9a-f]{6})"/.exec(html)?.[1];
    // The dark theme's --panel, which is what a deck with nothing stored
    // paints. Read from the sheet so the two cannot drift apart in a rename.
    expect(content).toBe(/^\s*--panel:\s*(#[0-9a-f]{6});/im.exec(css)?.[1]);
  });

  it("re-writes that meta whenever the theme flips", () => {
    // The meta effect moved to use-appearance.ts with the palette it reads. A slice
    // taken by indexOf, so it reads that one file rather than the client.
    const app = sourceOf("use-appearance.ts");
    // A media-queried pair in the head would follow the OS past a stored
    // choice, which is wrong for exactly the people who pressed T.
    const at = app.indexOf('meta[name="theme-color"]');
    expect(at).toBeGreaterThan(-1);
    const body = app.slice(at, app.indexOf("});", at));
    // From the palette, which is the snapshot the theme effect has just
    // replaced — not a second getComputedStyle for a value already read. See
    // render-path-cost-612-613.test.ts, which counts cssVar's mentions.
    expect(body).toContain('palette["--panel"]');
    expect(app.slice(at)).toMatch(/^[\s\S]{0,400}?\}, \[palette\]\);/);
  });
});

describe("the notification the page raises", () => {
  it("carries the manifest's 192 icon, a file that ships", () => {
    // Without an icon the OS shows the browser's own beside the origin. The
    // path is the manifest's `any` 192, so a rename there that missed this
    // file would be a notification pointing at the SPA fallback's HTML.
    const src = sourceOf("use-os-notifications.ts");
    const path = /const NOTIFICATION_ICON = "\/([^"]+)";/.exec(src)?.[1];
    expect(path, "the page's notification names no icon").toBeTruthy();
    expect(icons.find(i => i.purpose === "any" && i.sizes === "192x192")?.src).toBe(path);
    expect(src).toMatch(/new Notification\([^)]*icon: NOTIFICATION_ICON/);
  });
});

describe("the server that serves it", () => {
  it("knows the type, without which a browser fetches it and parses nothing", () => {
    // The type table is the static handler's, in static-serve.mjs.
    expect(read("../../server/static-serve.mjs")).toMatch(/"\.webmanifest":\s*"application\/manifest\+json/);
  });

  it("compresses it like the other text it serves", () => {
    expect(cache).toMatch(/COMPRESSIBLE = new Set\(\[[^\]]*"\.webmanifest"/);
  });

  it("withdraws it when the port was invented rather than chosen", () => {
    expect(MANIFEST_PATH).toBe("/manifest.webmanifest");
    expect(server).toContain("url.pathname === MANIFEST_PATH && !offerManifest(");
    // Ahead of serveStatic, which would otherwise hand the file over.
    const gate = server.indexOf("url.pathname === MANIFEST_PATH");
    const stat = server.indexOf("return serveStatic(req, res, url)");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(stat);
  });

  it("records what actually bound, not which candidate it tried", () => {
    // `port: 0` is "any ephemeral port" — the candidate and the request agree
    // at 0 while the deck listens on a number nobody chose. Every in-process
    // test here boots that way, so reading the candidate would hand a manifest
    // to precisely the decks that must never have one.
    expect(server).toContain("boundPort = server.address()?.port ?? candidate;");
  });
});

describe("whether this deck may be installed", () => {
  it("says yes on the port that was asked for", () => {
    expect(offerManifest({ asked: 4317, bound: 4317 })).toBe(true);
    // An explicit --port that bound is just as deliberate as the default.
    expect(offerManifest({ asked: 4500, bound: 4500 })).toBe(true);
  });

  it("says no on a random fallback, which is a different number every boot", () => {
    expect(offerManifest({ asked: 4317, bound: 4322 })).toBe(false);
  });

  it("says no to an ephemeral port, which is what every test deck gets", () => {
    expect(offerManifest({ asked: 0, bound: 54_321 })).toBe(false);
  });

  it("says no before anything is listening", () => {
    expect(offerManifest({ asked: 4317, bound: null })).toBe(false);
    expect(offerManifest({})).toBe(false);
    expect(offerManifest()).toBe(false);
  });

  it("does not take a string for a port", () => {
    expect(offerManifest({ asked: "4317" as unknown as number, bound: 4317 })).toBe(false);
  });
});
