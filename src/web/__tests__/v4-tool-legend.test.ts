// The Board's tool filter. It was six accent-outlined pills inside a bordered
// box, then a quiet legend row on desktop ("● file ● shell") with a "Tools 4 of
// 6" button on a phone. CHANGED ON PURPOSE: the desktop uses the phone's
// compact button too — "Tools" while every category shows, "Tools 1 of 2"
// while some are hidden — and its menu lists each category with its colour
// dot, its name and a checkbox. A hidden category's dot goes hollow and its
// word steps down to --text-dim, so the state is a tick and a shape, not only a
// colour. The hook behind it (use-category-filter-bar.ts) is unchanged.
//
// Rendered, not only read: the filter is drawn server-side, so what each state
// puts on screen is asserted as markup.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import CategoryFilterBar from "../components/CategoryFilterBar";
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
const src = read("../components/CategoryFilterBar.tsx");

describe("the tool filter, at every width", () => {
  it("is one Tools button in a named group, and no legend row", () => {
    const html = draw([]);
    expect(html).toMatch(/^<div class="cat-filter-bar" role="group" aria-label="Filter tools by category"><button id="[^"]+-tools" type="button" class="cat-filter-tools" aria-haspopup="dialog" aria-expanded="false">/);
    expect(html).not.toMatch(/class="cat-filter[ "]/);
    expect(html).not.toContain("aria-pressed");
    expect(html).not.toContain("Show all");
    // No width switch left: the same button on a desktop and a phone.
    expect(src).not.toMatch(/useMediaQuery|LEGEND_FOLD_QUERY|max-width/);
  });

  it("says only Tools while every category shows", () => {
    expect(draw([])).toMatch(/aria-expanded="false">Tools<svg[^>]*>/);
    expect(draw([])).not.toContain("cat-tools-count");
    // A filter kept for a category that has left the board hides nothing on it.
    expect(draw(["web"])).not.toContain("cat-tools-count");
  });

  it("says how many show while some are hidden", () => {
    expect(draw(["shell", "other"])).toContain('aria-expanded="false">Tools <span class="cat-tools-count">4 of 6</span><svg');
    expect(draw(["shell"], ["file", "shell"])).toContain('Tools <span class="cat-tools-count">1 of 2</span>');
  });

  it("opens the same toggles as the kit's checkboxes in the kit's menu, with Show all under a rule", () => {
    expect(src).toMatch(/<AnchoredPopover anchorId=\{trigger\} id=\{menu\} className="ap-pop" role="dialog"/);
    expect(src).toMatch(/<label key=\{c\} className=\{`ap-menu-item cat-tools-item cat-\$\{c\}\$\{off \? " off" : ""\}`\}>\s*<Checkbox checked=\{!off\} onChange=\{\(\) => toggleCat\(c\)\} \/>\s*<span className="cat-dot" aria-hidden="true" \/>\s*<span className="cat-name">\{categoryLabel\(c, t\)\}<\/span>/);
    expect(src).toContain('<div className="ap-menu-sep" aria-hidden="true" />');
    expect(src).toContain('className="ap-menu-item cat-tools-all"');
  });

  it("opens from the keyboard as from the mouse: a press, or ArrowDown or ArrowUp", () => {
    expect(src).toMatch(/onClick=\{\(\) => setOpen\(o => !o\)\}/);
    expect(src).toMatch(/if \(e\.key !== "ArrowDown" && e\.key !== "ArrowUp"\) return;\s*e\.preventDefault\(\);\s*setOpen\(true\);/);
    expect(src).toMatch(/aria-controls=\{open \? menu : undefined\}/);
  });

  it("shows every category again through the same toggle a single item uses", () => {
    expect(src).toContain("const showAll = () => { for (const c of hiddenCats) toggleCat(c); };");
    // Focus on Show all moves to the first checkbox before the row goes.
    expect(src).toMatch(/if \(document\.activeElement === e\.currentTarget\) \{\s*e\.currentTarget\.parentElement\?\.querySelector<HTMLInputElement>\("input"\)\?\.focus\(\{ preventScroll: true \}\);\s*\}\s*showAll\(\);/);
    // The hook keeps its shape: the control changed, the filter did not.
    expect(read("../use-category-filter-bar.ts")).toContain("return { presentCats, hiddenCats, toggleCat, catBarRef, catBarOccluded };");
  });
});

describe("the tool filter's look", () => {
  it("draws no box around the button, and keeps it inside the canvas", () => {
    expect(decl(".cat-filter-bar", "background")).toBe("none");
    expect(decl(".cat-filter-bar", "border")).toBe("0");
    expect(decl(".cat-filter-bar", "padding")).toBe("0");
    expect(decl(".cat-filter-bar", "max-width")).toBe("calc(100% - 28px)");
  });

  it("draws the button round on the control fill, one line wide, the count in muted mono", () => {
    expect(decl(".cat-filter-tools", "height")).toBe("var(--ctl-h)");
    expect(decl(".cat-filter-tools", "border-radius")).toBe("var(--r-pill)");
    expect(decl(".cat-filter-tools", "background")).toBe("var(--bg-soft)");
    expect(decl(".cat-filter-tools", "color")).toBe("var(--text-secondary)");
    expect(decl(".cat-filter-tools", "padding")).toBe("0 8px 0 10px");
    // One button on one line: nothing on a 320-390px canvas scrolls sideways.
    expect(decl(".cat-filter-tools", "white-space")).toBe("nowrap");
    expect(decl(".cat-tools-count", "font-family")).toBe("var(--font-mono)");
    expect(decl(".cat-tools-count", "color")).toBe("var(--muted)");
  });

  it("draws each row's 8px dot in its category's colour, and a hidden row's word dim beside a hollow ring", () => {
    expect(decl(".cat-tools-item .cat-dot", "width")).toBe("8px");
    expect(decl(".cat-tools-item .cat-dot", "height")).toBe("8px");
    expect(decl(".cat-tools-item .cat-dot", "box-sizing")).toBe("border-box");
    expect(decl(".cat-tools-item.cat-shell .cat-dot", "background")).toBe("var(--cat-shell)");
    expect(decl(".cat-tools-item.off", "color")).toBe("var(--text-dim)");
    // The canvas sheet's rule; a Contrast theme repaints it (below), so the
    // last rule in the cascade is not this one.
    expect(body(".cat-tools-item.off .cat-dot")).toMatch(/background: transparent;\s*border: 1\.5px solid var\(--text-dim\);/);
    // The pointer lifts a hidden row's word a tier; the ring still says hidden.
    expect(decl(".cat-tools-item.off:hover", "color")).toBe("var(--text-secondary)");
    expect(decl(".ap-menu-item.cat-tools-all", "color")).toBe("var(--accent)");
  });

  it("leaves no style behind for the legend row it replaced", () => {
    expect(sheet).not.toMatch(/\.cat-filter(?![-\w])/);
    expect(sheet).not.toMatch(/\.cat-filter-(?:sep|all)\b/);
  });

  it("keeps the dot's colour and the ring's shape under a Windows Contrast theme", () => {
    const forced = read("../styles/touch-and-forced-colours.css");
    expect(forced).toMatch(/\.cat-tools-item \.cat-dot \{ forced-color-adjust: none; \}/);
    expect(forced).toMatch(/\.cat-tools-item\.off \.cat-dot \{ background: Canvas; border-color: CanvasText; \}/);
  });
});

describe("the tool filter's words, in all ten languages", () => {
  const langs = ["en", "ro", "de", "fr", "es", "pt-BR", "ja", "ko", "zh-CN", "zh-TW"];
  it("has Show all, Tools and the count everywhere, the count naming both numbers, and no legend titles", () => {
    for (const lang of langs) {
      const cat = read(`../i18n/areas/board/${lang}.ts`);
      for (const key of ["board.cat.showAll", "board.cat.tools", "board.cat.count"]) {
        expect(cat, `${lang} ${key}`).toMatch(new RegExp(`"${key.replace(/\./g, "\\.")}": "[^"]+"`));
      }
      const count = new RegExp('"board\\.cat\\.count": "([^"]+)"').exec(cat)![1];
      expect(count, lang).toContain("{shown}");
      expect(count, lang).toContain("{total}");
      // The legend items' "Show {cat} tools" / "Hide {cat} tools" went with them.
      expect(cat, lang).not.toMatch(/"board\.cat\.(show|hide)":/);
    }
    const en = read("../i18n/areas/board/en.ts");
    expect(en).toContain('"board.cat.showAll": "Show all"');
    expect(en).toContain('"board.cat.tools": "Tools"');
    expect(en).toContain('"board.cat.count": "{shown} of {total}"');
  });
});
