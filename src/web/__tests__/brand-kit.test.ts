// The brand kit's files in this repo, and the record that says where each one
// came from.
//
// Every logo, icon and brand colour the deck ships is a file copied unchanged
// from the ccdeck brand kit; assets/brand/kit.json lists each one, every place
// it serves, and its SHA-256, and assets/brand/kit.mjs rewrites that record
// whenever a kit is copied in. Nothing here pins one kit release's bytes: a new
// kit copied in with the command stays green. What is pinned is that the copies
// and the record agree, that every image the page serves is one of them, and
// that the slots get files of the shape they need.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BRAND = join(repo, "assets", "brand");
const PUBLIC = join(repo, "src", "web", "public");

interface KitFile { from: string; to: string[]; sha256: string }
const record: { kit: string; files: KitFile[] } = JSON.parse(readFileSync(join(BRAND, "kit.json"), "utf8"));
const copies = record.files.flatMap(f => f.to);
const sha256 = (rel: string) => createHash("sha256").update(readFileSync(join(repo, rel))).digest("hex");
const COMMAND = "node assets/brand/kit.mjs";

/** Every file under `dir`, as a repo-relative path with forward slashes. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [relative(repo, path).split("\\").join("/")];
  });
}

describe("the record of the kit", () => {
  it("names the kit's version, and is the one place that does", () => {
    expect(record.kit).toMatch(/^\d+\.\d+\.\d+$/);
    // A second copy of the number is the one that goes stale on the next kit.
    expect(readFileSync(join(BRAND, "README.md"), "utf8"), "assets/brand/README.md restates the kit version")
      .not.toMatch(/\b\d+\.\d+\.\d+\b/);
  });

  it("has every copy it lists on disk, and the copies of one kit file agree", () => {
    for (const file of record.files) {
      for (const dest of file.to) expect(existsSync(join(repo, dest)), `${dest} (from ${file.from}) is missing`).toBe(true);
      expect(new Set(file.to.map(sha256)).size, `the copies of ${file.from} differ`).toBe(1);
    }
  });

  it("records each copy as it is now", () => {
    // A file changed without the command is either an edited kit file, which
    // the rules forbid, or a kit copied in by hand, which leaves the record
    // describing the old one.
    for (const file of record.files) {
      expect(sha256(file.to[0]), `${file.to[0]} is not the file kit.json records; run \`${COMMAND} <kit-dir>\``)
        .toBe(file.sha256);
    }
  });

  it("vendors every image the page serves, so none of them is drawn by hand", () => {
    // The repo drew its own ring for the favicon, the icons and the topbar
    // until the kit. Anything in public/ that is not a kit copy is that again.
    const served = filesUnder(PUBLIC).filter(p => !p.endsWith("/manifest.webmanifest"));
    const notFromKit = served.filter(p => !copies.includes(p));
    expect(notFromKit, "the page serves an image that did not come from the kit").toEqual([]);
    const vendored = filesUnder(BRAND).filter(p => !/\/(README\.md|kit\.json|kit\.mjs)$/.test(p));
    expect(vendored.filter(p => !copies.includes(p)), "assets/brand holds a file kit.json does not list").toEqual([]);
  });

  it("writes the name lowercase and never names where the kit is kept", () => {
    // This repo is public; the kit's home is not, and the kit's own text files
    // spell the product "CCDeck", which is why none of them is copied.
    for (const name of ["README.md", "kit.json", "kit.mjs"]) {
      const text = readFileSync(join(BRAND, name), "utf8");
      expect(text, `${name} spells the name with capitals`).not.toMatch(/CCDeck/);
      expect(text, `${name} names the private repository`).not.toMatch(/ccdeck-internal/i);
    }
  });
});

describe("the instructions agents read", () => {
  it("send them to the brand files before they touch a logo", () => {
    // An agent that has never seen assets/brand/ redraws the mark in CSS, which
    // is exactly how the ring this kit replaced got here.
    const agents = readFileSync(join(repo, "AGENTS.md"), "utf8");
    expect(agents).toMatch(/^## Brand$/m);
    expect(agents).toContain("assets/brand/README.md");
    expect(agents, "AGENTS.md spells the name with capitals").not.toMatch(/CCDeck/);
  });
});

describe("the files each slot needs", () => {
  const png = (rel: string) => {
    const b = readFileSync(join(repo, rel));
    expect(b.subarray(1, 4).toString("latin1"), `${rel} is not a PNG`).toBe("PNG");
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  };

  it("gives iOS its 180px home-screen icon", () => {
    expect(png("src/web/public/apple-touch-icon.png")).toEqual({ width: 180, height: 180 });
  });

  it("has the 32x32 image index.html says the ICO fallback holds", () => {
    // ICONDIR: reserved, type 1, a count; then 16 bytes per image, width and
    // height first, where 0 means 256.
    const ico = readFileSync(join(PUBLIC, "favicon.ico"));
    expect(ico.readUInt16LE(2), "favicon.ico is not an icon file").toBe(1);
    const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => {
      const at = 6 + i * 16;
      return `${ico[at] || 256}x${ico[at + 1] || 256}`;
    });
    expect(sizes).toContain("32x32");
    expect(readFileSync(join(repo, "src", "web", "index.html"), "utf8")).toMatch(/href="\/favicon\.ico" sizes="32x32"/);
  });

  it("draws the small mark and the favicon on a square viewBox, so 16px squares do not stretch them", () => {
    for (const rel of ["src/web/public/brand/ccdeck-mark-gradient-small-optical.svg", "src/web/public/favicon.svg"]) {
      const box = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(readFileSync(join(repo, rel), "utf8"));
      expect(box, `${rel} has no viewBox`).toBeTruthy();
      expect(box![1], `${rel} is not square`).toBe(box![2]);
    }
  });

  it("names the README's lockups, which it sizes by width", () => {
    const readme = readFileSync(join(repo, "README.md"), "utf8");
    for (const theme of ["on-dark", "on-light"]) {
      const rel = `assets/brand/ccdeck-horizontal-${theme}.svg`;
      expect(copies, `${rel} is not a kit copy`).toContain(rel);
      expect(readme, `the README hero does not use ${rel}`).toContain(rel);
      expect(readFileSync(join(repo, rel), "utf8"), `${rel} has no viewBox`).toMatch(/viewBox="0 0 [\d.]+ [\d.]+"/);
    }
  });
});
