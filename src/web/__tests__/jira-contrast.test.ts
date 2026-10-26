// The Jira panel's own colours, in every theme, read out of the sheet the way
// the browser cascades them. The panel draws an issue type itself when Jira's
// icon cannot be shown: a coloured tile with a mark on it. The mark was
// written white, which reads on a light theme's deep tiles and vanishes on a
// dark theme's pastel ones (1.4:1 on a story in the dark themes), and the
// epic tile was a fixed purple no theme had chosen. So the ratios are
// computed here from each theme's tokens, and a palette or rule edit that
// walks one back under its floor fails the build.
import { describe, expect, it } from "vitest";
import { declared, el, mediaApplies, selects, sheetRules, splitTop, type El } from "./sheet-cascade";
import { sheetText } from "./sheet-source";

type Rgba = [number, number, number, number];
const WIDTH = 1440;
/** WCAG 1.4.11: a mark that carries meaning, and its tile against the row. */
const NON_TEXT = 3;
/** WCAG 1.4.3: the panel's words are 11-13px. */
const BODY = 4.5;

const THEMES = [...new Set([...sheetText().matchAll(/:root\[data-theme="([\w-]+)"\]\s*\{/g)].map(m => m[1]))];
const LIGHT = new Set(["light", "white-contrast", "gruvbox-light"]);

const rootOf = (theme: string) =>
  el("html", [], { attrs: { "data-theme": theme, "data-color-scheme": LIGHT.has(theme) ? "light" : "dark" }, states: ["root"] });

/** The sheet's declarations of one property at WIDTH, one entry per selector,
 *  with the classes its last compound demands (outside any `:is()`), so the
 *  many thousand rules that name another element are passed over unread. */
const declarations = new Map<string, { selector: string; order: number; value: string; needs: string[] }[]>();
function declarationsOf(name: string) {
  let list = declarations.get(name);
  if (!list) {
    list = [];
    for (const r of sheetRules()) {
      if (!mediaApplies(r.media, WIDTH)) continue;
      const value = declared(r.body, name);
      if (value == null) continue;
      for (const selector of r.selectors) {
        let flat = selector;
        while (/\([^()]*\)/.test(flat)) flat = flat.replace(/\([^()]*\)/g, "");
        const last = flat.trim().split(/\s*[\s>+~]\s*/).pop() ?? "";
        list.push({ selector, order: r.order, value, needs: last.match(/\.[\w-]+/g)?.map(c => c.slice(1)) ?? [] });
      }
    }
    declarations.set(name, list);
  }
  return list;
}

/** What the cascade gives `name` on `chain`'s last element: specificity, then
 *  source order, as sheet-cascade's own `cascade` weighs them. */
function cascaded(chain: El[], name: string, match = (selector: string) => selects(selector, chain)): string | null {
  const own = chain[chain.length - 1].classes;
  let best: { spec: number; order: number; value: string } | null = null;
  for (const d of declarationsOf(name)) {
    if (d.needs.some(c => !own.includes(c))) continue;
    const spec = match(d.selector);
    if (spec == null) continue;
    if (!best || spec > best.spec || (spec === best.spec && d.order > best.order)) best = { spec, order: d.order, value: d.value };
  }
  return best?.value ?? null;
}

/** A property as `chain`'s last element gets it. Custom properties and
 *  `color` inherit, so a name the element does not set (or sets to
 *  `inherit`) is asked of its ancestors in turn. */
function prop(chain: El[], name: string): string | null {
  const inherits = name.startsWith("--") || name === "color";
  for (let i = chain.length; i > 0; i--) {
    const sub = chain.slice(0, i);
    const value = cascaded(sub, name);
    if (value === "inherit") continue;
    if (value != null || !inherits) return value;
  }
  return null;
}

/** `value` with every var() replaced by what `chain` gives it, or by its
 *  fallback when nothing does. */
function expand(value: string, chain: El[]): string {
  const at = value.indexOf("var(");
  if (at < 0) return value;
  let depth = 0, end = at + 3;
  for (; end < value.length; end++) {
    if (value[end] === "(") depth++;
    else if (value[end] === ")" && --depth === 0) break;
  }
  const [name, ...fallback] = splitTop(value.slice(at + 4, end));
  const found = prop(chain, name.trim()) ?? (fallback.length ? fallback.join(",") : null);
  if (found == null) throw new Error(`${name} is set nowhere on this element`);
  return expand(value.slice(0, at) + expand(found.trim(), chain) + value.slice(end + 1), chain);
}

function color(value: string, chain: El[]): Rgba {
  const v = expand(value, chain).trim();
  if (v === "transparent") return [0, 0, 0, 0];
  const hex = /^#([\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.exec(v);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, c => c + c) : hex[1];
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).concat(h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1) as Rgba;
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(v);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [parts[0], parts[1], parts[2], parts[3] ?? 1];
  }
  const mix = /^color-mix\(in srgb,\s*(.+)\)$/.exec(v);
  if (mix) {
    const [first, second] = splitTop(mix[1]);
    const part = (s: string) => {
      const m = /^(.+?)\s+([\d.]+)%$/.exec(s.trim());
      return m ? { c: color(m[1], chain), w: Number(m[2]) / 100 } : { c: color(s, chain), w: null };
    };
    const a = part(first), b = part(second);
    const wa = a.w ?? (b.w == null ? 0.5 : 1 - b.w), wb = 1 - wa;
    const alpha = a.c[3] * wa + b.c[3] * wb;
    return [0, 1, 2].map(i => alpha ? (a.c[i] * a.c[3] * wa + b.c[i] * b.c[3] * wb) / alpha : 0).concat(alpha) as Rgba;
  }
  throw new Error(`Unsupported colour: ${v}`);
}

function over(ink: Rgba, bed: Rgba): Rgba {
  return [0, 1, 2].map(i => ink[i] * ink[3] + bed[i] * (1 - ink[3])).concat(1) as Rgba;
}
function luminance(c: Rgba): number {
  const linear = c.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
}
function contrast(a: Rgba, b: Rgba): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}

const SHAPES = ["bug", "story", "task", "subtask", "epic", "other"] as const;

describe("the issue type the panel draws itself", () => {
  it("reads every theme in the sheet", () => {
    expect(THEMES).toHaveLength(12);
  });

  for (const theme of THEMES) {
    for (const shape of SHAPES) {
      it(`${theme}: a ${shape}'s mark stands off its tile, and the tile off the row`, () => {
        const root = rootOf(theme);
        const glyph = [root, el("svg", ["jr-icon", "jr-type-glyph"], { attrs: { "data-shape": shape } })];
        const panel = color("var(--panel)", [root]);
        const tileChain = [...glyph, el("rect", ["jr-glyph-tile"])];
        const markClasses = shape === "task" ? ["jr-glyph-mark", "jr-glyph-stroke"] : ["jr-glyph-mark"];
        const markChain = [...glyph, el("path", markClasses)];
        const tile = over(color(prop(tileChain, "fill")!, tileChain), panel);
        const ink = prop(markChain, shape === "task" ? "stroke" : "fill")!;
        expect(ink, "the mark is drawn in a theme colour, never a fixed one").toMatch(/^var\(/);
        const mark = over(color(ink, markChain), tile);
        expect(contrast(mark, tile)).toBeGreaterThanOrEqual(NON_TEXT);
        expect(contrast(tile, panel)).toBeGreaterThanOrEqual(NON_TEXT);
      });
    }
  }
});

/** A row of the backlog, from the panel down: `row` describes the row's own
 *  state (selected, under the pointer), `item` whether it is a parent drawn
 *  only for its sub-tasks. */
function rowChain(theme: string, row: { selected?: boolean; hover?: boolean; active?: boolean; dragging?: boolean; current?: boolean; blocked?: boolean; context?: boolean; cloud?: boolean } = {}): El[] {
  return [
    rootOf(theme),
    el("div", ["modal", "ig-modal"]),
    el("div", ["jr-panel"], { attrs: { "data-deployment": row.cloud ? "cloud" : "server" } }),
    el("div", ["jr-group-body"]),
    el("ul", ["jr-rows"]),
    el("li", ["jr-item"], { attrs: row.context ? { "data-context": "true" } : {} }),
    el("div", ["jr-row", "ig-row"], { attrs: { ...(row.selected ? { "data-selected": "true" } : {}), ...(row.dragging ? { "data-dragging": "true" } : {}), ...(row.current ? { "data-current": "true" } : {}), ...(row.blocked ? { "data-move-blocked": "true" } : {}) }, states: [...(row.hover ? ["hover"] : []), ...(row.active ? ["active"] : [])] }),
    el("button", ["jr-row-main"]),
  ];
}

/** What a word in `chain` is written on: --panel, then every fill from the
 *  row down to the word's own pill, composited. */
function bedOf(chain: El[]): Rgba {
  let bed = over(color("var(--panel)", chain.slice(0, 1)), [0, 0, 0, 1]);
  const from = chain.findIndex(e => e.classes.includes("jr-row"));
  for (let i = Math.max(from, 1); i <= chain.length; i++) {
    const fill = prop(chain.slice(0, i), "background");
    if (fill && fill !== "none") bed = over(color(fill, chain.slice(0, i)), bed);
  }
  return bed;
}

function inkOn(chain: El[]): number {
  const bed = bedOf(chain);
  return contrast(over(color(prop(chain, "color")!, chain), bed), bed);
}

/** The words a row can hold, each as the elements under the row's button. */
const WORDS: Record<string, El[]> = {
  key: [el("span", ["jr-key"])],
  summary: [el("span", ["jr-summary"])],
  version: [el("span", ["jr-facts"]), el("span", ["jr-meta"]), el("span", ["jr-version"])],
  "context tag": [el("span", ["jr-facts"]), el("span", ["jr-meta"]), el("span", ["jr-context-tag"])],
  estimate: [el("span", ["jr-facts"]), el("span", ["jr-estimate", "ig-chip"])],
  "estimate's remaining": [el("span", ["jr-facts"]), el("span", ["jr-estimate", "ig-chip"]), el("span", ["jr-remaining"])],
  ...Object.fromEntries(["new", "indeterminate", "done"].map(cat => [`status ${cat}`,
    [el("span", ["jr-facts"]), el("span", ["jr-status-cell"]), el("span", ["jr-status", "ig-chip"], { attrs: { "data-cat": cat } })]])),
};
/** Jira's epic colours, by number, as the sheet writes them for both deployments. */
const EPIC_COLOURS = Array.from({ length: 14 }, (_, i) => String(i + 1));

describe("every word on a backlog row reads, at rest, under the pointer and selected", () => {
  for (const theme of THEMES) {
    it(`${theme}: each word clears 4.5:1 on what it is written on`, () => {
      const failures: string[] = [];
      for (const [state, row] of Object.entries({ "at rest": {}, hovered: { hover: true }, selected: { selected: true }, "selected and hovered": { selected: true, hover: true } })) {
        for (const context of [false, true]) {
          for (const [word, tail] of Object.entries(WORDS)) {
            const r = inkOn([...rowChain(theme, { ...row, context }), ...tail]);
            if (r < BODY) failures.push(`${word} ${state}${context ? " (context row)" : ""}: ${r.toFixed(2)}`);
          }
        }
        for (const cloud of [false, true]) {
          for (const n of EPIC_COLOURS) {
            const r = inkOn([...rowChain(theme, { ...row, cloud }), el("span", ["jr-facts"]), el("span", ["jr-meta"]), el("span", ["jr-epic", "ig-chip"], { attrs: { "data-color": n } })]);
            if (r < BODY) failures.push(`epic ${n}${cloud ? " cloud" : ""} ${state}: ${r.toFixed(2)}`);
          }
        }
      }
      expect(failures).toEqual([]);
    });

    it(`${theme}: selected metadata drops its fill, and its marks still stand off it`, () => {
      const sel = rowChain(theme, { selected: true });
      expect(prop([...sel, ...WORDS.estimate], "background")).toBe("transparent");
      const bed = bedOf(sel);
      const flag = [...sel, el("span", ["jr-facts"]), el("span", ["jr-meta"]), el("span", ["jr-flagged"])];
      expect(contrast(over(color(prop(flag, "color")!, flag), bed), bed), "the flag").toBeGreaterThanOrEqual(NON_TEXT);
      for (const level of ["highest", "high", "medium", "low", "lowest"]) {
        const glyph = [...sel, el("svg", ["jr-icon", "jr-priority-glyph"], { attrs: { "data-level": level } })];
        expect(contrast(over(color(prop(glyph, "color")!, glyph), bed), bed), `priority ${level}`).toBeGreaterThanOrEqual(NON_TEXT);
      }
    });
  }
});

describe("workflow status and current detail remain independent of batch state", () => {
  for (const theme of THEMES) {
    it(`${theme}: all three statuses retain distinct opaque beds and 4.5:1 words through selection, hover and press`, () => {
      const beds = ["new", "indeterminate", "done"].map(cat => {
        const tail = WORDS[`status ${cat}`];
        const resting = [...rowChain(theme), ...tail];
        const fill = color(prop(resting, "background")!, resting);
        expect(fill[3], `${cat} has its own opaque bed`).toBe(1);
        for (const state of [{}, { hover: true }, { selected: true }, { selected: true, hover: true },
          { active: true }, { selected: true, active: true }, { selected: true, dragging: true, active: true }, { current: true }]) {
          const chain = [...rowChain(theme, state), ...tail];
          expect(color(prop(chain, "background")!, chain), `${cat} ${JSON.stringify(state)}`).toEqual(fill);
          expect(prop(chain, "box-shadow"), `${cat} never falls back to an outlined selected pill`).toBe("none");
          expect(inkOn(chain), `${cat} ${JSON.stringify(state)}`).toBeGreaterThanOrEqual(BODY);
        }
        return fill;
      });
      expect(new Set(beds.map(bed => JSON.stringify(bed))).size).toBe(3);
    });
    it(`${theme}: the current key reads independently of picked membership`, () => {
      for (const selected of [false, true]) {
        const key = [...rowChain(theme, { selected, current: true }), el("span", ["jr-key"])];
        expect(prop(key, "font-weight")).toBe("600");
        expect(inkOn(key)).toBeGreaterThanOrEqual(BODY);
      }
    });
    it(`${theme}: selected and dragged rows retain their batch fill while pressed`, () => {
      const row = (state: Parameters<typeof rowChain>[1]) => rowChain(theme, state).slice(0, -1);
      const selected = row({ selected: true });
      const fill = color(prop(selected, "background")!, selected);
      for (const state of [{ selected: true, active: true }, { dragging: true, active: true }, { selected: true, dragging: true, active: true }]) {
        const chain = row(state);
        expect(color(prop(chain, "background")!, chain)).toEqual(fill);
      }
    });
    it(`${theme}: checkbox selection and blocked-selection accents clear 3:1 without tinting the row`, () => {
      for (const selected of [false, true]) for (const blocked of [false, true]) {
        const row = rowChain(theme, { selected, blocked }).slice(0, -1);
        const checkbox = [...row, el("label", ["jr-pick-label"]), el("input", ["jr-pick"], { attrs: { type: "checkbox" } })];
        const bed = bedOf(row);
        const accent = prop(checkbox, "accent-color")!;
        expect(accent).toBe(blocked ? "var(--warn)" : "var(--accent)");
        expect(contrast(over(color(accent, checkbox), bed), bed)).toBeGreaterThanOrEqual(NON_TEXT);
        const plain = rowChain(theme, { selected }).slice(0, -1);
        expect(prop(row, "background")).toBe(prop(plain, "background"));
      }
    });
    it(`${theme}: the row action menu reads at rest and under the pointer`, () => {
      for (const hover of [false, true]) for (const disabled of [false, true]) {
        const chain = [rootOf(theme), el("div", ["modal", "ig-modal"]), el("div", ["jr-panel"]),
          el("div", ["jr-actions-pop"]), el("button", ["jr-action-item"], { attrs: disabled ? { "aria-disabled": "true" } : {}, states: hover ? ["hover"] : [] })];
        const panel = color("var(--panel)", chain);
        const bed = over(color(prop(chain, "background")!, chain), panel);
        expect(contrast(over(color(prop(chain, "color")!, chain), bed), bed)).toBeGreaterThanOrEqual(BODY);
        if (disabled) expect(prop(chain, "background")).toBe("transparent");
      }
      const hint = [rootOf(theme), el("div", ["modal", "ig-modal"]), el("div", ["jr-panel"]),
        el("div", ["jr-actions-pop"]), el("p", ["jr-action-hint"])];
      const bed = color("var(--panel)", hint);
      expect(contrast(over(color(prop(hint, "color")!, hint), bed), bed)).toBeGreaterThanOrEqual(BODY);
    });
  }
});

describe("the toolbar's quiet words on their fields", () => {
  for (const theme of THEMES) {
    it(`${theme}: the search placeholder and a pressed filter's word clear 4.5:1`, () => {
      const panel = over(color("var(--panel)", [rootOf(theme)]), [0, 0, 0, 1]);
      const field = [rootOf(theme), el("div", ["modal", "ig-modal"]), el("div", ["jr-panel"]), el("div", ["jr-filters"]), el("div", ["ig-search"]), el("input", ["ig-search-input"])];
      const fieldBed = over(color(prop(field, "background")!, field), panel);
      const placeholder = [...field.slice(0, -1), el("input", ["ig-search-input"], { states: ["placeholder"] })];
      const ink = cascaded(field, "color", s => /::placeholder$/.test(s) ? selects(s.replace(/::placeholder$/, ""), field) : null);
      expect(ink).not.toBeNull();
      expect(contrast(over(color(ink!, placeholder), fieldBed), fieldBed), "placeholder").toBeGreaterThanOrEqual(BODY);
      const chip = [rootOf(theme), el("div", ["modal", "ig-modal"]), el("div", ["jr-panel"]), el("button", ["btn", "jr-chip"], { attrs: { "aria-pressed": "true" } })];
      const chipBed = over(color(prop(chip, "background")!, chip), panel);
      expect(contrast(over(color(prop(chip, "color")!, chip), chipBed), chipBed), "pressed chip").toBeGreaterThanOrEqual(BODY);
    });
  }
});

/** A sprint's header, from the modal down: it sits on the modal's --bg, not
 *  on a panel, and its toggle takes a fill under the pointer. */
function headChain(theme: string): El[] {
  return [
    rootOf(theme),
    el("div", ["modal", "ig-modal"]),
    el("div", ["jr-panel"]),
    el("section", ["jr-group"]),
    el("div", ["jr-group-head"]),
  ];
}
const toggle = (hover: boolean) => [el("h3", ["jr-group-title"]), el("button", ["jr-group-toggle"], { states: hover ? ["hover"] : [] })];
const facts = [el("div", ["jr-group-facts"])];

/** What a header word is written on: --bg, then every fill from the panel
 *  down to the word's own lozenge, composited. */
function headInk(chain: El[]): number {
  let bed = over(color("var(--bg)", chain.slice(0, 1)), [0, 0, 0, 1]);
  for (let i = 3; i <= chain.length; i++) {
    const fill = prop(chain.slice(0, i), "background");
    if (fill && fill !== "none") bed = over(color(fill, chain.slice(0, i)), bed);
  }
  return contrast(over(color(prop(chain, "color")!, chain), bed), bed);
}

describe("a sprint's header reads on the modal's ground", () => {
  for (const theme of THEMES) {
    it(`${theme}: its lozenge, count, tally and named totals clear 4.5:1`, () => {
      const failures: string[] = [];
      for (const hover of [false, true]) {
        const at = hover ? " under the pointer" : "";
        for (const [word, tail] of Object.entries({
          "Active lozenge": [...toggle(hover), el("span", ["jr-badge"])],
          count: [...toggle(hover), el("span", ["jr-group-count"])],
          dates: [...toggle(hover), el("span", ["jr-group-dates"])],
        })) {
          const r = headInk([...headChain(theme), ...tail]);
          if (r < BODY) failures.push(`${word}${at}: ${r.toFixed(2)}`);
        }
      }
      const tally = headInk([...headChain(theme), ...facts, el("span", ["jr-tally"])]);
      if (tally < BODY) failures.push(`tally: ${tally.toFixed(2)}`);
      for (const cat of [null, "new", "indeterminate", "done"]) {
        const total = el("span", ["jr-total"], { attrs: cat ? { "data-cat": cat } : {} });
        const r = headInk([...headChain(theme), ...facts, el("span", ["jr-totals"]), total]);
        if (r < BODY) failures.push(`total ${cat ?? "column"}: ${r.toFixed(2)}`);
      }
      expect(failures).toEqual([]);
    });
  }
});
