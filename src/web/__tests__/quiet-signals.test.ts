// #368: five signals drawn quieter than the job they were given, all of them on
// a surface the user reads when something has already gone wrong.
//
//   1. `.cat-filter.off` faded the whole chip to `opacity: 0.38` — 1.72:1 in
//      dark, 1.87:1 on white — and its hover only reached 3.51:1 in dark. Once
//      two categories are hidden, the bar whose entire job is to say what the
//      canvas is not showing could not say which.
//   2. `.qb-pace-marker` is drawn INSIDE the fill whenever the user is in
//      deficit, because deficit means actual > expected. Its --err against the
//      fill is 1.14:1 on --accent, 1.32:1 on --warn and 1.00:1 once the limit
//      is reached and the fill is --err too. The black halo it leaned on is
//      2.12:1 over light's --err.
//   3. `.up-quota-hint code` and `.ver-cmd-hint` inherit a dim foreground
//      budgeted against --panel and then paint --line under it, which spends
//      the whole budget: 4.14:1 / 3.62:1 and 4.14:1, under AA at 10-10.5px.
//      The first is the CLI command that makes the quota section work at all.
//   4. `.tool-spark-bar` idle was --muted-dim at 2.45:1 in dark, and the counts
//      it draws live only in a title — no adjacent number, so 1.4.11's
//      redundancy exception does not reach it.
//   5. `.search input` set `outline: none` at (0,1,1) on a rule that also
//      carries layout, beating the global `:focus-visible` at (0,1,0) on
//      specificity and on source order. `/` focuses that field.
//
// Plain node, no DOM — so this reads styles.css and QuotaBar.tsx the way
// contrast-floors.test.ts, control-edges.test.ts and manage-block.test.ts do
// and computes the ratios from the sheet's own token values. The helpers are
// deliberately re-declared here rather than imported from contrast-floors:
// importing a *.test.ts registers its suites into this file as well. The
// gradient reader is the exception — `./gradient-stops` is a plain module that
// declares no suites, so the five files reading the same two gradient tokens
// can share one grammar and one failure message (#664, #665).
//
// Three of the numbers the report quoted were measured against --panel where
// the real bed is something else, so the floors below are this file's own
// arithmetic: --muted on the chip bar is 4.80:1 dark / 7.67:1 light (not
// 4.70 / 7.87), and --text on --line is 11.39:1 / 11.86:1 (not 11.34 / 15.5).
// Same conclusions, different beds. The report's suggested `opacity: 0.75`
// floor for the chip is wrong outright and pinned as wrong below.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { gradientStops } from "./gradient-stops";
import { sheetText } from "./sheet-source";

const web = fileURLToPath(new URL("..", import.meta.url));
/** Comments quote declarations while explaining them; strip before reading. */
const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
// The quota bar, lifted out of UsagePanel.tsx with the fill and the marker it colours.
const quotaBar = readFileSync(join(web, "components", "QuotaBar.tsx"), "utf8");

/** WCAG 1.4.3 for the words, 1.4.11 for a meter, a boundary or a focus ring. */
const BODY = 4.5;
const NON_TEXT = 3;

type Rgba = [number, number, number, number];

function parseColor(input: string): Rgba {
  const s = input.trim();
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  if (fn) return [+fn[1], +fn[2], +fn[3], fn[4] === undefined ? 1 : +fn[4]];
  if (s === "transparent") return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (!hex) throw new Error(`unparseable colour: ${input}`);
  const h = hex[1].length === 3 ? hex[1].replace(/./g, c => c + c) : hex[1];
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), a];
}

/** Source-over compositing, non-premultiplied, onto an already-opaque backdrop. */
function over(fg: Rgba, bg: Rgba): Rgba {
  const a = fg[3];
  return [0, 1, 2].map(i => fg[i] * a + bg[i] * (1 - a)).concat(1) as Rgba;
}

function relativeLuminance(c: Rgba): number {
  const [r, g, b] = [c[0], c[1], c[2]].map(v => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x relative-luminance ratio. Both arguments must already be opaque. */
function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** A CSS `opacity` composites the whole element — its words with it — onto the
 *  bed. That is the mechanism behind failures 1 and 4, so it gets a name. */
function faded(fg: Rgba, alpha: number, bed: Rgba): Rgba {
  return over([fg[0], fg[1], fg[2], fg[3] * alpha], bed);
}

/** The declarations of the first rule whose selector starts a line verbatim. */
function rule(selector: string): string | null {
  const re = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m");
  const m = re.exec(css);
  return m ? m[1] : null;
}

function decl(body: string | null, prop: string): string | null {
  if (body === null) return null;
  const m = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`, "m").exec(body);
  return m ? m[1].trim() : null;
}

const declOf = (selector: string, prop: string) => decl(rule(selector), prop);

const themes = ["dark", "light"] as const;
type Theme = (typeof themes)[number];

function tokens(theme: Theme): Record<string, string> {
  const head = theme === "dark" ? ":root,\\s*\\n:root\\[data-theme=\"dark\"\\]" : ":root\\[data-theme=\"light\"\\]";
  const block = new RegExp(`${head}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css);
  if (!block) throw new Error(`no ${theme} token block`);
  const out: Record<string, string> = {};
  for (const [, name, value] of block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[name] = value.trim();
  return out;
}

const TOK: Record<Theme, Record<string, string>> = { dark: tokens("dark"), light: tokens("light") };

/** var() one level deep, plus the color-mix form the control tokens use. */
function resolve(value: string, theme: Theme): Rgba {
  const mix = /color-mix\(in srgb,\s*var\((--[\w-]+)\)\s*([\d.]+)%,\s*transparent\)/.exec(value);
  if (mix) {
    const base = resolve(TOK[theme][mix[1]], theme);
    return [base[0], base[1], base[2], +mix[2] / 100];
  }
  const v = /^var\((--[\w-]+)\)$/.exec(value.trim());
  return parseColor(v ? TOK[theme][v[1]] : value);
}

const tok = (name: string, theme: Theme) => parseColor(TOK[theme][name]);

/** Both stops of the node gradient — a sparkline bar sits against the lower one
 *  but the row can be scrolled, so the strict reading takes the worst of the two.
 *
 *  Read by `./gradient-stops` since #665, and this file is the reason the word
 *  "vacuous" undersells what a `?? []` does here. The ratio below is a
 *  `Math.min` over these stops, and `Math.min()` of nothing is Infinity — so
 *  respelling --node-grad in a notation the old private regex could not see did
 *  not merely stop the sparkline sweep measuring, it handed one case a
 *  fabricated Infinity that sailed over its 3:1 floor and PASSED, while the case
 *  beside it failed with `expected Infinity to be less than Infinity`. Neither
 *  outcome names the token, and one of them is green. */
function nodeStops(theme: Theme): Rgba[] {
  return gradientStops("--node-grad", theme, TOK[theme]).map(s => resolve(s, theme));
}

describe("the contrast maths, checked against the two ends everybody knows", () => {
  it("puts white on black at 21:1 and a colour on itself at 1:1", () => {
    expect(contrastRatio(parseColor("#ffffff"), parseColor("#000"))).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColor("#fca5a5"), parseColor("#fca5a5"))).toBeCloseTo(1, 5);
  });

  it("agrees with the known AA boundary grey — #767676 on white is 4.54:1", () => {
    expect(contrastRatio(parseColor("#767676"), parseColor("#ffffff"))).toBeCloseTo(4.54, 2);
  });

  it("reproduces every ratio #368 reported, from the shipped values", () => {
    // The five defects restated as arithmetic, so the floors below have a
    // baseline that does not move when the tokens do.
    const darkBar = over([20, 22, 27, 0.78], parseColor("#0b0c10"));
    const lightBar = over([255, 255, 255, 0.78], parseColor("#eef1f6"));
    // 1 — the off chip, at rest and on hover, in both themes.
    expect(contrastRatio(faded(parseColor("#7e828c"), 0.38, darkBar), darkBar)).toBeCloseTo(1.72, 2);
    expect(contrastRatio(faded(parseColor("#4a5260"), 0.38, lightBar), lightBar)).toBeCloseTo(1.87, 2);
    expect(contrastRatio(faded(parseColor("#7e828c"), 0.8, darkBar), darkBar)).toBeCloseTo(3.51, 2);
    // 2 — the marker on each fill it can land in. The last one is the no-op.
    expect(contrastRatio(parseColor("#fca5a5"), parseColor("#7dd3fc"))).toBeCloseTo(1.14, 2);
    expect(contrastRatio(parseColor("#fca5a5"), parseColor("#fcd34d"))).toBeCloseTo(1.32, 2);
    expect(contrastRatio(parseColor("#b91c1c"), parseColor("#b91c1c"))).toBeCloseTo(1.00, 2);
    // 3 — a dim foreground re-bedded on --line.
    expect(contrastRatio(parseColor("#7e828c"), parseColor("#1f2229"))).toBeCloseTo(4.14, 2);
    expect(contrastRatio(parseColor("#5f6673"), parseColor("#c8cdd6"))).toBeCloseTo(3.62, 2);
    // 4 — the idle sparkline bar on the node's lower stop.
    expect(contrastRatio(parseColor("#50535b"), parseColor("#0f1116"))).toBeCloseTo(2.45, 2);
    expect(contrastRatio(parseColor("#7c8493"), parseColor("#f2f5fa"))).toBeCloseTo(3.44, 2);
    // 5 — what a keyboard user got instead of a ring: a border step and a glow.
    const lightEdge = over([13, 17, 23, 0.5], parseColor("#ffffff"));
    expect(contrastRatio(lightEdge, parseColor("#0369a1"))).toBeCloseTo(1.67, 2);
    expect(contrastRatio(over([3, 105, 161, 0.22], parseColor("#eef1f6")), parseColor("#eef1f6")))
      .toBeCloseTo(1.37, 2);
  });
});

describe("1. the tool-category chip you switched off (#368.1)", () => {
  /** What an item's word actually sits on. CHANGED ON PURPOSE (V4's Figma):
   *  the bar was a slab with a fill of its own; the legend that replaced it
   *  draws none at rest, so the bed is the canvas itself, --bg per theme. */
  function chipBar(theme: Theme): Rgba {
    expect(declOf(".cat-filter-bar", "background"), "the legend draws no slab at rest").toBe("none");
    return tok("--bg", theme);
  }

  it("carries `off` on the colour tier alone — no opacity anywhere on the chip", () => {
    // This is the regression that matters: any alpha at all puts --muted under
    // AA in dark, because it only clears it by 0.30 at full strength.
    expect(declOf(".cat-filter.off", "opacity"), "resting").toBeNull();
    // One hover rule serves both states now (V4's legend).
    expect(declOf(".cat-filter:hover", "opacity"), "hover").toBeNull();
    // And the now-dead property is gone from the chip's transition list.
    expect(declOf(".cat-filter", "transition")).not.toMatch(/opacity/);
  });

  it("reads the off label at 4.5:1 on what it sits on, in both themes", () => {
    // Composites whatever `opacity` the rule declares, because that is the
    // mechanism: the fade applied to the chip applied to its label too.
    for (const theme of themes) {
      const bed = chipBar(theme);
      const fg = resolve(declOf(".cat-filter.off", "color")!, theme);
      const alpha = +(declOf(".cat-filter.off", "opacity") ?? 1);
      expect(contrastRatio(faded(fg, alpha, bed), bed), `${theme} off chip`).toBeGreaterThanOrEqual(BODY);
    }
  });

  it("shows there is no opacity that would have worked — 0.9 is still under AA in dark", () => {
    // The report proposed `opacity: 0.75` as the floor. It is 3.23:1.
    const bed = chipBar("dark");
    // CHANGED ON PURPOSE: the off label is --text-secondary now (V4's Figma), so
    // the demonstration is pinned to the --muted label it was written about;
    // it shows that fading a label cannot reach AA, whatever the label is.
    const fg = resolve("var(--muted)", "dark");
    // CHANGED ON PURPOSE (V4's legend): measured on the bare canvas the legend
    // sits on now, not the slab it replaced, 0.75 is 3.33:1 rather than 3.23:1,
    // still nowhere near AA.
    expect(contrastRatio(faded(fg, 0.75, bed), bed)).toBeCloseTo(3.33, 2);
    expect(contrastRatio(faded(fg, 0.75, bed), bed)).toBeLessThan(BODY);
    expect(contrastRatio(faded(fg, 0.9, bed), bed)).toBeLessThan(BODY);
    expect(contrastRatio(fg, bed)).toBeGreaterThanOrEqual(BODY);
  });

  it("never lets the pointer take contrast away — off:hover is louder than off", () => {
    for (const theme of themes) {
      const bed = chipBar(theme);
      const rest = contrastRatio(resolve(declOf(".cat-filter.off", "color")!, theme), bed);
      // CHANGED ON PURPOSE (V4's legend): one hover rule lifts every item's
      // word to --text, a hidden one's too. It comes after `.off` at the same
      // weight, which is what lets it outrank the dim tier.
      const hover = contrastRatio(resolve(declOf(".cat-filter:hover", "color")!, theme), bed);
      expect(hover, `${theme} off:hover vs off`).toBeGreaterThan(rest);
    }
    expect(css.indexOf("\n.cat-filter:hover"), "the hover rule follows .off").toBeGreaterThan(css.indexOf("\n.cat-filter.off {"));
  });

  it("still reads off as the quieter of the two states, and on as fully lit", () => {
    for (const theme of themes) {
      const bed = chipBar(theme);
      const on = contrastRatio(resolve(declOf(".cat-filter", "color")!, theme), bed);
      const off = contrastRatio(resolve(declOf(".cat-filter.off", "color")!, theme), bed);
      expect(on, `${theme} on chip`).toBeGreaterThanOrEqual(BODY);
      expect(off, `${theme} off is quieter`).toBeLessThan(on);
    }
    // CHANGED ON PURPOSE (V4's legend): the channel that is not a colour is
    // the dot's shape now, a filled disc against a hollow ring, where it was a
    // strike through the name.
    expect(declOf(".cat-filter.off .cat-dot", "background")).toBe("transparent");
    expect(declOf(".cat-filter.off .cat-dot", "border")).toBe("1.5px solid var(--text-dim)");
  });
});

describe("2. the quota pace marker (#368.2)", () => {
  // The fill and the marker are coloured in the component, not the sheet, so
  // the token sets come from there — a new state added to either is caught.
  // CHANGED ON PURPOSE (compact accounts, #2539): the fill wears main's quota
  // colours for every account, --accent below 70, --warn from 70, --err from 90.
  const FILLS = [...(/export function quotaMeterColor[^{]*\{\s*return\s+([^;]+);/.exec(quotaBar)![1])
    .matchAll(/var\((--[\w-]+)\)/g)].map(m => m[1]);
  const MARKERS = [...(/className="qb-pace-marker"[\s\S]*?\/>/.exec(quotaBar)![0])
    .matchAll(/var\((--[\w-]+)\)/g)].map(m => m[1]);

  it("still draws both ends from the tokens this test knows about", () => {
    expect(new Set(FILLS)).toEqual(new Set(["--err", "--warn", "--accent"]));
    expect(new Set(MARKERS)).toEqual(new Set(["--err", "--ok"]));
  });

  it("separates with the surface, not with black", () => {
    const shadow = declOf(".qb-pace-marker", "box-shadow")!;
    expect(shadow).toBe("0 0 0 1px var(--panel)");
    expect(shadow, "a black halo is invisible on light's --err fill").not.toMatch(/rgba\(0,\s*0,\s*0/);
  });

  it("reads the ring at 3:1 against every fill the marker can land in, both themes", () => {
    // Deficit means actual > expected, so the marker is always inside the fill.
    // The ring has to be a spread of an opaque colour to be a boundary at all:
    // the old value was a 2px BLUR of a half-alpha black, which has no edge to
    // measure and, once composited, was 2.12:1 over light's --err.
    const shadow = declOf(".qb-pace-marker", "box-shadow")!;
    const spread = /^0 0 0 1px (.+)$/.exec(shadow);
    expect(spread, `${shadow} is not a 1px spread of a single colour`).not.toBeNull();
    for (const theme of themes) {
      const ring = resolve(spread![1], theme);
      expect(ring[3], `${theme} ring alpha`).toBe(1);
      for (const fill of FILLS) {
        expect(contrastRatio(ring, tok(fill, theme)), `${theme} ring on ${fill} fill`)
          .toBeGreaterThanOrEqual(NON_TEXT);
      }
    }
  });

  it("reads the ring at 3:1 against the marker it wraps, and against the empty track", () => {
    for (const theme of themes) {
      const ring = tok("--panel", theme);
      for (const marker of MARKERS) {
        expect(contrastRatio(ring, tok(marker, theme)), `${theme} ring vs ${marker} marker`)
          .toBeGreaterThanOrEqual(NON_TEXT);
      }
      // Surplus puts the marker outside the fill, on the bare track, where it
      // has to carry itself — the ring is near-invisible on --line by design.
      // CHANGED ON PURPOSE (V4's Figma): the track is --ctl-fill, a wash of the ink, over the panel.
      const track = over(resolve(TOK[theme][/^var\((--[\w-]+)\)$/.exec(declOf(".qb-track", "background")!)![1]], theme), tok("--panel", theme));
      expect(contrastRatio(tok("--ok", theme), track), `${theme} --ok marker on the track`)
        .toBeGreaterThanOrEqual(NON_TEXT);
    }
  });

  // CHANGED ON PURPOSE (V4's Figma): the track is 2 high, so it no longer clips; the tick stands
  // 2px clear above and below it (the rail is inset -2px), and the ring is a spread on all sides.
  it("lets the tick stand clear of the 2px track instead of clipping it", () => {
    expect(declOf(".qb-track", "overflow")).toBeNull();
    expect(declOf(".qb-pace-rail", "inset")).toBe("-2px 0");
  });
});

describe("3. the chips that paint --line under a dim foreground (#368.3)", () => {
  /** Every rule in the sheet that beds its own text on --line. A chip that
   *  lifts the bed has to pay for it; this finds the next one that forgets. */
  const bedded = [...css.matchAll(/^([^{}\n][^{}]*)\{([^}]*background:\s*var\(--line\)[^}]*)\}/gm)]
    .map(([, selector, body]) => ({ selector: selector.trim(), body }))
    .filter(r => decl(r.body, "color") !== null);

  it("finds the chips that do it, including the two #368 measured", () => {
    const names = bedded.map(r => r.selector);
    expect(names).toContain(".up-quota-hint code");
    // CHANGED ON PURPOSE (V4's Figma): the update banner's "copy" word chip is gone, the command box has an icon Copy, so .ver-cmd-hint no longer exists.
    expect(bedded.length).toBeGreaterThanOrEqual(4);
  });

  it("reads every one of them at 4.5:1 on that bed, in both themes", () => {
    for (const theme of themes) {
      const bed = tok("--line", theme);
      for (const { selector, body } of bedded) {
        const fg = resolve(decl(body, "color")!, theme);
        expect(contrastRatio(fg, bed), `${theme} ${selector} on --line`).toBeGreaterThanOrEqual(BODY);
      }
    }
  });

  it("leaves the paragraph around them dim — only the lifted bed pays", () => {
    // .up-quota-hint itself is --text-dim on --panel, which is 4.70:1 / 5.78:1
    // and fine. The size and the bed carry "secondary"; the fix is local to the
    // chip, not a lift of the whole hint.
    expect(declOf(".up-quota-hint", "color")).toBe("var(--text-dim)");
    for (const theme of themes) {
      expect(contrastRatio(tok("--text-dim", theme), tok("--panel", theme)), theme)
        .toBeGreaterThanOrEqual(BODY);
    }
  });
});

// 4. (the sparkline that printed its counts nowhere, #368.4) is gone with the
// chart: V4's Agent / Card draws tool-kind icons in the foot in its place, so
// there are no bars left to hold to 3:1. The icons are a glyph beside the
// cost and the clock, which print their own figures.

describe("5. one focus language, and nothing quietly opting out of it", () => {
  // This began as the search field's own ring (#368.5): `outline: none` on a
  // rule that also carried layout beat the global :focus-visible on both
  // specificity and source order, so the field drew no ring at all. The field
  // is gone, and what survives it is the general rule it produced — a sheet
  // where nothing removes an outline without putting one back, and where every
  // ring that exists is the same ring.
  it("restores an outline anywhere the sheet removes one", () => {
    const killers = [...css.matchAll(/^([^{}\n][^{}]*)\{([^}]*outline:\s*none[^}]*)\}/gm)]
      .map(([, selector]) => selector.trim());
    // Nothing does today. The loop is what matters: the next rule that opts out
    // has to opt back in for the keyboard.
    // Search focuses its entire labelled wrapper; map suppresses only pointer focus.
    // V4's Figma: the radio search is a text field, so no ring, its border
    // turns --accent (radio.css); the map canvas takes the global ring.
    expect(declOf(".radio-search:focus-within", "border-color")).toBe("var(--accent)");
    expect(declOf(".radio-search:focus-within", "outline")).toBe("none");
    expect(declOf(".radio-pin:focus-visible .radio-pin-dot", "stroke")).toBe("var(--accent)");
    // CHANGED ON PURPOSE (V4's Figma): quick open's input draws no ring; the
    // rule under the field turns --accent while it holds focus, as the radio
    // search's border does.
    expect(declOf(".qo-field:has(.qo-input:focus-visible)", "outline")).toBeNull();
    expect(declOf(".qo-field:has(.qo-input:focus-visible)", "border-bottom-color")).toBe("var(--accent)");
    // A Jira issue's main button draws its ring on the whole row, around the
    // disclosure and actions button that sit beside it.
    expect(declOf(".jr-row:has(> .jr-row-main:focus-visible)", "outline")).toBe("var(--focus-w) solid var(--accent)");
    expect(killers).toEqual([
      // The text-field family (tokens.css): V4's Figma gives fields no ring, their border turns --accent.
      // CHANGED ON PURPOSE (V4's Figma): the other accounts' order is a menu
      // button now, not a select, so it left this family for the global ring.
      ".settings-filter-field:focus-visible, .sm-select:focus-visible, .ap-manage-input:focus-visible,\n.aa-field input:focus-visible, .radio-filter-search input:focus-visible,\n.tr-input:focus-visible, .tr-select:focus-visible,\n.qh-window select:focus-visible, .jr-move-pop select:focus-visible, .jr-transition select:focus-visible,\n.jr-comment-compose textarea:focus-visible, .su-pricing select:focus-visible,\n.ap-field select:focus-visible, .ap-pop .ap-field select:focus-visible,\n.bw-settings select:focus-visible",
      ".qo-input:focus-visible",
      ".radio-pin",
      ".radio-search:focus-within",
      ".radio-search input:focus",
      ".radio-panel .radio-search input:focus-visible",
      ".radio-panel .radio-map-canvas:focus:not(:focus-visible),\n.radio-panel .radio-map-canvas[data-pointer-focus]:focus",
      ".radio-panel:not([data-keyboard-interaction]) .radio-filter-popup :focus-visible",
      ".jr-row-main:focus-visible",
      // CHANGED ON PURPOSE (the phone layout): a phone sheet takes focus by
      // script when it opens, and after a keyboard press the ring would be
      // drawn around the whole sheet. The four sheet containers draw none,
      // inside the phone query only (phone-sheet.css); the controls inside
      // keep the global ring, so there is nothing to restore on the container.
      ".app.app.app .usage-panel[tabindex=\"-1\"]:focus-visible,\n  .app.app.app .sysdetail[tabindex=\"-1\"]:focus-visible,\n  .app.app.app .detail[tabindex=\"-1\"]:focus-visible,\n  .app.app.app .accounts-panel[tabindex=\"-1\"]:focus-visible",
    ]);
    for (const sel of killers.filter(sel => !sel.startsWith(".radio") && !sel.startsWith(".qo-") && !sel.startsWith(".jr-row-main") && !sel.startsWith(".settings-filter-field") && !sel.startsWith(".app.app.app .usage-panel[tabindex"))) {
      expect(declOf(`${sel}:focus-visible`, "outline"), sel).not.toBeNull();
    }
  });

  it("draws every ring in the deck's one focus language, not a second one", () => {
    // V4's Figma: the ring is --focus-w of --accent; the text fields (which
    // set outline: none and turn their border instead) are the one exception.
    expect(declOf(":focus-visible", "outline")).toBe("var(--focus-w) solid var(--accent)");
    // (v4-focus-ring.test.ts pins each field's none + border-color in the grouped rule.)
    // Offset may vary, colour and weight may not.
    for (const [, body] of css.matchAll(/:focus-visible[^{}]*\{([^}]*)\}/g)) {
      const outline = decl(body, "outline");
      // Forced colours swap the accent for the system Highlight; nothing else varies.
      if (outline && outline !== "none") expect(outline).toMatch(/^var\(--focus-w\) solid (?:var\(--accent\)|Highlight)$/);
    }
  });
});
