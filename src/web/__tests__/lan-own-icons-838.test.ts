// #838: one glyph meant two things in one panel. The accounts header and the
// Local network header sit a few rows apart, and both drew ↻ and + — reload
// the accounts or check the paired decks, add an account or add a deck. The
// LAN actions have their own drawings now: a link to add (pair) a deck, and a
// broadcast to ask every paired deck at once.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const lan = read("../components/LanSyncSection.tsx");
const accounts = read("../components/AccountsPanel.tsx");
const css = read("../styles.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** The <svg> a header button draws, found by the class that names the button. */
function svgOf(src: string, cls: string): string {
  const at = src.indexOf(`className="glyph-btn ${cls}"`);
  if (at < 0) throw new Error(`no glyph-btn ${cls}`);
  const start = src.indexOf("<svg", at);
  return src.slice(start, src.indexOf("</svg>", start));
}
const paths = (svg: string) => [...svg.matchAll(/\bd="([^"]+)"/g)].map(m => m[1]);

describe("the Local network header draws its own actions (#838)", () => {
  it("draws adding a deck differently from adding an account", () => {
    expect(paths(svgOf(lan, "ap-lan-plus")).sort()).not.toEqual(paths(svgOf(accounts, "ap-add")).sort());
  });

  it("draws checking the paired decks differently from reloading the accounts", () => {
    expect(paths(svgOf(lan, "ap-lan-check")).sort()).not.toEqual(paths(svgOf(accounts, "ap-refresh")).sort());
  });

  it("shares no stroke with the accounts header's add and reload", () => {
    const theirs = new Set([...paths(svgOf(accounts, "ap-add")), ...paths(svgOf(accounts, "ap-refresh"))]);
    for (const p of [...paths(svgOf(lan, "ap-lan-plus")), ...paths(svgOf(lan, "ap-lan-check"))]) {
      expect(theirs.has(p), p).toBe(false);
    }
  });

  it("keeps both on the panel's small-icon spec", () => {
    for (const cls of ["ap-lan-plus", "ap-lan-check"]) {
      const svg = svgOf(lan, cls);
      expect(svg, cls).toMatch(/width="13" height="13" viewBox="0 0 14 14"/);
      expect(svg, cls).toMatch(/strokeWidth="1\.3"/);
      expect(svg, cls).toMatch(/aria-hidden/);
    }
  });

  it("still says it is working while the check is out, and not under reduced motion", () => {
    // Pulse is the live family's tempo (canvas-motion.test.ts) and a busy
    // control is not live traffic, so the new glyph keeps the turn "working"
    // already has here — and the reduced-motion answer that stops it.
    const busy = /\.ap-lan-check\[aria-busy="true"\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(busy).toMatch(/animation:\s*spin\b/);
    expect(css).toMatch(/\.ap-lan-check\[aria-busy="true"\],\s*\.ap-refresh\[aria-busy="true"\]\s*\{\s*animation:\s*none;/);
  });
});
