// The Fork look's history held to the deck's contrast floors, in both themes:
// every lane at 3:1 on the list's colour and on the two selection pills, every
// word at 4.5:1 on the bed it is drawn on (row, chip, badge), the marks at 3:1.
//
// Fork paints its lanes straight over a solid accent pill; most of its six
// colours fall under 3:1 there (orange on dark blue is 2.78:1, every light lane
// under 1.6:1). So on the selected row every line and node is drawn on a 1px
// casing in the list's own colour, and its contrast is the one it has on the
// list: that pairing, and the casing itself, are what is held here. Every
// colour is read out of the sheet, so a rule that moves a colour onto another
// bed is measured where it lands.
import { describe, expect, it } from "vitest";
import { sheetText } from "./sheet-source";

const BODY = 4.5;
const NON_TEXT = 3;
const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
const F = '.gv-wide[data-look="fork"]';

type Rgba = [number, number, number, number];
type Theme = "dark" | "light";
const themes: Theme[] = ["dark", "light"];

function tokens(theme: Theme): Record<string, string> {
  const head = theme === "dark" ? ':root,\\s*\\n:root\\[data-theme="dark"\\]' : ':root\\[data-theme="light"\\]';
  const block = new RegExp(`${head}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css);
  if (!block) throw new Error(`no ${theme} token block`);
  const out: Record<string, string> = {};
  for (const [, name, value] of block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[name] = value.trim();
  return out;
}
const TOK: Record<Theme, Record<string, string>> = { dark: tokens("dark"), light: tokens("light") };

/** The last declaration of `prop` in a top-level rule whose selector list
 *  holds `selector` exactly. */
function decl(selector: string, prop: string): string | null {
  let found: string | null = null;
  let depth = 0, start = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === "{") {
      if (depth === 0) {
        const prelude = css.slice(start, i).replace(/\s+/g, " ").trim();
        const close = css.indexOf("}", i);
        if (!prelude.startsWith("@") && prelude.split(",").map(s => s.trim()).includes(selector)) {
          const m = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`).exec(css.slice(i + 1, close));
          if (m) found = m[1].trim();
        }
      }
      depth++;
    } else if (css[i] === "}") { depth--; if (depth === 0) start = i + 1; }
  }
  return found;
}
const themed = (selector: string, prop: string, theme: Theme) =>
  (theme === "light" ? decl(`:root[data-theme="light"] ${selector}`, prop) : null) ?? decl(selector, prop);

function parseColor(v: string): Rgba {
  const s = v.trim();
  if (s === "transparent") return [0, 0, 0, 0];
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [0, 2, 4].map(i => parseInt(m![1].slice(i, i + 2), 16)).concat(1) as Rgba;
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  throw new Error(`cannot read colour ${v}`);
}

/** var() all the way down, `--lane` taken from `lane`, and color-mix in srgb. */
function resolve(value: string, theme: Theme, lane: string | null = null): Rgba {
  const v = value.trim();
  const ref = /^var\((--[\w-]+)(?:,\s*([\s\S]+))?\)$/.exec(v);
  if (ref) {
    if (ref[1] === "--lane") return resolve(lane ?? "", theme, lane);
    if (ref[1] === "--gv-forced-ink") return resolve(ref[2], theme, lane);
    const t = TOK[theme][ref[1]];
    if (t === undefined) throw new Error(`${theme}: no token ${ref[1]}`);
    return resolve(t, theme, lane);
  }
  const mix = /^color-mix\(\s*in srgb\s*,([\s\S]*)\)$/.exec(v);
  if (mix) {
    let depth = 0, cut = -1;
    for (let i = 0; i < mix[1].length; i++) {
      if (mix[1][i] === "(") depth++; else if (mix[1][i] === ")") depth--; else if (mix[1][i] === "," && depth === 0) { cut = i; break; }
    }
    const parts = [mix[1].slice(0, cut), mix[1].slice(cut + 1)].map(p => {
      const pm = /^([\s\S]*?)\s+([\d.]+)%$/.exec(p.trim());
      return pm ? { c: pm[1], p: +pm[2] } : { c: p.trim(), p: null as number | null };
    });
    const pa = parts[0].p ?? 100 - (parts[1].p ?? 50), pb = parts[1].p ?? 100 - pa;
    const [a, b] = parts.map(x => resolve(x.c, theme, lane));
    const wa = (pa / (pa + pb)) * a[3], wb = (pb / (pa + pb)) * b[3], alpha = wa + wb;
    return [0, 1, 2].map(i => (alpha ? (a[i] * wa + b[i] * wb) / alpha : 0)).concat(alpha) as Rgba;
  }
  return parseColor(v);
}

const over = (fg: Rgba, bg: Rgba): Rgba => [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1) as Rgba;
function lum(c: Rgba): number {
  const f = (x: number) => { x /= 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
const ratio = (a: Rgba, b: Rgba) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const LANES = [0, 1, 2, 3, 4, 5];
const laneVar = (n: number) => `var(--fk-lane-${n})`;
const need = (v: string | null, what: string) => { if (v === null) throw new Error(`the sheet sets no ${what}`); return v; };

/** The list and the two selection pills a row can sit on. */
const beds = (theme: Theme): Array<[string, Rgba]> => [
  ["the list", resolve(need(decl(`${F} .gv-hist`, "background"), "list colour"), theme)],
  ["the grey pill", resolve(need(decl(`${F} .fk-row.is-sel`, "background"), "grey pill"), theme)],
  ["the accent pill", resolve(need(decl(`${F} .gv-graph-scroll[data-focused] .fk-row.is-sel`, "background"), "accent pill"), theme)],
];

describe("the Fork history's lanes", () => {
  it("draws every lane at 3:1 on the list's colour", () => {
    for (const theme of themes) {
      const list = beds(theme)[0][1];
      for (const n of LANES) {
        const r = ratio(resolve(laneVar(n), theme), list);
        expect(r, `${theme} lane ${n} — ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(NON_TEXT);
      }
    }
  });

  it("paints every line and node in its lane, and the lanes in the look's tokens", () => {
    for (const n of LANES) expect(decl(`${F} [data-lane="${n}"]`, "--lane")).toBe(laneVar(n));
    expect(decl(`${F} .fk-e`, "stroke")).toBe("var(--gv-forced-ink, var(--lane))");
    expect(decl(`${F} .fk-node.is-commit`, "fill")).toBe("var(--gv-forced-ink, var(--lane))");
    expect(decl(`${F} .fk-e`, "opacity")).toBeNull();
  });

  it("casts every line and node of the selected row on the list's colour, 1px out on each side, so each keeps its 3:1 on either pill", () => {
    const line = Number(need(decl(`${F} .fk-e`, "stroke-width"), "line width"));
    const hollow = Number(need(decl(`${F} .fk-node.is-trailer`, "stroke-width"), "hollow diamond width"));
    for (const [sel, prop, min] of [
      [`${F} .fk-case .fk-e`, "stroke-width", line + 2],
      [`${F} .fk-case .fk-node.is-merge`, "stroke-width", line + 2],
      [`${F} .fk-case .fk-node.is-chevron`, "stroke-width", line + 2],
      [`${F} .fk-case .fk-node.is-trailer`, "stroke-width", hollow + 2],
      [`${F} .fk-case .fk-node.is-seen`, "stroke-width", 2],
    ] as const) expect(Number(need(decl(sel, prop), `${sel} ${prop}`)), sel).toBeGreaterThanOrEqual(min);
    for (const sel of [`${F} .fk-case .fk-e`, `${F} .fk-case .fk-node.is-merge`, `${F} .fk-case .fk-node.is-trailer`]) expect(decl(sel, "stroke"), sel).toBe("var(--fk-list)");
    for (const sel of [`${F} .fk-case .fk-node.is-commit`, `${F} .fk-case .fk-node.is-seen`]) expect(decl(sel, "fill"), sel).toBe("var(--fk-list)");
    // The casing is the list's own colour on both pills, where the lane itself
    // would not hold its floor.
    for (const theme of themes) {
      const list = beds(theme)[0][1];
      expect(resolve("var(--fk-list)", theme)).toEqual(list);
      for (const n of LANES) expect(ratio(resolve(laneVar(n), theme), list), `${theme} lane ${n} on its casing`).toBeGreaterThanOrEqual(NON_TEXT);
    }
  });

  it("draws the fold column's line at 2:1 on the list, cased on a pill like the lanes", () => {
    for (const theme of themes) {
      const list = beds(theme)[0][1];
      const fold = resolve(need(themed(`${F} .gv-hist`, "--fk-fold-ink", theme), "fold ink"), theme);
      expect(ratio(fold, list), `${theme} fold`).toBeGreaterThanOrEqual(2);
    }
    expect(decl(`${F} .fk-case .fk-fold-line`, "stroke")).toBe("var(--fk-list)");
  });

  it("keeps the unpushed and unreachable dots at 3:1 on the list, ringed in the list's colour on a pill", () => {
    for (const theme of themes) {
      for (const [what, sel] of [["unpushed", `${F} .fk-dot`], ["unreachable", `${F} .fk-dot[data-kind="incoming"]`]] as const) {
        const r = ratio(resolve(need(decl(sel, "background"), `${what} dot`), theme), beds(theme)[0][1]);
        expect(r, `${theme} ${what} dot — ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(NON_TEXT);
      }
    }
    expect(decl(`${F} .fk-row.is-sel .fk-dot`, "box-shadow")).toBe("0 0 0 1px var(--fk-list)");
  });
});

describe("the Fork history's words", () => {
  it("writes subject, author, SHA and date in the row's own colour, at 4.5:1 on every bed, muted or not", () => {
    for (const sel of [`${F} .fk-cell-sha`, `${F} .fk-cell-date`, `${F} .fk-author-name`, `${F} .fk-subj`]) expect(decl(sel, "color"), sel).toBeNull();
    for (const theme of themes) {
      const [[, list], [, grey], [, accent]] = beds(theme);
      const pairs: Array<[string, Rgba, Rgba]> = [
        ["a row", resolve(need(decl(`${F} .fk-row`, "color"), "row ink"), theme), list],
        ["a row HEAD cannot reach", resolve(need(decl(`${F} .fk-row[data-tone="off"]`, "color"), "muted ink"), theme), list],
        ["the selected row, list unfocused", resolve(need(decl(`${F} .fk-row.is-sel`, "color"), "grey pill ink"), theme), grey],
        ["the selected row, list focused", resolve(need(decl(`${F} .gv-graph-scroll[data-focused] .fk-row.is-sel`, "color"), "accent pill ink"), theme), accent],
        ["the older-commits line", resolve(need(decl(`${F} .fk-older`, "color"), "older ink"), theme), list],
        ["no commits yet", resolve(need(decl(`${F} .fk-empty`, "color"), "empty ink"), theme), list],
      ];
      for (const [what, ink, bed] of pairs) {
        const r = ratio(ink, bed);
        expect(r, `${theme} ${what} — ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(BODY);
      }
    }
  });

  it("draws ↩ at 3:1 on the list and on both pills", () => {
    for (const theme of themes) {
      const [[, list], [, grey], [, accent]] = beds(theme);
      const mark = resolve(need(decl(`${F} .fk-ret`, "color"), "return mark"), theme);
      const onAccent = over(resolve(need(decl(`${F} .gv-graph-scroll[data-focused] .fk-row.is-sel .fk-ret`, "color"), "return mark on accent"), theme), accent);
      for (const [what, r] of [["list", ratio(mark, list)], ["grey pill", ratio(mark, grey)], ["accent pill", ratio(onAccent, accent)]] as const) {
        expect(r, `${theme} ↩ on the ${what} — ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(NON_TEXT);
      }
    }
  });

  it("keeps a badge's words at 4.5:1 on its own fill in every lane, and a neutral badge's on its grey", () => {
    for (const theme of themes) {
      const list = beds(theme)[0][1];
      for (const n of LANES) {
        const fill = over(resolve(need(themed(`${F} .fk-ref`, "--fk-ref-fill", theme), "badge fill"), theme, laneVar(n)), list);
        const ink = resolve(need(themed(`${F} .fk-ref`, "--fk-ref-ink", theme), "badge ink"), theme, laneVar(n));
        const r = ratio(ink, fill);
        expect(r, `${theme} lane ${n} badge — ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(BODY);
        const cell = ratio(resolve("var(--fk-ref-cell-ink)", theme), resolve("var(--fk-ref-cell)", theme));
        expect(cell, `${theme} remote cloud`).toBeGreaterThanOrEqual(NON_TEXT);
      }
      const neutral = `${F} .fk-ref[data-tone="neutral"]`;
      const more = ratio(resolve(need(decl(neutral, "color"), "neutral ink"), theme), resolve(need(decl(neutral, "background"), "neutral fill"), theme));
      expect(more, `${theme} a neutral badge (+N, the Commit tab's refs)`).toBeGreaterThanOrEqual(BODY);
    }
  });

  it("keeps the agent chip's name at 4.5:1 on its own wash, on every row it can be on", () => {
    for (const theme of themes) {
      const [[, list], [, grey], [, accent]] = beds(theme);
      const fill = (sel: string) => need(themed(sel, "--fk-chip-fill", theme), `${sel} chip fill`);
      const chip = (sel: string, bed: Rgba) => over(resolve(fill(sel), theme), bed);
      const base = `${F} .fk-chip`;
      const focused = `${F} .gv-graph-scroll[data-focused] .fk-row.is-sel .fk-chip`;
      const ink = (sel: string) => resolve(need(themed(sel, "color", theme), `${sel} colour`), theme);
      const rowInk = (sel: string) => resolve(need(decl(sel, "color"), sel), theme);
      const pairs: Array<[string, Rgba, Rgba]> = [
        ["a seen chip", ink(base), chip(base, list)],
        ["a trailer chip", ink(`${base}[data-level="trailer"]`), chip(base, list)],
        ["another session's chip", ink(`${base}[data-quiet]`), chip(`${base}[data-quiet]`, list)],
        ["a chip on a row HEAD cannot reach", ink(`${F} .fk-row[data-tone="off"]:not(.is-sel) .fk-chip`), chip(base, list)],
        // On the grey pill the chip takes the row's words.
        ["a chip on the grey pill", rowInk(`${F} .fk-row.is-sel`), chip(base, grey)],
        ["a chip on the accent pill", ink(focused), chip(focused, accent)],
      ];
      expect(decl(`${F} .fk-row.is-sel .fk-chip`, "color")).toBe("inherit");
      for (const [what, i, bed] of pairs) {
        const r = ratio(i, bed);
        expect(r, `${theme} ${what} — ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(BODY);
      }
    }
  });

  it("writes the agent's cards in the look's own words on its raised surface", () => {
    for (const theme of themes) {
      const bed = resolve(need(decl('.gv-pop[data-look="fork"]', "background"), "card surface"), theme);
      for (const sel of ['.gv-pop[data-look="fork"] .gv-pop-head', '.gv-pop[data-look="fork"] .gv-pop-line', '.gv-pop[data-look="fork"] .gv-pop-dl dt']) {
        const r = ratio(resolve(need(decl(sel, "color"), sel), theme), bed);
        expect(r, `${theme} ${sel} — ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(BODY);
      }
    }
  });
});
