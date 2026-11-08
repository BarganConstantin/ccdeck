// The Board's tool legend (V4's Figma). The category filter over the canvas was
// six accent-outlined pills inside a bordered box, every one shouting
// "selected" at once. It is a quiet legend now: a dot and a word per category,
// no box, no outline. A hidden category's dot goes hollow and its word steps
// down to --text-dim, so the shape carries the state and not only the colour.
// "Show all" turns up while anything is hidden. Under 600px wide the legend
// folds into one "Tools 4 of 6" button with the same toggles as checkboxes in
// a menu. Each item is still the toggle it was; the hook behind it
// (use-category-filter-bar.ts) is unchanged.
//
// Rendered, not only read: the legend is drawn server-side with the window's
// width stubbed, so what each state puts on screen is asserted as markup.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import CategoryFilterBar, { LEGEND_FOLD_QUERY } from "../components/CategoryFilterBar";
import type { DetailCategory } from "../detail-category";
import { sheetText } from "./sheet-source";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const sheet = sheetText().replace(/\/\*[\s\S]*?\*\//g, "").replace(/,\s*\n\s*/g, ", ");
/** Every rule naming exactly this selector, bodies joined in cascade order. */
function body(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hits = [...sheet.matchAll(new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, "gm"))].map(m => m[1]);
  if (!hits.length) throw new Error(`no rule for ${selector}`);
  return hits.join(";");
}
/** The last declaration of `prop` in those bodies, the one that wins. */
const decl = (selector: string, prop: string): string | undefined => {
  const all = [...body(selector).matchAll(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+?)\\s*(?=;|$)`, "g"))];
  return all.length ? all[all.length - 1][1].replace(/\s+/g, " ") : undefined;
};

const SIX: DetailCategory[] = ["file", "shell", "agent", "plan", "mcp", "other"];
function draw(hidden: DetailCategory[], present: DetailCategory[] = SIX): string {
  return renderToStaticMarkup(createElement(CategoryFilterBar, {
    catBarRef: { current: null },
    catBarOccluded: false,
    presentCats: present,
    hiddenCats: new Set(hidden),
    toggleCat: () => {},
  }));
}
/** A window this wide or narrower: useMediaQuery reads matchMedia on its first render. */
function narrow(folded: boolean) {
  vi.stubGlobal("window", {
    matchMedia: (q: string) => ({ matches: folded && q === LEGEND_FOLD_QUERY, addEventListener() {}, removeEventListener() {} }),
  });
}
afterEach(() => { vi.unstubAllGlobals(); });

const items = (html: string) => [...html.matchAll(/<button type="button" class="(cat-filter cat-[a-z]+(?: off)?)"[^>]*aria-pressed="(true|false)"/g)]
  .map(m => [m[1], m[2]]);

describe("the legend, as wide as a desktop", () => {
  it("draws a dot and a word per category on the board, each a toggle pressed while it shows", () => {
    const html = draw([]);
    expect(items(html)).toEqual(SIX.map(c => [`cat-filter cat-${c}`, "true"]));
    expect(html).toContain('<span class="cat-dot" aria-hidden="true"></span><span class="cat-name">shell</span>');
    // Named as one group, every item its own tab stop.
    expect(html).toMatch(/^<div class="cat-filter-bar" role="group" aria-label="Filter tools by category">/);
    // Nothing is hidden, so there is nothing to show again.
    expect(html).not.toContain("Show all");
    expect(html).not.toContain("cat-filter-sep");
  });

  it("marks a hidden category off and unpressed, and offers Show all after a rule", () => {
    const html = draw(["shell", "other"]);
    expect(items(html)).toEqual([
      ["cat-filter cat-file", "true"], ["cat-filter cat-shell off", "false"], ["cat-filter cat-agent", "true"],
      ["cat-filter cat-plan", "true"], ["cat-filter cat-mcp", "true"], ["cat-filter cat-other off", "false"],
    ]);
    // The rule, then Show all, after the last item.
    const last = html.indexOf("cat-filter cat-other off");
    const sep = html.indexOf('<span class="cat-filter-sep" aria-hidden="true"></span>');
    const all = html.indexOf('<button type="button" class="cat-filter-all">Show all</button>');
    expect(sep).toBeGreaterThan(last);
    expect(all).toBeGreaterThan(sep);
  });

  it("keeps Show all for a hidden category that has left the board, the filter it still holds (#783)", () => {
    const html = draw(["web"]);
    expect(items(html).every(([, pressed]) => pressed === "true")).toBe(true);
    expect(html).toContain("Show all");
    // And with nothing on the board at all, Show all stands alone, no rule before it.
    const bare = draw(["shell"], []);
    expect(items(bare)).toEqual([]);
    expect(bare).toContain("Show all");
    expect(bare).not.toContain("cat-filter-sep");
  });

  it("shows every category again through the same toggle a single item uses", () => {
    const src = read("../components/CategoryFilterBar.tsx");
    expect(src).toContain("const showAll = () => { for (const c of hiddenCats) toggleCat(c); };");
    // Focus on Show all moves to the first item before the button goes.
    expect(src).toMatch(/if \(document\.activeElement === e\.currentTarget\) \{\s*catBarRef\.current\?\.querySelector<HTMLButtonElement>\("\.cat-filter"\)\?\.focus\(\{ preventScroll: true \}\);\s*\}\s*showAll\(\);/);
    // The hook keeps its shape: the legend changed, the filter did not.
    expect(read("../use-category-filter-bar.ts")).toContain("return { presentCats, hiddenCats, toggleCat, catBarRef, catBarOccluded };");
  });
});

describe("the legend folded, under 600px wide", () => {
  it("folds at 599px and below", () => {
    expect(LEGEND_FOLD_QUERY).toBe("(max-width: 599px)");
  });

  it("is one button that says how many categories show, and no row", () => {
    narrow(true);
    const html = draw(["shell", "other"]);
    expect(items(html)).toEqual([]);
    expect(html).not.toContain("Show all");
    expect(html).toMatch(/<button id="[^"]+-tools" type="button" class="cat-filter-tools" aria-haspopup="dialog" aria-expanded="false">/);
    expect(html).toContain('aria-expanded="false">Tools <span class="cat-tools-count">4 of 6</span>');
    expect(html).toMatch(/^<div class="cat-filter-bar" role="group" aria-label="Filter tools by category">/);
    narrow(true);
    expect(draw([])).toContain('<span class="cat-tools-count">6 of 6</span>');
  });

  it("stays a row on a window wider than that", () => {
    narrow(false);
    expect(items(draw([]))).toHaveLength(6);
  });

  it("opens the same toggles as the kit's checkboxes in the kit's menu, with Show all under a rule", () => {
    const src = read("../components/CategoryFilterBar.tsx");
    expect(src).toMatch(/<AnchoredPopover anchorId=\{trigger\} id=\{menu\} className="ap-pop" role="dialog"/);
    expect(src).toMatch(/<label key=\{c\} className=\{`ap-menu-item cat-tools-item cat-\$\{c\}\$\{off \? " off" : ""\}`\}>\s*<Checkbox checked=\{!off\} onChange=\{\(\) => toggleCat\(c\)\} \/>/);
    expect(src).toContain('<div className="ap-menu-sep" aria-hidden="true" />');
    expect(src).toContain('className="ap-menu-item cat-tools-all"');
    // ArrowDown or ArrowUp on the button opens it, as the kit's menu buttons do.
    expect(src).toMatch(/if \(e\.key !== "ArrowDown" && e\.key !== "ArrowUp"\) return;\s*e\.preventDefault\(\);\s*setOpen\(true\);/);
  });
});

describe("the legend's look (V4's Figma)", () => {
  it("draws no box: no fill, no edge, the items 2px apart on the canvas", () => {
    expect(decl(".cat-filter-bar", "background")).toBe("none");
    expect(decl(".cat-filter-bar", "border")).toBe("0");
    expect(decl(".cat-filter-bar", "gap")).toBe("2px");
    expect(decl(".cat-filter-bar", "padding")).toBe("0");
  });

  it("draws an item 24 tall with an 8px dot 6px in, 6px before a 12/16 word, 8px after it", () => {
    expect(decl(".cat-filter", "height")).toBe("var(--ctl-h-sm)");
    expect(decl(".cat-filter", "padding")).toBe("0 8px 0 6px");
    expect(decl(".cat-filter", "gap")).toBe("6px");
    expect(decl(".cat-filter", "font-size")).toBe("calc(12px + var(--ui-text-increase, 0px))");
    expect(decl(".cat-filter", "line-height")).toBe("calc(16px + var(--ui-text-increase, 0px))");
    expect(decl(".cat-filter .cat-dot", "width")).toBe("8px");
    expect(decl(".cat-filter .cat-dot", "height")).toBe("8px");
    expect(decl(".cat-filter .cat-dot", "box-sizing")).toBe("border-box");
  });

  it("shows a shown item's word in --text-secondary and a hidden one's in --text-dim beside a hollow ring", () => {
    expect(decl(".cat-filter", "color")).toBe("var(--text-secondary)");
    expect(decl(".cat-filter.off", "color")).toBe("var(--text-dim)");
    expect(decl(".cat-filter.off .cat-dot", "background")).toBe("transparent");
    expect(decl(".cat-filter.off .cat-dot", "border")).toBe("1.5px solid var(--text-dim)");
    // The ring outranks every category's fill: same weight, later in the sheet.
    expect(sheet.indexOf(".cat-filter.off .cat-dot {")).toBeGreaterThan(sheet.indexOf(".cat-filter.cat-mcp .cat-dot {"));
  });

  it("answers the pointer with the 8% pill and --text, and the keyboard with the global ring", () => {
    expect(decl(".cat-filter:hover", "background")).toBe("var(--ctl-fill)");
    expect(decl(".cat-filter:hover", "color")).toBe("var(--text)");
    // No ring of its own: the global :focus-visible ring follows the round radius.
    expect(sheet).not.toMatch(/\.cat-filter[^{,]*:focus-visible/);
    expect(decl(".cat-filter", "border-radius")).toBe("var(--r-pill)");
  });

  it("draws Show all after a 1px --line-soft rule 14 high, in the accent", () => {
    expect(decl(".cat-filter-sep", "width")).toBe("1px");
    expect(decl(".cat-filter-sep", "height")).toBe("14px");
    expect(decl(".cat-filter-sep", "background")).toBe("var(--line-soft)");
    expect(decl(".cat-filter-all", "color")).toBe("var(--accent)");
    expect(decl(".cat-filter-all", "padding")).toBe("0 8px");
    expect(decl(".cat-filter-all:hover", "background")).toBe("var(--ctl-fill)");
  });

  it("draws the folded button round on the control fill, the count in muted mono, and the menu's hidden rows like the legend's", () => {
    expect(decl(".cat-filter-tools", "height")).toBe("var(--ctl-h)");
    expect(decl(".cat-filter-tools", "border-radius")).toBe("var(--r-pill)");
    expect(decl(".cat-filter-tools", "background")).toBe("var(--bg-soft)");
    expect(decl(".cat-filter-tools", "color")).toBe("var(--text-secondary)");
    expect(decl(".cat-filter-tools", "padding")).toBe("0 8px 0 10px");
    expect(decl(".cat-tools-count", "font-family")).toBe("var(--font-mono)");
    expect(decl(".cat-tools-count", "color")).toBe("var(--muted)");
    expect(decl(".cat-tools-item.off", "color")).toBe("var(--text-dim)");
    expect(decl(".cat-tools-item.off .cat-dot", "border")).toBe("1.5px solid var(--text-dim)");
    expect(decl(".ap-menu-item.cat-tools-all", "color")).toBe("var(--accent)");
  });

  it("keeps the dot's colour and the ring's shape under a Windows Contrast theme", () => {
    const forced = read("../styles/touch-and-forced-colours.css");
    expect(forced).toMatch(/\.cat-filter \.cat-dot,\s*\.cat-tools-item \.cat-dot \{ forced-color-adjust: none; \}/);
    expect(forced).toMatch(/\.cat-filter\.off \.cat-dot,\s*\.cat-tools-item\.off \.cat-dot \{ background: Canvas; border-color: CanvasText; \}/);
  });
});

describe("the legend's words, in all ten languages", () => {
  const langs = ["en", "ro", "de", "fr", "es", "pt-BR", "ja", "ko", "zh-CN", "zh-TW"];
  it("has Show all, Tools and the count everywhere, the count naming both numbers", () => {
    for (const lang of langs) {
      const src = read(`../i18n/areas/board/${lang}.ts`);
      for (const key of ["board.cat.showAll", "board.cat.tools", "board.cat.count"]) {
        expect(src, `${lang} ${key}`).toMatch(new RegExp(`"${key.replace(/\./g, "\\.")}": "[^"]+"`));
      }
      const count = new RegExp('"board\\.cat\\.count": "([^"]+)"').exec(src)![1];
      expect(count, lang).toContain("{shown}");
      expect(count, lang).toContain("{total}");
    }
    const en = read("../i18n/areas/board/en.ts");
    expect(en).toContain('"board.cat.showAll": "Show all"');
    expect(en).toContain('"board.cat.tools": "Tools"');
    expect(en).toContain('"board.cat.count": "{shown} of {total}"');
  });
});
