// The git view's Fork look holds the deck's contrast floors with its own
// colours (tokens.css, --fk-*): words at 4.5:1 on the surface they sit on,
// marks and lines at 3:1, in both themes. Fork's own colours miss a floor in a
// few places; there the token is the floor-safe value, and this file is what
// keeps a later palette edit from walking one back. Computed from the token
// blocks themselves, as contrast-floors.test.ts does for the deck look.
import { describe, expect, it } from "vitest";
import { sheetText } from "./sheet-source";

const css = sheetText();
const BODY = 4.5;
const NON_TEXT = 3;
type Theme = "dark" | "light";
type Rgba = [number, number, number, number];
const THEMES: Theme[] = ["dark", "light"];

function block(theme: Theme): Record<string, string> {
  const head = theme === "dark" ? /:root,\s*\n:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/ : /:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/;
  const m = head.exec(css);
  if (!m) throw new Error(`no ${theme} token block`);
  const out: Record<string, string> = {};
  for (const [, name, value] of m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[name] = value.trim();
  return out;
}
const TOK: Record<Theme, Record<string, string>> = { dark: block("dark"), light: block("light") };

function parse(input: string): Rgba {
  const s = input.trim();
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  if (fn) return [+fn[1], +fn[2], +fn[3], fn[4] === undefined ? 1 : +fn[4]];
  const hex = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(s);
  if (!hex) throw new Error(`unparseable colour: ${input}`);
  const h = hex[1].length === 3 ? hex[1].replace(/./g, c => c + c) : hex[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
}

/** The two operands of a color-mix(), split at the comma outside any nesting. */
function operands(inner: string): Array<{ colour: string; pct: number | null }> {
  const parts: string[] = [];
  let depth = 0, from = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "(") depth++;
    else if (inner[i] === ")") depth--;
    else if (inner[i] === "," && depth === 0) { parts.push(inner.slice(from, i)); from = i + 1; }
  }
  parts.push(inner.slice(from));
  return parts.map(p => {
    const m = /^([\s\S]*?)\s+([\d.]+)%$/.exec(p.trim());
    return m ? { colour: m[1].trim(), pct: +m[2] } : { colour: p.trim(), pct: null };
  });
}

/** var() all the way down, color-mix() in srgb, and `--lane` (set per row) as given. */
function resolve(value: string, theme: Theme, lane = "#000000"): Rgba {
  const v = value.trim();
  if (v === "transparent") return [0, 0, 0, 0];
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref) {
    if (ref[1] === "--lane") return resolve(lane, theme, lane);
    const t = TOK[theme][ref[1]];
    if (t === undefined) throw new Error(`${ref[1]} is not declared in ${theme}`);
    return resolve(t, theme, lane);
  }
  const mix = /^color-mix\(\s*in srgb\s*,([\s\S]*)\)$/.exec(v);
  if (mix) {
    const [a, b] = operands(mix[1]);
    const pa = a.pct ?? (b.pct === null ? 50 : 100 - b.pct);
    const pb = b.pct ?? 100 - pa;
    const ca = resolve(a.colour, theme, lane), cb = resolve(b.colour, theme, lane);
    const wa = (pa / (pa + pb)) * ca[3], wb = (pb / (pa + pb)) * cb[3], alpha = wa + wb;
    const rgb = [0, 1, 2].map(i => (alpha === 0 ? 0 : (ca[i] * wa + cb[i] * wb) / alpha));
    return [rgb[0], rgb[1], rgb[2], alpha];
  }
  return parse(v);
}
const over = (fg: Rgba, bg: Rgba): Rgba => [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1) as Rgba;
const luminance = (c: Rgba) => {
  const f = (x: number) => { const s = x / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
/** The ratio of `fg` drawn over `bg`, `bg` itself over `under` (a translucent
 *  hover over the toolbar, say). */
function ratio(fg: string, bg: string, theme: Theme, { lane, under }: { lane?: string; under?: string } = {}): number {
  const base = under ? over(resolve(under, theme, lane), [255, 255, 255, 1]) : ([255, 255, 255, 1] as Rgba);
  const b = over(resolve(bg, theme, lane), base);
  const f = over(resolve(fg, theme, lane), b);
  const [hi, lo] = [luminance(f), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const v = (name: string) => `var(--fk-${name})`;
const LANES = [0, 1, 2, 3, 4, 5].map(i => v(`lane-${i}`));

/** Each word the Fork look writes, on every surface it is written on. */
const WORDS: Array<[fg: string, bg: string, under?: string]> = [
  ...["list", "chrome", "inspector", "tree", "diff", "raised", "banner"].map(bg => [v("text"), v(bg)] as [string, string]),
  [v("text-strong"), v("field")], [v("branch-line"), v("field")],
  ...["list", "chrome", "inspector", "diff", "banner"].map(bg => [v("text-2"), v(bg)] as [string, string]),
  [v("text-muted"), v("list")],
  [v("chrome-label"), v("chrome")], [v("chrome-label"), v("tool-hover"), v("chrome")],
  // A pressed tool lifts its word to --fk-text: the press fill takes the label under 4.5:1 in dark.
  [v("text"), v("tool-press"), v("chrome")],
  [v("tab-ink"), v("inspector-bar")], [v("tab-ink-active"), v("inspector-pill")], [v("text"), v("inspector-bar")],
  [v("sidebar-text"), v("sidebar")], [v("sidebar-text"), v("sidebar-select")], [v("sidebar-count"), v("sidebar")],
  [v("sidebar-dim"), v("sidebar")], [v("sidebar-dim"), v("sidebar-field")],
  [v("link"), v("inspector")], [v("link"), v("banner")],
  [v("select-ink"), v("select")], [v("select-idle-ink"), v("select-idle")],
  [v("ref-neutral-ink"), v("ref-neutral-fill")],
];

/** Each mark and line it draws, on its surface. */
const MARKS: Array<[fg: string, bg: string, under?: string]> = [
  ...LANES.map(l => [l, v("list")] as [string, string]),
  [v("chrome-icon"), v("chrome")], [v("chrome-icon"), v("tool-hover"), v("chrome")],
  [v("sidebar-glyph"), v("sidebar")], [v("sidebar-glyph-sel"), v("sidebar-select")], [v("sidebar-check"), v("sidebar")],
  [v("warn"), v("sidebar")], [v("warn"), v("sidebar-select")],
  [v("return-mark"), v("list")], [v("unpushed-dot"), v("list")], [v("incoming-dot"), v("list")],
  [v("ref-cell-ink"), v("ref-cell")], [v("ref-neutral-edge"), v("list")],
  [v("scroll-thumb"), v("list")], [v("scroll-thumb-hover"), v("list")],
];

describe("the Fork look's words hold 4.5:1 on what they are written on", () => {
  for (const theme of THEMES) {
    it(`in ${theme}`, () => {
      for (const [fg, bg, under] of WORDS) expect(ratio(fg, bg, theme, { under }), `${fg} on ${bg}`).toBeGreaterThanOrEqual(BODY);
    });
  }
});

describe("its marks and lines hold 3:1", () => {
  for (const theme of THEMES) {
    it(`in ${theme}`, () => {
      for (const [fg, bg, under] of MARKS) expect(ratio(fg, bg, theme, { under }), `${fg} on ${bg}`).toBeGreaterThanOrEqual(NON_TEXT);
    });
  }

  it("keeps the light lanes floor-safe: Fork's own light yellow is 1.65:1 on white", () => {
    expect(ratio("#ebc644", "#ffffff", "light")).toBeLessThan(NON_TEXT);
    expect(ratio(v("lane-1"), v("list"), "light")).toBeGreaterThanOrEqual(NON_TEXT);
  });
});

describe("its ref badges", () => {
  for (const theme of THEMES) {
    it(`write their names at 4.5:1 or more on their own fill, and draw an edge that stands off the list, in ${theme}`, () => {
      for (const lane of LANES) {
        expect(ratio(v("ref-ink"), v("ref-fill"), theme, { lane }), `${lane} badge`).toBeGreaterThanOrEqual(theme === "dark" ? 7.5 : BODY);
        expect(ratio(v("ref-edge"), v("list"), theme, { lane }), `${lane} edge`).toBeGreaterThanOrEqual(NON_TEXT);
      }
    });
  }
});

describe("its diff", () => {
  for (const theme of THEMES) {
    it(`numbers its lines, heads its hunks and signs its changes legibly, in ${theme}`, () => {
      for (const fg of ["diff-ln", "diff-hunk-ink", "diff-sign-add", "diff-sign-del"]) {
        expect(ratio(v(fg), v("diff"), theme), fg).toBeGreaterThanOrEqual(BODY);
      }
    });

    it(`keeps its row tints quiet against the pane, as the deck's diff does, in ${theme}`, () => {
      for (const tint of ["diff-add", "diff-del"]) expect(ratio(v(tint), v("diff"), theme), tint).toBeLessThan(NON_TEXT);
    });

    it(`colours code on unchanged lines at 4.5:1, in ${theme}`, () => {
      for (const tone of ["syn-kw", "syn-str", "syn-com", "syn-mod"]) expect(ratio(v(tone), v("diff"), theme), tone).toBeGreaterThanOrEqual(BODY);
    });

    it(`writes changed lines and their changed words at 4.5:1, in ${theme}`, () => {
      for (const bed of ["diff-add", "diff-del", "diff-add-word", "diff-del-word"]) {
        expect(ratio(v("text"), v(bed), theme), `text on ${bed}`).toBeGreaterThanOrEqual(BODY);
      }
    });
  }

  it("drops the syntax tones on changed lines in dark, where they fall under the floor, and keeps them in light", () => {
    // Which is the rule the diff follows: dark changed lines in --fk-text.
    expect(Math.min(...["syn-kw", "syn-str", "syn-com"].flatMap(t => ["diff-add", "diff-del"].map(b => ratio(v(t), v(b), "dark"))))).toBeLessThan(BODY);
    for (const tone of ["syn-kw", "syn-str", "syn-com", "syn-mod"]) {
      for (const bed of ["diff-add", "diff-del", "diff-add-word", "diff-del-word"]) {
        expect(ratio(v(tone), v(bed), "light"), `${tone} on ${bed}`).toBeGreaterThanOrEqual(BODY);
      }
    }
  });
});

describe("every Fork token is declared for both themes", () => {
  it("names the same --fk-* set in the dark and the light block", () => {
    const names = (t: Theme) => Object.keys(TOK[t]).filter(n => n.startsWith("--fk-")).sort();
    expect(names("dark").length).toBeGreaterThan(100);
    expect(names("light")).toEqual(names("dark"));
  });
});
