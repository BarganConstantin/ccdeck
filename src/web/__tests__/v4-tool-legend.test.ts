// The Board's tool filter. It was six accent-outlined pills inside a bordered
// box, then a quiet legend row on desktop ("● file ● shell") with a "Tools 4 of
// 6" button on a phone. CHANGED ON PURPOSE: the desktop uses the phone's
// compact button too — "Tools" while every category shows, "Tools 1 of 2"
// while some are hidden — and its menu lists each category with its colour
// dot, its name and a checkbox. A hidden category's dot goes hollow and its
// word steps down to --text-dim, so the state is a tick and a shape, not only a
// colour. The hook behind it (use-category-filter-bar.ts) is unchanged.
//
// CHANGED ON PURPOSE (V4 top-10 #5): the "Tools" button floating over the
// canvas's top left → the rows are the last group of the canvas bar's ⋯ "More
// actions" menu, under a "Tool calls" heading, and ⋯ carries a dot (and says so
// in its name) while calls on the board are hidden, which is what "Tools 1 of
// 2" said. The rows, their dots, their checkboxes and Show all are unchanged;
// the hook lost only the occlusion measuring a floating bar needed.
//
// Rendered, not only read: the filter is drawn server-side, so what each state
// puts on screen is asserted as markup.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import CategoryFilterBar from "../components/CategoryFilterBar";
import { toolFilterActive, toolFilterShown } from "../components/CanvasControls";
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
// CHANGED ON PURPOSE (V4 top-10 #5): catBarRef and catBarOccluded → headId, because
// the rows are a group of the ⋯ menu named by its heading, and nothing floats.
function draw(hidden: DetailCategory[], present: DetailCategory[] = SIX): string {
  return renderToStaticMarkup(createElement(CategoryFilterBar, {
    headId: "tools-head",
    presentCats: present,
    hiddenCats: new Set(hidden),
    toggleCat: () => {},
  }));
}
const src = read("../components/CategoryFilterBar.tsx");
const controls = read("../components/CanvasControls.tsx");

describe("the tool filter, at every width", () => {
  it("is one Tools button in a named group, and no legend row", () => {
    // CHANGED ON PURPOSE (V4 top-10 #5): a group named "Filter tools by category"
    // around a Tools button → a group named by its visible "Tool calls" heading,
    // its rows straight under it, in the ⋯ menu.
    const html = draw([]);
    expect(html).toMatch(/^<div role="group" aria-labelledby="tools-head" class="cat-tools-group"><div id="tools-head" class="cat-tools-head">Tool calls<\/div><label class="ap-menu-item cat-tools-item cat-file">/);
    expect(html).not.toMatch(/class="cat-filter[ "-]/);
    expect(html).not.toContain("aria-pressed");
    expect(html).not.toContain("Show all");
    // No width switch left: the same rows on every width the canvas is drawn at.
    expect(src).not.toMatch(/useMediaQuery|LEGEND_FOLD_QUERY|max-width/);
  });

  it("says only Tools while every category shows", () => {
    // CHANGED ON PURPOSE (V4 top-10 #5): "Tools" with no count → ⋯ with no dot and
    // its plain name, More actions, and every row ticked.
    const none = new Set<DetailCategory>();
    expect(toolFilterActive(SIX, none)).toBe(false);
    expect((draw([]).match(/checked=""/g) ?? [])).toHaveLength(6);
    // A filter kept for a category that has left the board hides nothing on it.
    expect(toolFilterActive(SIX, new Set<DetailCategory>(["web"]))).toBe(false);
    expect(controls).toContain('const name = filtered ? t("board.controls.moreFiltered") : t("accounts.row.more");');
  });

  it("says how many show while some are hidden", () => {
    // CHANGED ON PURPOSE (V4 top-10 #5): "Tools 4 of 6" → ⋯ carries its dot and the
    // name "More actions — some tool calls are hidden", and the rows say which:
    // four ticked, two unticked with a hollow dot.
    expect(toolFilterActive(SIX, new Set<DetailCategory>(["shell", "other"]))).toBe(true);
    const html = draw(["shell", "other"]);
    expect((html.match(/checked=""/g) ?? [])).toHaveLength(4);
    expect(html).toContain('class="ap-menu-item cat-tools-item cat-shell off"');
    expect(html).toContain('class="ap-menu-item cat-tools-item cat-other off"');
    expect(toolFilterActive(["file", "shell"], new Set<DetailCategory>(["shell"]))).toBe(true);
    expect(controls).toContain("const filtered = filter != null && toolFilterActive(presentCats, hiddenCats);");
    expect(controls).toContain('{filtered && <span className="canvas-more-dot" aria-hidden />}');
  });

  it("opens the same toggles as the kit's checkboxes in the kit's menu, with Show all under a rule", () => {
    // CHANGED ON PURPOSE (V4 top-10 #5): its own popover (role="dialog") → the ⋯
    // menu's last group, under a rule, each checkbox a menuitemcheckbox the menu's
    // arrows walk; the group shows under #783's rule (toolFilterShown).
    expect(controls).toMatch(/<AnchoredPopover anchorId=\{CANVAS_MORE_ID\} id=\{CANVAS_MORE_MENU_ID\} className="ap-pop canvas-more-pop" role="menu"/);
    expect(controls).toMatch(/\{filter && \(\s*<>\s*<div role="separator" className="ap-menu-sep" \/>\s*<CategoryFilterBar headId=\{headId\}/);
    expect(src).toMatch(/<label key=\{c\} className=\{`ap-menu-item cat-tools-item cat-\$\{c\}\$\{off \? " off" : ""\}`\}>\s*(?:\{[^}]*\}\s*)?<Checkbox role="menuitemcheckbox" checked=\{!off\} onChange=\{\(\) => toggleCat\(c\)\}[\s\S]*?\/>\s*<span className="cat-dot" aria-hidden="true" \/>\s*<span className="cat-name">\{categoryLabel\(c, t\)\}<\/span>/);
    const hidden = draw(["shell"]);
    expect(hidden).toContain('<div role="separator" class="ap-menu-sep"></div><button type="button" role="menuitem" class="ap-menu-item cat-tools-all">Show all</button>');
    expect(hidden).toMatch(/<input type="checkbox" role="menuitemcheckbox"/);
    expect(toolFilterShown(["file"], new Set())).toBe(false);
    expect(toolFilterShown(SIX, new Set())).toBe(true);
  });

  it("opens from the keyboard as from the mouse: a press, or ArrowDown or ArrowUp", () => {
    // CHANGED ON PURPOSE (V4 top-10 #5): the Tools button's open state → ⋯'s, which
    // opens at the first row on a press or ArrowDown and at the last on ArrowUp.
    expect(controls).toContain('onClick={() => setMenu(open ? null : "first")}');
    expect(controls).toMatch(/if \(e\.key !== "ArrowDown" && e\.key !== "ArrowUp"\) return;\s*e\.preventDefault\(\);\s*setMenu\(e\.key === "ArrowUp" \? "last" : "first"\);/);
    expect(controls).toMatch(/aria-controls=\{open \? CANVAS_MORE_MENU_ID : undefined\}/);
    expect(controls).toContain('aria-haspopup="menu"');
  });

  it("shows every category again through the same toggle a single item uses", () => {
    expect(src).toContain("const showAll = () => { for (const c of hiddenCats) toggleCat(c); };");
    // Focus on Show all moves to the first checkbox before the row goes.
    expect(src).toMatch(/if \(document\.activeElement === e\.currentTarget\) \{\s*e\.currentTarget\.parentElement\?\.querySelector<HTMLInputElement>\("input"\)\?\.focus\(\{ preventScroll: true \}\);\s*\}\s*showAll\(\);/);
    // The hook keeps its shape: the control changed, the filter did not.
    // CHANGED ON PURPOSE (V4 top-10 #5): catBarRef and catBarOccluded left the
    // hook's return with the floating bar they measured.
    expect(read("../use-category-filter-bar.ts")).toContain("return { presentCats, hiddenCats, toggleCat };");
  });
});

describe("the tool filter's look", () => {
  it("draws no box around the button, and keeps it inside the canvas", () => {
    // CHANGED ON PURPOSE (V4 top-10 #5): a boxless bar kept 28px inside the canvas →
    // no bar; the menu that holds the rows is never wider than the window.
    expect(() => body(".cat-filter-bar")).toThrow(/no rule/);
    expect(decl(".ap-pop.canvas-more-pop", "max-width")).toBe("calc(100vw - 16px)");
    expect(decl(".cat-tools-group", "flex-direction")).toBe("column");
  });

  it("draws the button round on the control fill, one line wide, the count in muted mono", () => {
    // CHANGED ON PURPOSE (V4 top-10 #5): a round Tools pill with a mono count → ⋯,
    // a square button of the canvas bar like its neighbours, with a 6px accent dot
    // on its corner while calls are hidden, and a muted 12px heading over the rows.
    expect(() => body(".cat-filter-tools")).toThrow(/no rule/);
    expect(() => body(".cat-tools-count")).toThrow(/no rule/);
    expect(controls).toMatch(/<ControlButton\s+id=\{CANVAS_MORE_ID\}\s+className="canvas-more"/);
    // The canvas sheet's rule; a Contrast theme repaints it in the highlight
    // (below), so the last rule in the cascade is not this one.
    expect(body(".canvas-more-dot")).toMatch(/background: var\(--accent\);/);
    expect(decl(".cat-tools-head", "color")).toBe("var(--muted)");
    expect(decl(".cat-tools-head", "font-size")).toBe("calc(12px + var(--ui-text-increase, 0px))");
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
    // And ⋯'s dot, which says calls are hidden, in the highlight.
    expect(forced).toMatch(/\.canvas-more-dot \{ forced-color-adjust: none; background: Highlight; \}/);
  });
});

describe("the tool filter's words, in all ten languages", () => {
  const langs = ["en", "ro", "de", "fr", "es", "pt-BR", "ja", "ko", "zh-CN", "zh-TW"];
  it("has Show all, Tools and the count everywhere, the count naming both numbers, and no legend titles", () => {
    // CHANGED ON PURPOSE (V4 top-10 #5): Tools, its "{shown} of {total}" count and the
    // group's "Filter tools by category" → gone with the button, and every catalog
    // has the heading ("Tool calls", the detail panel's) and ⋯'s filtered name.
    for (const lang of langs) {
      const cat = read(`../i18n/areas/board/${lang}.ts`);
      for (const key of ["board.cat.showAll", "board.detail.toolCalls", "board.controls.moreFiltered"]) {
        expect(cat, `${lang} ${key}`).toMatch(new RegExp(`"${key.replace(/\./g, "\\.")}": "[^"]+"`));
      }
      expect(cat, lang).not.toMatch(/"board\.cat\.(tools|count|filter)":/);
      // The legend items' "Show {cat} tools" / "Hide {cat} tools" went with them.
      expect(cat, lang).not.toMatch(/"board\.cat\.(show|hide)":/);
    }
    const en = read("../i18n/areas/board/en.ts");
    expect(en).toContain('"board.cat.showAll": "Show all"');
    expect(en).toContain('"board.detail.toolCalls": "Tool calls"');
    expect(en).toContain('"board.controls.moreFiltered": "More actions — some tool calls are hidden"');
  });
});
