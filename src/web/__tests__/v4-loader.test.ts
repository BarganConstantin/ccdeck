// V4's Loader (its Figma kit, Work / Loader 143:1174): nine pixels and a soft
// wave, corner to corner, for the app waiting on data. S is 3 x 3 in a 14px
// slot, M is 5 x 5 in 24; a 3px pixel, radius 1, gap 2. One pass is 1200ms (2400
// when it waits on a person), each diagonal starts an eighth of a pass later
// (a sixteenth on M), and the grid comes in after 150ms. Reduced motion holds
// the pixels at 0.6 and pulses the grid. Refresh keeps its arrow and turns it,
// one tempo of 900ms.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Loader } from "../components/Loader";
import { sheetText } from "./sheet-source";

const sheet = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
function body(selector: string, text = sheet): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, "m").exec(text);
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[1];
}
const decl = (selector: string, prop: string, text = sheet): string | undefined => {
  const m = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+?)\\s*(?:;|$)`).exec(body(selector, text));
  return m?.[1].replace(/\s+/g, " ");
};
const source = (file: string) => readFileSync(fileURLToPath(new URL(`../components/${file}`, import.meta.url)), "utf8");
/** The reduced-motion block that holds `.loader`. */
const reduced = (() => {
  const at = sheet.lastIndexOf("@media (prefers-reduced-motion: reduce)", sheet.indexOf(".loader i { animation: none;"));
  const m = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?\.loader i \{[^}]*\}\s*)\}/.exec(sheet.slice(at));
  if (at < 0 || !m) throw new Error("no reduced-motion block for the loader");
  return m[1];
})();

describe("V4's Loader geometry", () => {
  it("S is 3 x 3 pixels of 3px in a 14px slot, 2px apart, in the accent", () => {
    expect(decl(".loader", "display")).toBe("inline-grid");
    expect(decl(".loader", "width")).toBe("14px");
    expect(decl(".loader", "height")).toBe("14px");
    expect(decl(".loader", "grid-template")).toBe("repeat(3, 3px) / repeat(3, 3px)");
    expect(decl(".loader", "gap")).toBe("2px");
    expect(decl(".loader", "color")).toBe("var(--accent)");
  });
  it("M is 5 x 5 in 24px", () => {
    expect(decl('.loader[data-size="m"]', "width")).toBe("24px");
    expect(decl('.loader[data-size="m"]', "height")).toBe("24px");
    expect(decl('.loader[data-size="m"]', "grid-template")).toBe("repeat(5, 3px) / repeat(5, 3px)");
  });
  it("draws a pixel as currentColor with radius 1, resting at 0.2 and 0.8", () => {
    expect(decl(".loader i", "border-radius")).toBe("1px");
    expect(decl(".loader i", "background")).toBe("currentColor");
    expect(decl(".loader i", "opacity")).toBe("0.2");
    expect(decl(".loader i", "transform")).toBe("scale(0.8)");
  });
  it("never takes a status colour", () => {
    expect(body(".loader")).not.toMatch(/var\(--(?:ok|warn|err|inflight)\b/);
  });
});

describe("V4's Loader wave", () => {
  it("runs loader-wave on ease-in-out, forever, over the pass token", () => {
    expect(decl(".loader i", "animation")).toBe("loader-wave var(--pass) ease-in-out infinite");
    expect(body(".loader i")).not.toContain("var(--ease)");
  });
  it("is one 1200ms pass, 2400 when it waits on a person", () => {
    expect(decl(".loader", "--pass")).toBe("var(--loop-loader)");
    expect(decl('.loader[data-pace="person"]', "--pass")).toBe("var(--loop-loader-person)");
    const tokens = readFileSync(fileURLToPath(new URL("../styles/tokens.css", import.meta.url)), "utf8");
    expect(tokens).toMatch(/--loop-loader:\s*1200ms/);
    expect(tokens).toMatch(/--loop-loader-person:\s*2400ms/);
  });
  it("rises to 1 and scale 1 at 25% and is back at rest by 75%", () => {
    const m = /@keyframes loader-wave \{([\s\S]*?\}\s*)\}/.exec(sheet);
    expect(m).not.toBeNull();
    const k = norm(m![1]);
    expect(k).toContain("0%, 75%, 100% { opacity: 0.2; transform: scale(0.8); }");
    expect(k).toContain("25% { opacity: 1; transform: scale(1); }");
  });
  it("delays each diagonal by an eighth of a pass on S and a sixteenth on M", () => {
    expect(decl(".loader i", "animation-delay")).toBe("calc(var(--d) * var(--pass) / 8 - var(--pass))");
    expect(decl('.loader[data-size="m"] i', "animation-delay")).toBe("calc(var(--d) * var(--pass) / 16 - var(--pass))");
  });
});

describe("V4's Loader waiting, hiding and reduced motion", () => {
  it("comes in after 150ms over Fast, holding its slot from the start", () => {
    expect(decl(".loader", "animation")).toBe("loader-in var(--dur-fast) linear var(--delay-loader) both");
    expect(sheet).toMatch(/@keyframes loader-in \{\s*from \{ opacity: 0; \}\s*\}/);
  });
  it("stops in a hidden window", () => {
    expect(sheet).toMatch(/\.loader\[data-paused\], \.loader\[data-paused\] i \{ animation-play-state: paused; \}/);
  });
  it("holds the pixels at 0.6 and pulses the whole grid under reduced motion", () => {
    expect(decl(".loader i", "animation", reduced)).toBe("none");
    expect(decl(".loader i", "opacity", reduced)).toBe("0.6");
    expect(decl(".loader i", "transform", reduced)).toBe("none");
  });
  it("lets the entrance finish before the pulse takes the opacity over", () => {
    const a = decl(".loader", "animation", reduced) ?? "";
    expect(a).toContain("loader-in var(--dur-fast) linear var(--delay-loader) both");
    expect(a).toContain("pulse var(--pulse-live) calc(var(--delay-loader) + var(--dur-fast)) infinite");
    expect(a.indexOf("loader-in")).toBeLessThan(a.indexOf("pulse"));
  });
  it("pairs the grid with its words 8px apart, centred", () => {
    expect(decl(".loader-line", "display")).toBe("flex");
    expect(decl(".loader-line", "align-items")).toBe("center");
    expect(decl(".loader-line", "gap")).toBe("8px");
  });
});

describe("V4's Loader markup", () => {
  const html = (props: Parameters<typeof Loader>[0] = {}) => renderToStaticMarkup(createElement(Loader, props));
  const ds = (h: string) => [...h.matchAll(/--d:(\d+)/g)].map(m => Number(m[1]));
  it("S is nine <i> with --d = row + column, row-major, and is aria-hidden", () => {
    const h = html();
    expect(h.match(/<i /g)).toHaveLength(9);
    expect(ds(h)).toEqual([0, 1, 2, 1, 2, 3, 2, 3, 4]);
    expect(h).toContain('aria-hidden="true"');
    expect(h).not.toContain("data-size");
    expect(h).not.toContain("data-paused");
  });
  it("M is 25 <i> and says so", () => {
    const h = html({ size: "m" });
    expect(h.match(/<i /g)).toHaveLength(25);
    expect(h).toContain('data-size="m"');
    expect(ds(h).slice(0, 7)).toEqual([0, 1, 2, 3, 4, 1, 2]);
    expect(Math.max(...ds(h))).toBe(8);
  });
  it("names the person pace", () => {
    expect(html({ pace: "person" })).toContain('data-pace="person"');
    expect(html()).not.toContain("data-pace");
  });
});

describe("V4's Loader placements", () => {
  it("shows beside 'Checking…' in both quota sections, the words carrying role=status", () => {
    const src = source("QuotaSections.tsx");
    const lines = src.match(/<div className="up-quota-na up-quota-loading loader-line"><Loader \/><span role="status">Checking…<\/span><\/div>/g);
    expect(lines).toHaveLength(2);
    expect(src).not.toMatch(/<div className="up-quota-na up-quota-loading">Checking…<\/div>/);
  });
  it("lays the quota loading line out as a row without changing its font or colour", () => {
    expect(decl(".up-quota-loading", "flex-direction")).toBe("row");
    expect(decl(".up-quota-loading", "align-items")).toBe("center");
    expect(decl(".up-quota-loading", "gap")).toBe("8px");
    expect(decl(".up-quota-loading", "color")).toBe("var(--text-dim)");
    expect(decl(".up-quota-loading", "font-size")).toBe("calc(11px + var(--ui-text-increase, 0px))");
  });
  it("shows beside 'Reading connections…' in Settings", () => {
    expect(source("IntegrationsSection.tsx")).toContain('<p className="loader-line" role="status"><Loader />Reading connections…</p>');
  });
  it("shows beside 'Reading integrations…' only, not beside the error sentence", () => {
    const src = source("ExploreIntegrationsModal.tsx");
    expect(src).toContain('<p className="explore-status" role="status">{integrations.error ? "Connection status is unavailable." : <span className="loader-line"><Loader />Reading integrations…</span>}</p>');
  });
  it("shows beside 'Reading boards…' in the Jira board picker", () => {
    expect(source("JiraPanel.tsx")).toContain('<p className="jr-board-pop-note loader-line" role="status"><Loader />Reading boards…</p>');
  });
});

describe("Refresh keeps its arrow and turns it at one tempo of 900ms", () => {
  it("spins every refresh arrow in the sheet for 900ms", () => {
    const spins = [...sheet.matchAll(/([^{}]*\{[^{}]*animation:\s*(?:ta-)?spin\s+(\d+)ms[^{}]*\})/g)]
      .filter(m => /refresh|ta-actions|data-loading|aria-busy/.test(m[1]));
    expect(spins.length).toBeGreaterThanOrEqual(4);
    for (const m of spins) expect(m[2], norm(m[1])).toBe("900");
    expect(sheet).not.toMatch(/ta-spin\s+1000ms/);
  });
  it("turns the shared arrow while its button is busy, and holds still under reduced motion", () => {
    expect(decl('.glyph-btn[aria-busy="true"] > .refresh-glyph', "animation")).toBe("spin 900ms linear infinite");
    expect(sheet).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.glyph-btn\[aria-busy="true"\] > \.refresh-glyph \{ animation: none; \}\s*\}/);
  });
  it("gives both arrows the class, and only the arrows", () => {
    // RefreshGlyph alone in action-glyphs.tsx: on the external-link glyph the
    // class would turn it whenever its button is busy.
    const glyphs = source("action-glyphs.tsx");
    expect(glyphs.match(/className="refresh-glyph"/g)).toHaveLength(1);
    expect(glyphs).toMatch(/export function RefreshGlyph\(\) \{\s*return <svg className="refresh-glyph" width="13"/);
    expect(source("UsagePanel.tsx")).toMatch(/<svg className="refresh-glyph" width="16"/);
  });
  for (const file of ["UsagePanel.tsx", "UsageHistoryModal.tsx", "QuotaHistoryModal.tsx", "BrowserWatchModal.tsx"]) {
    it(`${file} does not swap its arrow for "…"`, () => {
      const src = source(file).replace(/\/\*[\s\S]*?\*\//g, "");
      expect(src).not.toMatch(/(?:anyLoading|loading|busy) \? "…"/);
    });
  }
});
