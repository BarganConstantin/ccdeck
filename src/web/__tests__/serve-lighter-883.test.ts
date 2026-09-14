// #883: the whole UI shipped as one 833 KB script, served uncompressed and
// marked no-cache — even the hashed assets — so every reload, and every deck
// opened from another machine on the LAN, fetched all of it again at full size.
//
// Now a file under assets/ (Vite names each by a hash of its content) is cached
// for a year and marked immutable, index.html stays no-cache because it is what
// moves on an upgrade, text is sent brotli or gzip when the browser takes it,
// and the two rarely opened large dialogs load when they open.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { cacheControlFor, encodedBody, pickEncoding } from "../../server/static-cache.mjs";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const server = read("../../server/index.mjs");
const app = read("../App.tsx");

describe("the deck's own files are cached by what they are (#883)", () => {
  it("caches a hashed asset for good", () => {
    expect(cacheControlFor("assets/index-DQqCSzMo.js")).toBe("public, max-age=31536000, immutable");
    expect(cacheControlFor("assets/BrowserWatchModal-a1B2c3_-.js")).toMatch(/immutable/);
    expect(cacheControlFor("assets/index-BMRQNdWu.css")).toMatch(/immutable/);
  });

  it("keeps fresh whatever names them, and anything not hashed", () => {
    for (const rel of ["index.html", "favicon.svg", "assets/logo.svg", "guide/index.html"]) {
      expect(cacheControlFor(rel), rel).toBe("no-cache");
    }
  });
});

describe("compressed when the browser takes it (#883)", () => {
  it("prefers brotli, falls back to gzip, honours a refusal and leaves images alone", () => {
    expect(pickEncoding("gzip, deflate, br", ".js")).toBe("br");
    expect(pickEncoding("gzip", ".css")).toBe("gzip");
    expect(pickEncoding("br;q=0, gzip", ".js")).toBe("gzip");
    expect(pickEncoding("", ".js")).toBeNull();
    expect(pickEncoding(undefined, ".html")).toBeNull();
    expect(pickEncoding("br, gzip", ".png")).toBeNull();
    expect(pickEncoding("br, gzip", ".woff2")).toBeNull();
  });

  it("round-trips both encodings, and compresses a build's file once", () => {
    const src = Buffer.from("const deck = 'ccdeck';\n".repeat(400));
    const br = encodedBody("/x/app.js", 1, src, "br");
    expect(brotliDecompressSync(br).equals(src)).toBe(true);
    expect(br.length).toBeLessThan(src.length / 10);
    expect(encodedBody("/x/app.js", 1, src, "br")).toBe(br);
    expect(gunzipSync(encodedBody("/x/app.js", 1, src, "gzip")).equals(src)).toBe(true);
    // A rebuild is a new entry, never the old bytes.
    expect(encodedBody("/x/app.js", 2, src, "br")).not.toBe(br);
  });
});

describe("the static handler sends them (#883)", () => {
  const handler = /async function serveStatic\(req, res, url\) \{[\s\S]*?\n\}/.exec(server)?.[0] ?? "";

  it("negotiates the encoding and says so", () => {
    expect(handler, "serveStatic is gone").not.toBe("");
    expect(handler).toMatch(/pickEncoding\(req\.headers\["accept-encoding"\], ext\)/);
    expect(handler).toMatch(/"Content-Encoding": encoding/);
    expect(handler).toMatch(/"Vary": "Accept-Encoding"/);
    expect(handler).toMatch(/"Content-Length": body\.length/);
  });

  it("caches by the URL's own path, and keeps the SPA fallback fresh", () => {
    expect(handler).toMatch(/"Cache-Control": cacheControlFor\(rel\)/);
    expect(handler).toMatch(/"Cache-Control": "no-cache"/);
  });
});

describe("the rarely opened dialogs load when they open (#883)", () => {
  it("lazy-loads Browser Watch and the usage history", () => {
    expect(app).toMatch(/const BrowserWatchModal = lazy\(\(\) => import\("\.\/components\/BrowserWatchModal"\)\);/);
    expect(app).toMatch(/const UsageHistoryModal = lazy\(\(\) => import\("\.\/components\/UsageHistoryModal"\)\);/);
    expect(app).not.toMatch(/^import BrowserWatchModal\b/m);
    expect(app).not.toMatch(/^import UsageHistoryModal\b/m);
  });

  it("takes the topbar's unseen count from a module that does not carry the dialog", () => {
    expect(app).toMatch(/import \{ SEEN_KEY, unseenEpisodes \} from "\.\/browser-watch-seen";/);
    // A type import is erased, so it does not pull the dialog back in.
    expect(app).toMatch(/import type \{ WatchEpisode \} from "\.\/components\/BrowserWatchModal";/);
  });

  it("gives each a Suspense boundary, drawing nothing while the chunk arrives", () => {
    expect(app).toMatch(/<Suspense fallback=\{null\}>\s*<UsageHistoryModal /);
    expect(app).toMatch(/<Suspense fallback=\{null\}>\s*<BrowserWatchModal/);
  });
});
