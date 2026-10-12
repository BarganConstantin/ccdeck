// #370: the five icon toggles in the topbar are 30x30 squares that told you
// whether they were on in two channels, both of them hue at nearly the same
// luminance — and four of the five told assistive tech nothing at all.
//
// Four of them now. The session list's ☰ has since been removed from the row —
// the panel stays and L is the only way to it — and the last block below is
// what that removal left behind: the rule about disclosure toggles, asked of the
// two that are left, and the rule that a feature whose control is gone must
// still have a way in and a way out.
//
// The visual half, measured against BOTH ends of the topbar gradient rather
// than one of them, because a 30px button centred in a 52px bar is read against
// the whole of it:
//
//   channel                              dark            light
//   --accent-dim fill vs the bare bar    1.91 / 1.89     1.39 / 1.37
//   --accent edge vs the --ctl-edge it   2.65 / 2.74     1.67 / 1.52
//     replaces
//
// Each boundary is fine on its own — 1.4.11 is about a control against its
// surface and --accent clears it at 10.85:1 dark / 5.93:1 light. What none of
// it does is tell the two STATES apart, and in light neither channel reaches
// even 2:1. The report quoted 1.67:1 for the light edge, which is the friendly
// end of the gradient; at the other end it is 1.52:1, and that is the number a
// floor has to be written against.
//
// The semantic half: only the sound button carried aria-pressed. The usage
// panel, accounts panel, session list and usage history reported no state, and
// so did every category filter chip — while their bar claimed role="toolbar",
// an arrow-key contract it does not implement.
//
// The two halves are one fix here. The stylesheet keys the on state off the
// ARIA attribute, so a control cannot look pressed while reporting nothing.
//
// THE TOGGLES LEFT THE TOPBAR (2026-10-08). The four panel toggles stand on
// the window's edges now, in a stripe beside the panel each opens, or in the
// phone's dock (components/EdgeRails.tsx, rail-items.tsx), and the square
// `.icon-btn` they wore left with them. What #370 asked of them holds of the
// new buttons, and is asked of them below: the state is read off
// aria-expanded, so pixels and tree cannot drift; open differs from closed by
// 3:1 or better in a channel that is not hue — a 2px --text line on the
// stripe's inner edge, measured against the stripe and against the open fill;
// and each one announces what it discloses. The inverted accent fill #370
// settled on for an `aria-pressed` toggle left with the last chrome control
// that was one: the sound setting is a switch in Settings (below), and no
// chrome button carries aria-pressed now.
//
// Plain node, no DOM — React cannot be rendered in this suite — so this reads
// styles.css and the markup the way control-edges.test.ts, quiet-signals.test.ts
// and manage-block.test.ts do, and computes every ratio from the sheet's own
// token values. The helpers are re-declared rather than imported from another
// *.test.ts: importing one registers its suites into this file as well. The
// gradient reader below is the exception that proves it — it lives in a plain
// module, `./gradient-stops`, which declares no suites and so can be shared by
// the five files that read the same two gradient tokens (#664, #665).
import { describe, it, expect } from "vitest";
import { KEY_HELP } from "../key-help";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { gradientStops } from "./gradient-stops";
import { clientText } from "./client-source";
import { soundMenuSurface } from "./sound-menu-surface";
import { sheetText } from "./sheet-source";
import { attr, buttons, createElement, draw, items } from "./edge-keys-rails";
import { EdgeDock, EdgeRail } from "../components/EdgeRails";
import { railHint } from "../components/EdgeRails";

const web = fileURLToPath(new URL("..", import.meta.url));
const cssRaw = sheetText();
/** Comments quote the declarations they explain — including the ones this file
 *  asserts are gone — so every read of the sheet goes through the stripped copy. */
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "");

/** A component's markup with its commentary gone, for the same reason: the
 *  comments here argue about `primary` and `role="toolbar"` by name. */
function markup(...path: string[]): string {
  return markupOf(readFileSync(join(web, ...path), "utf8"));
}
function markupOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
}
// The keydown handler moved to use-deck-shortcuts.ts; the keys and the rest of the deck are read as one.
// The panel toggles are defined in rail-items.tsx and drawn by
// components/EdgeRails.tsx; App.tsx and they are read as one.
const app = markup("App.tsx") + "\n" + markup("use-deck-shortcuts.ts") + "\n" + markup("rail-items.tsx")
  + "\n" + markup("components/EdgeRails.tsx");
const usagePanel = markup("components", "UsagePanel.tsx");
const accountsPanel = markup("components", "AccountsPanel.tsx");
const sessionList = markup("components", "SessionList.tsx");
const historyModal = markup("components", "UsageHistoryModal.tsx");

/** WCAG 1.4.3 for the glyph, 1.4.11 for the difference between two states. */
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

// ── the stylesheet, as rules ────────────────────────────────────────────────
//
// Selector-list aware, because the rule under test is written as two selectors
// on one rule: a `^selector\s*\{` probe would miss both of them.

/** The `{…}` opened at `open`, and the index of its closing brace. */
function block(src: string, open: number): [string, number] {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return [src.slice(open + 1, i), i];
  }
  throw new Error("unbalanced braces in styles.css");
}

/** Top-level rules only — a @media body is a different cascade. */
function topLevel(src: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) break;
    const prelude = src.slice(i, open).replace(/\s+/g, " ").trim();
    const [inner, end] = block(src, open);
    if (!prelude.startsWith("@")) out.push({ selector: prelude, body: inner });
    i = end + 1;
  }
  return out;
}

const RULES = topLevel(css);
const selectors = (list: string) => list.split(",").map(s => s.replace(/\s+/g, " ").trim());

/** Every top-level rule naming this exact selector, in source order. */
function bodyOf(selector: string): string {
  const hit = RULES.filter(r => selectors(r.selector).includes(selector));
  if (!hit.length) throw new Error(`no rule for ${selector}`);
  return hit.map(r => r.body).join(";");
}

/** The last declaration of `prop`, which is the one that wins. */
function declIn(body: string, prop: string): string | null {
  const all = [...body.matchAll(new RegExp(`(?:^|[;{])\\s*${prop}\\s*:([^;]*)`, "g"))];
  return all.length ? all[all.length - 1][1].replace(/\s+/g, " ").trim() : null;
}

const decl = (selector: string, prop: string) => declIn(bodyOf(selector), prop);

/** A rule inside `@media <query>` blocks, in source order: the chrome draws its
 *  hover only where there is one, and the dock only at a phone's width. */
function mediaBodyOf(query: string, selector: string): string {
  const hits: string[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open < 0) break;
    const prelude = css.slice(i, open).replace(/\s+/g, " ").trim();
    const [inner, end] = block(css, open);
    if (prelude === `@media ${query}`) {
      for (const r of topLevel(inner)) if (selectors(r.selector).includes(selector)) hits.push(r.body);
    }
    i = end + 1;
  }
  if (!hits.length) throw new Error(`no rule for ${selector} in @media ${query}`);
  return hits.join(";");
}
const HOVER = "(hover: hover)";
const PHONE = "(max-width: 640px)";

const themes = ["dark", "light"] as const;
type Theme = (typeof themes)[number];

function rootTokens(theme: Theme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of bodyOf(`:root[data-theme="${theme}"]`).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[name] = value.trim();
  }
  return out;
}
const TOK: Record<Theme, Record<string, string>> = { dark: rootTokens("dark"), light: rootTokens("light") };

/** var() one level deep, plus the `color-mix(in srgb, X N%, transparent)` form
 *  the control tokens use — which is just X at N% alpha. */
function resolve(value: string, theme: Theme): Rgba {
  const v = value.trim();
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*transparent\)$/.exec(v);
  if (mix) {
    const base = resolve(mix[1], theme);
    return [base[0], base[1], base[2], base[3] * (+mix[2] / 100)];
  }
  const ref = /^var\(\s*(--[\w-]+)\s*\)$/.exec(v);
  return parseColor(ref ? TOK[theme][ref[1]] : v);
}

/** Both ends of the topbar gradient. A 30px button centred in 52px of it is
 *  read against the darker end as much as the lighter one, so a state delta
 *  that only holds at one of them does not hold.
 *
 *  Which is exactly why answering with NO ends was the wrong failure. This
 *  ended in `?? []` until #649: neither `var()` nor `#rrggbb` occurs inside an
 *  `oklch()`, so respelling --topbar-grad in the notation a designer reaches for
 *  next matched nothing, and the three sweeps below that are quantified over
 *  these ends — the on-fill against the bare bar, and the machine meter's ring
 *  against the bar and against its own hover wash — each ran their loop zero
 *  times and passed. The file did go red, but somewhere else: the three cases
 *  that index `barEnds(theme)[0]` threw `Cannot read properties of undefined`,
 *  which names neither the token nor the notation and is a crash rather than
 *  this sweep catching anything. A sweep that cannot read the value it was
 *  pointed at has to fail, and name the value.
 *
 *  Exactly two, because the two labels below ARE the two ends: a third stop
 *  would be announced as a second dark end and quietly measured as one.
 *
 *  The grammar itself moved to `./gradient-stops` with #664 and #665 — three
 *  more files were reading these same gradients through their own copy of the
 *  `?? []` this paragraph describes, and one grammar in five places is one
 *  blind spot in five places. */
function barEnds(theme: Theme): Array<[string, Rgba]> {
  const stops = gradientStops("--topbar-grad", theme, TOK[theme], { exactly: 2 });
  return stops.map((s, i) => [i === 0 ? "the topbar's light end" : "the topbar's dark end", resolve(s, theme)]);
}

/** A colour as a layer: `resolve`, except that a token spelled as the
 *  foreground mixed toward transparent (--ctl-fill, --ctl-edge) comes back as
 *  that colour at that alpha, which is what it paints. */
function layer(value: string, theme: Theme): Rgba {
  const name = /^var\((--[\w-]+)\)$/.exec(value.trim())?.[1];
  const raw = (name ? TOK[theme][name] : value) ?? value;
  const m = /^color-mix\(in srgb, var\((--[\w-]+)\) (\d+(?:\.\d+)?)%, transparent\)$/.exec(raw.trim());
  if (!m) return resolve(value, theme);
  const [r, g, b] = resolve(`var(${m[1]})`, theme);
  return [r, g, b, Number(m[2]) / 100];
}

/** A chrome button whose panel is open: the control fill and the foreground. */
const OPEN = '.rail-btn[aria-expanded="true"]';
/** And its line on the edge the panel came out of: a stripe's inner edge, the
 *  dock's top edge. Drawn always, shown only while open. */
const LINES = [".rail-btn-stripe::before", ".rail-btn-dock::before"] as const;
const LINE_SHOWN = {
  ".rail-btn-stripe::before": '.rail-btn-stripe[aria-expanded="true"]::before',
  ".rail-btn-dock::before": '.rail-btn-dock[aria-expanded="true"]::before',
} as const;
/** The bed the chrome's buttons stand on: a stripe and the dock are both
 *  --bg-soft (edge-rails.css). */
const CHROME_BED = (theme: Theme) => resolve("var(--bg-soft)", theme);
/** A fill mixed from the foreground: the control fill, or the same mix at
 *  another strength. Never a hue. */
const NEUTRAL_FILL = /^(?:var\(--ctl-fill\)|color-mix\(in srgb, var\(--text\) \d+%, transparent\))$/;

describe("the contrast maths, against the two ends everybody knows", () => {
  it("puts white on black at 21:1 and a colour on itself at 1:1", () => {
    expect(contrastRatio(parseColor("#ffffff"), parseColor("#000"))).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColor("#7dd3fc"), parseColor("#7dd3fc"))).toBeCloseTo(1, 5);
  });

  it("agrees with the known AA boundary grey — #767676 on white is 4.54:1", () => {
    expect(contrastRatio(parseColor("#767676"), parseColor("#ffffff"))).toBeCloseTo(4.54, 2);
  });
});

describe("what the toggle state used to be worth (#370)", () => {
  // Literals, not tokens: this is the shipped v1.33.151 appearance restated as
  // arithmetic, and a baseline that moved with the palette would not be one.
  const darkEnds = [parseColor("#14161b"), parseColor("#0f1116")];
  const lightEnds = [parseColor("#ffffff"), parseColor("#eef1f6")];
  const darkDim: Rgba = [56, 189, 248, 0x50 / 255];
  const lightDim: Rgba = [3, 105, 161, 0.22];

  it("reproduces the fill delta — an --accent-dim wash on the bar it sits in", () => {
    expect(darkEnds.map(b => +contrastRatio(over(darkDim, b), b).toFixed(2))).toEqual([1.91, 1.89]);
    expect(lightEnds.map(b => +contrastRatio(over(lightDim, b), b).toFixed(2))).toEqual([1.39, 1.37]);
  });

  it("reproduces the edge delta, and corrects the light number the report quoted", () => {
    // --ctl-edge is 50% of --text, so it composites differently at each end;
    // --accent is opaque and does not. The report's 1.67:1 is the white end.
    // The bar's other end is #eef1f6 and the same step is 1.52:1 there.
    const darkEdge = darkEnds.map(b => +contrastRatio(parseColor("#7dd3fc"), over([216, 218, 224, 0.5], b)).toFixed(2));
    const lightEdge = lightEnds.map(b => +contrastRatio(parseColor("#0369a1"), over([13, 17, 23, 0.5], b)).toFixed(2));
    expect(darkEdge).toEqual([2.65, 2.74]);
    expect(lightEdge).toEqual([1.67, 1.52]);
  });

  it("agrees that each boundary was fine on its own — the defect is the difference", () => {
    // 1.4.11 asks a control's edge to clear 3:1 against its surface, and both
    // states always did. Nothing here was a boundary failure.
    expect(contrastRatio(parseColor("#0369a1"), parseColor("#ffffff"))).toBeCloseTo(5.93, 2);
    expect(contrastRatio(over([13, 17, 23, 0.5], parseColor("#ffffff")), parseColor("#ffffff"))).toBeCloseTo(3.55, 2);
  });

  it("shows no wash could have fixed it — in dark the two windows never overlap", () => {
    // The obvious cheaper fix is to deepen --accent-dim until the fill clears
    // 3:1 and keep everything else. It does not exist in dark: the alpha is
    // still short of 3:1 at 0.40 (2.75:1) and by 0.50 it has taken --text down
    // to 3.60:1 on top of it, under AA, and only falls from there. Swept at
    // every hundredth so this is a statement about the whole range and not
    // about two samples. Light is the theme where a wash CAN work — 0.70 is
    // 3.27:1 / 3.04:1 with --text still at 5.79:1 — which would have left the
    // same state drawn two different ways in the two themes, the divergence
    // #332 and #368 both refused. Inverting works in both, so it is one rule.
    const darkEnds = [parseColor("#14161b"), parseColor("#0f1116")];
    const text = parseColor("#d8dae0");
    for (let a = 0; a <= 1.0001; a += 0.01) {
      for (const bed of darkEnds) {
        const fill = over([125, 211, 252, a], bed);
        const legible = contrastRatio(text, fill) >= BODY;
        const visible = contrastRatio(fill, bed) >= NON_TEXT;
        expect(legible && visible, `dark --accent at alpha ${a.toFixed(2)}`).toBe(false);
      }
    }
  });
});

describe("the open state, as the sheet draws it now", () => {
  it("keys it off aria-expanded, in neutrals, so no toggle can be styled and mute", () => {
    // An open chrome button is the pressed look of the old toolbar: the
    // control fill and the whole foreground. No accent anywhere in the state —
    // the accent on the chrome is focus and live data, and a panel that is
    // showing is neither.
    const open = RULES.find(r => selectors(r.selector).includes(OPEN));
    expect(open, "no rule keyed on aria-expanded").toBeTruthy();
    // A wash of the foreground itself, so it exists in both themes by
    // construction (the derived-tier rule in DESIGN.md), at whatever strength
    // the measurements below allow.
    expect(declIn(open!.body, "background")).toMatch(NEUTRAL_FILL);
    expect(declIn(open!.body, "color")).toBe("var(--text)");
    expect(open!.body, "an open chrome button is painted in the accent again").not.toMatch(/--accent/);
    // Closed, it draws no fill and no edge, which is what makes the fill and
    // the line the state.
    expect(decl(".rail-btn", "background")).toBe("transparent");
    expect(decl(".rail-btn", "border")).toBe("0");
    expect(decl(".rail-btn", "color")).toBe("var(--muted)");
  });

  it("draws a line on the edge the panel opened from, shown only while it is open", () => {
    // The dock's line is drawn at a phone's width only, where the dock is.
    const at = (sel: string, prop: string) =>
      sel.includes("dock") ? declIn(mediaBodyOf(PHONE, sel), prop) : decl(sel, prop);
    for (const line of LINES) {
      expect(at(line, "background"), line).toBe("var(--text)");
      expect(at(line, "opacity"), `${line} at rest`).toBe("0");
      expect(at(LINE_SHOWN[line], "opacity"), `${line} open`).toBe("1");
    }
    // The stripe's line stands on the inner edge — the right of the left
    // stripe, the left of the right one — over the stripe's own border.
    expect(decl(".edge-rail-left .rail-btn-stripe::before", "right")).toBe("-3px");
    expect(decl(".edge-rail-right .rail-btn-stripe::before", "left")).toBe("-3px");
    expect(decl(".rail-btn-stripe::before", "width")).toBe("2px");
    expect(declIn(mediaBodyOf(PHONE, ".rail-btn-dock::before"), "height")).toBe("2px");
  });

  it("holds the line 3:1 or better off the stripe, and off the open fill beside it, in both themes", () => {
    // The 3:1 #370 asked of the state difference, now carried by the line: it
    // is what a closed button does not have. Against the bare stripe it stands
    // beside, and against the open fill, which is the button's own bed.
    for (const theme of themes) {
      const bed = CHROME_BED(theme);
      const fill = over(layer(decl(OPEN, "background")!, theme), bed);
      const line = resolve(decl(".rail-btn-stripe::before", "background")!, theme);
      expect(contrastRatio(line, bed), `${theme} line vs the stripe`).toBeGreaterThanOrEqual(NON_TEXT);
      expect(contrastRatio(line, fill), `${theme} line vs the open fill`).toBeGreaterThanOrEqual(NON_TEXT);
    }
  });

  it("reads its word at 4.5:1 open and at rest, on the stripe, in both themes", () => {
    // The word is how a stripe button is identified (1.4.11 via the label, as
    // the old toolbar's words were): --muted at rest on the stripe, --text on
    // the open fill.
    for (const theme of themes) {
      const bed = CHROME_BED(theme);
      const fill = over(layer(decl(OPEN, "background")!, theme), bed);
      expect(contrastRatio(resolve(decl(".rail-btn", "color")!, theme), bed), `${theme} word at rest`)
        .toBeGreaterThanOrEqual(BODY);
      expect(contrastRatio(resolve(decl(OPEN, "color")!, theme), fill), `${theme} word open`)
        .toBeGreaterThanOrEqual(BODY);
    }
  });

  it("keeps the pointer's own feedback on an open button, and out-specifies the hover it has to beat", () => {
    // Hover lifts a closed button to the control fill — the open look — so an
    // open button answers the pointer with a deeper fill of its own rather
    // than with nothing.
    // Only where there is a hover: a tap on the phone's dock left a fill behind.
    // Measured as the alpha each fill lays down, in both themes: an open
    // button under the pointer is deeper than an open one at rest, which is
    // itself deeper than a closed one under the pointer — so hover never
    // reads as open, and open never stops answering the pointer.
    const hoverOpen = declIn(mediaBodyOf(HOVER, `${OPEN}:hover`), "background")!;
    const hoverClosed = declIn(mediaBodyOf(HOVER, ".rail-btn:hover"), "background")!;
    const resting = decl(OPEN, "background")!;
    for (const v of [hoverOpen, hoverClosed]) expect(v).toMatch(NEUTRAL_FILL);
    for (const theme of themes) {
      const alpha = (v: string) => layer(v, theme)[3];
      expect(alpha(hoverOpen), `${theme} open under the pointer`).toBeGreaterThan(alpha(resting));
      expect(alpha(resting), `${theme} open at rest`).toBeGreaterThan(alpha(hoverClosed));
    }
    const specificity = (sel: string): number =>
      (sel.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length;
    expect(specificity(`${OPEN}:hover`)).toBeGreaterThan(specificity(".rail-btn:hover"));
  });

  it("left no chrome toggle drawing an on state off aria-pressed — the one setting left is a switch", () => {
    // #370's inverted accent fill was the on state of an aria-pressed icon
    // toggle. Its last wearer on the chrome was the speaker, which became a
    // disclosure (#711) and then left for Settings › Sounds as a real switch
    // (the case under "what each of the four toggles announces" pins it). The
    // rule left with `.icon-btn`; a chrome toggle that came back as a setting
    // would have to answer this sweep again rather than inherit a dead rule.
    expect(css).not.toMatch(/icon-btn\[aria-pressed/);
    expect(app).not.toMatch(/aria-pressed/);
  });

  it("left .primary alone — it means 'the action to take', not 'this is on'", () => {
    expect(decl("button.btn.primary", "background")).toBe("var(--accent-dim)");
    expect(decl("button.btn.primary", "color")).toBe("var(--text)");
  });
});

describe("what each of the four toggles announces", () => {
  /** The opening tags of the controls on both stripes, drawn with this state,
   *  by their data-rail-item. */
  function stripes(state: Parameters<typeof items>[0] = {}): Map<string, string> {
    const chrome = items(state);
    return buttons(draw(createElement("div", null,
      createElement(EdgeRail, { side: "left", label: "Left column", groups: [chrome.left] }),
      createElement(EdgeRail, { side: "right", label: "Right panels", groups: chrome.right }),
    )));
  }
  const PANELS: Array<[string, keyof NonNullable<Parameters<typeof items>[0]>, string]> = [
    ["session-list", "sessionListOpen", "session-list"],
    ["accounts", "accountsPanelOpen", "accounts-panel"],
    ["usage", "usagePanelOpen", "usage-panel"],
    ["machine", "machinePanelOpen", "system-panel"],
  ];

  it("gives the four panel toggles aria-expanded, bound to the panel's own state", () => {
    // Disclosures: each shows a region beside the canvas and takes no focus
    // with it. Not aria-pressed — the button is not a setting that stays on,
    // it reports whether the thing it points at is on screen. Drawn closed and
    // open, so a state wired to the wrong panel, or to none, cannot pass.
    const closed = stripes();
    for (const [id, state] of PANELS) {
      expect(attr(closed.get(id)!, "aria-expanded"), `${id} closed`).toBe("false");
      const open = stripes({ [state]: true });
      expect(attr(open.get(id)!, "aria-expanded"), `${id} open`).toBe("true");
      for (const [other] of PANELS.filter(p => p[0] !== id)) {
        expect(attr(open.get(other)!, "aria-expanded"), `${other} while ${id} is open`).toBe("false");
      }
    }
  });

  it("points each one at a real element, and only while that element exists", () => {
    // The AccountsPanel ⋯ menu's rule, applied to the panels: an IDREF that
    // resolves to nothing is a dangling pointer, and closed is exactly when
    // there is nothing to point at.
    const closed = stripes();
    for (const [id, state, region] of PANELS) {
      expect(attr(closed.get(id)!, "aria-controls"), `${id} closed`).toBeNull();
      expect(attr(stripes({ [state]: true }).get(id)!, "aria-controls"), `${id} open`).toBe(region);
    }
    expect(usagePanel).toMatch(/id="usage-panel"/);
    expect(accountsPanel).toMatch(/id="accounts-panel"/);
    expect(sessionList).toMatch(/id="session-list"/);
    expect(markup("components", "MachinePanel.tsx")).toMatch(/id="system-panel"/);
  });

  it("has a control on screen for the session list, not only a key (#800)", () => {
    // THE REMOVAL IS REVERSED, and the reason is worth keeping beside the
    // reason it was removed. Taking the button out left `L` as the only route,
    // and the only place `L` is written down is the shortcuts sheet — reached
    // through a small `?` in the canvas control stack, which a mouse-only user
    // has no reason to open and a first-run user has never seen.
    // It stands first on the left stripe now, beside the column it opens,
    // drawn (#837) and with its word.
    const chrome = items();
    expect(chrome.left[0].id).toBe("session-list");
    const html = draw(createElement(EdgeRail, { side: "left", label: "Left column", groups: [chrome.left] }));
    expect(html).toMatch(/data-rail-item="session-list"[^>]*>\s*<svg /);
    expect(html).toMatch(/<span class="rail-word">Session list<\/span>/);
    // And on a phone, in the dock — the stripes give way to it there.
    const dock = draw(createElement(EdgeDock, { items: [...chrome.left, ...chrome.right[0], chrome.utilities[0]], more: [...chrome.right[1], chrome.utilities[1]] }));
    expect(attr(buttons(dock).get("session-list")!, "aria-expanded")).toBe("false");
    // The panel keeps its landmark name either way.
    expect(sessionList).toMatch(/<aside className="session-list" id="session-list" aria-label="Sessions">/);
    // Enumerated rather than asked of one state, so a control that appeared
    // with some other state would fail here. Four, the four panels: the
    // speaker's popover left with the speaker (2026-10-07), the gear opens a
    // modal, and the detail panel's way back is D and the canvas (#800's
    // trade-off, put to the owner). The dock's More discloses a menu, which is
    // its own thing and is drawn only on a phone.
    const disclosing = [...stripes()].filter(([, tag]) => attr(tag, "aria-expanded") !== null).map(([id]) => id).sort();
    expect(disclosing).toEqual(["accounts", "machine", "session-list", "usage"]);
  });

  it("leaves the session list a way in and a way out, which is what the button was", () => {
    // The failure this case exists for is a panel that opens and cannot be
    // closed. Three claims, and the feature needs all three:
    //   L reaches the toggle,
    //   the toggle really inverts — a setter that only ever opened would be a
    //     trap now that nothing else can shut it,
    //   and the panel's own ‹ still calls the close.
    expect(app).toMatch(/if \(e\.key === "l" \|\| e\.key === "L"\) toggleSessionList\(\);/);
    // The toggles and the close moved to use-left-column.ts; the key binding and
    // the panel's markup are still App.tsx's. The close is two links now, and
    // both are pinned, because "cannot be closed" is exactly what a broken link
    // between them would produce.
    const client = clientText();
    const body = client.slice(client.indexOf("const toggleSessionList"), client.indexOf("const toggleAccountsPanel"));
    expect(body).toMatch(/setSessionListOpen\(open => \{[\s\S]*?return !open;/);
    expect(app).toMatch(/\{sessionListOpen && \(\s*<SessionList/);
    // The stripe button presses the same toggle L does.
    expect(app).toMatch(/onPress: toggleSessionList/);
    // The close arms the keyboard's hand-off on the way (panel-close-focus.test.ts).
    expect(app).toMatch(/onClose=\{\(\) => \{ panelReturn\.sessionList\(\); closeSessionList\(\); \}\}/);
    expect(client).toMatch(/const closeSessionList = useCallback\(\(\) => setSessionListOpen\(false\), \[\]\);/);
    expect(sessionList).toMatch(/className="glyph-btn sl-close" onClick=\{onClose\}/);
    // Escape is not a third way out and never was: this is an <aside> beside
    // the canvas, not a modal, so it registers no dismisser with modalStack and
    // the key falls through to clearing the canvas selection. Pinned so the
    // sentence above stays checkable.
    expect(sessionList).not.toMatch(/useModalDismiss|modalStack/);
    // The sheet still lists it, and the control names the key — in its hint's
    // keycap and in aria-keyshortcuts now — so it teaches the shortcut rather
    // than replacing it (#800). While the single-key shortcuts are on, which is
    // where every deck starts; with them off the key is not named (WCAG 2.1.4,
    // edge-keys-switch.test.ts draws both).
    const rows = KEY_HELP.flatMap(g => g.rows);
    expect(rows.find(r => r.cap === "L")!.action).toMatch(/session list/);
    const list = items().left[0];
    expect(railHint(list, true, true)?.keys).toBe("L");
    expect(attr(stripes().get("session-list")!, "aria-keyshortcuts")).toBe("L");
  });

  it("keeps the sound setting's state on a real switch, in Settings › Sounds", () => {
    // This used to be the one genuine setting-toggle in the row, and #711 took
    // that away deliberately: the button opened a popover, and its state moved
    // onto a real switch inside it, which is also what M flips. The button and
    // its popover left the topbar (2026-10-07) and the switch stayed where it
    // also was, in Settings › Sounds — so the setting still reports itself.
    // `role="switch"` with aria-checked rather than a button with
    // aria-pressed: what it carries is a setting that stays on, and a switch
    // is the role whose whole definition is that.
    expect(app).not.toMatch(/Sound settings/);
    const menuSurface = markupOf(soundMenuSurface());
    const soundSwitch = markup("components", "SoundSwitch.tsx");
    expect(markup("components", "SoundsSection.tsx")).toMatch(/<SoundSwitch soundOn=\{soundOn\}/);
    expect(soundSwitch).toMatch(/role="switch"[\s\S]{0,60}aria-checked=\{soundOn\}/);
    expect(soundSwitch).toMatch(/aria-labelledby=\{labelId\}/);
    expect(menuSurface).not.toMatch(/aria-pressed/);
  });

  it("gives the four that open a modal aria-haspopup and no state at all", () => {
    // History opens a modal: role="dialog" aria-modal="true" behind a
    // full-screen scrim, with a focus trap. While it is open the button cannot
    // be clicked or tabbed to and aria-modal has taken the chrome out of the
    // tree, so a `true` no reader can reach is worse than no state — it would
    // be the one value announced only when it is not needed. Browser watch,
    // Settings and Feedback open modals too, and say so the same way.
    const chrome = items();
    const tags = buttons(draw(createElement("div", null,
      createElement(EdgeRail, { side: "right", label: "Right panels", groups: chrome.right }),
      createElement(EdgeDock, { items: [chrome.utilities[0]], more: [] }),
    )));
    const utilities = buttons(draw(createElement(EdgeRail, { side: "left", label: "x", groups: [chrome.utilities] })));
    for (const [id, tag] of [["history", tags.get("history")], ["browser-watch", tags.get("browser-watch")],
                             ["settings", utilities.get("settings")], ["feedback", utilities.get("feedback")]] as const) {
      expect(attr(tag!, "aria-haspopup"), id).toBe("dialog");
      expect(tag!, id).not.toMatch(/aria-pressed|aria-expanded/);
    }
    expect(attr(tags.get("history")!, "aria-label")).toBe("Usage history");
    expect(historyModal).toMatch(/role="dialog" aria-modal="true"/);
    expect(historyModal).toMatch(/useModalDismiss/);
    // The shared scrim since #874, which put this dialog on the .modal shell.
    expect(historyModal).toMatch(/className="modal-backdrop"/);
    expect(declIn(bodyOf(".modal-backdrop"), "position")).toBe("fixed");
  });

  it("leaves no toggle showing its state as a class the tree cannot see", () => {
    // `primary` was the whole of the visual state on all five. It is the
    // stylesheet's word for a primary ACTION and the add-account dialog still
    // uses it that way; what it must not do is stand in for "pressed".
    // The readout group moved out of App.tsx to components/TopbarReadouts.tsx,
    // so the negative reads it too.
    expect(app + "\n" + markup("components/TopbarReadouts.tsx")).not.toMatch(/\bprimary\b/);
    expect(markup("components", "AddAccountDialog.tsx")).toMatch(/className="btn primary"/);
  });
});

describe("the category filter chips, handed over from #368", () => {
  // The chips are components/CategoryFilterBar.tsx's, which App.tsx mounts.
  const bar = markup("components/CategoryFilterBar.tsx");

  it("reports pressed state, and pressed means the category is showing", () => {
    // The chip's own label is the category name — "edit", not "hide edit" — so
    // pressed has to mean the category is on. `off` is the hidden set.
    expect(bar).toMatch(/aria-pressed=\{!off\}/);
  });

  it("dropped role=\"toolbar\" rather than promising arrow keys it does not implement", () => {
    // A toolbar is one tab stop for the whole set with arrows between members.
    // Every chip here is its own tab stop. group keeps the naming, which is
    // what the role was really doing.
    expect(bar).not.toMatch(/role="toolbar"/);
    expect(bar).toMatch(/role="group"\s*\n\s*aria-label="Filter tools by category"/);
    // The deck's toolbars since the panel toggles reached the window's edges
    // are the stripes and the dock, and they keep the promise the role makes:
    // one stop, the arrows inside, Home and End (EdgeRails.tsx).
    const rails = markup("components", "EdgeRails.tsx");
    expect(rails).toMatch(/role="toolbar"/);
    for (const key of ["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"]) {
      expect(rails, key).toContain(`"${key}"`);
    }
    expect(rails).toMatch(/tabIndex=\{variant === "bar" \? undefined : tabbable \? 0 : -1\}/);
  });

  it("carries `off` in a channel that is not colour", () => {
    expect(decl(".cat-filter.off .cat-name", "text-decoration")).toBe("line-through");
    // The chip's glyph is drawn, monochrome, in currentColor, so it follows
    // the label into the off tier rather than needing a desaturation of its own.
    // CatGlyph moved to detail-category.tsx with the paths it draws.
    expect(markup("detail-category.tsx")).toMatch(/<svg className="cat-glyph"[^>]*stroke="currentColor"/);
  });

  it("needed one — the two colour tiers alone are under 3:1 apart in both themes", () => {
    // This is the measurement that makes the strike load-bearing rather than
    // decoration: --text against --muted, which is the whole of what #368 left.
    for (const theme of themes) {
      const on = resolve(decl(".cat-filter", "color")!, theme);
      const off = resolve(decl(".cat-filter.off", "color")!, theme);
      expect(contrastRatio(on, off), `${theme} on vs off label`).toBeLessThan(NON_TEXT);
    }
  });

  it("did not spend the contrast #368 just bought to get it", () => {
    // The strike is geometry; both tiers stay exactly where that issue put them.
    expect(decl(".cat-filter.off", "color")).toBe("var(--muted)");
    expect(decl(".cat-filter.off:hover", "color")).toBe("var(--text)");
    expect(declIn(bodyOf(".cat-filter.off"), "opacity")).toBeNull();
  });
});

// ── the machine meter is gone, and its states went back to the sweep ────────
//
// #507 gave the topbar's 50x24 machine meter a describe of its own, because the
// toggles' on and open rules named `button.btn.icon-btn` and a box holding a
// sparkline and a memory bar was not one: its "the panel is open" state and its
// hover state had drifted into a single declaration with two selectors, and
// nothing in this file could see it.
//
// The meter was removed. The panel it disclosed is opened by Machine on the
// right stripe now, a `.rail-btn` like the other three panel toggles, and the
// open-state cases above already hold it to the fill, the line and the 3:1
// that block had to spell out by hand. The exception is gone with the control
// that needed it, which is why there is nothing here.
