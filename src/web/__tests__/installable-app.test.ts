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

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const PUBLIC = (name: string) => fileURLToPath(new URL(`../public/${name}`, import.meta.url));

const manifest = JSON.parse(read("../public/manifest.webmanifest"));
const html = read("../index.html");
const css = read("../styles.css");
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
    // 409 of 512 is the circle a mask may cut to. The ring's outer edge is its
    // radius plus half its stroke, and a ring clipped on one side stops being a
    // ring — which is the whole mark.
    const svg = read("../public/icon-maskable.svg");
    const r = Number(/<circle[^>]*\br="(\d+)"/.exec(svg)?.[1]);
    const stroke = Number(/<circle[^>]*stroke-width="(\d+)"/.exec(svg)?.[1]);
    expect(r).toBeGreaterThan(0);
    expect(r + stroke / 2).toBeLessThanOrEqual(409 / 2);
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

describe("the server that serves it", () => {
  it("knows the type, without which a browser fetches it and parses nothing", () => {
    expect(server).toMatch(/"\.webmanifest":\s*"application\/manifest\+json/);
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
