// At 320px, while the version chip was up, the top bar cut its own mark off.
//
// The chip stands in the end group, which never gives (#849), and the readout
// gives from the left, so the first thing it lost was the mark. Measured in
// headless Chromium on a deck with one session waiting and "4.0.1 is ready" on
// the chip, the logo's left edge sat at -10.8px in English, -9.5 in Japanese,
// -16.2 in German, -26.9 in French and Spanish and -37.5 in Portuguese, and at
// 360 at 2.5 in Portuguese and 3.1 in Romanian, where the bar's padding is 12.
//
// Under 390 the name now goes while the chip is drawn, whole, and the page's
// <h1> stays in the outline; under 340 the chip's icon goes too, and its words
// stay. What is pinned here is the rule, where it holds and where it does not,
// and the arithmetic that says the bar holds the worst case measured: the
// widest waiting count with two digits beside the widest chip words in the
// ten languages (today's, and the translated ones of PR #2613). The paddings
// and gaps are the sheet's; a word's width is the browser's, measured.
import { describe, expect, it } from "vitest";
import { cascade, declared, el, mediaApplies, selects, sheetRules, type El, type SheetRule } from "./sheet-cascade";

/** The kit's small mark, drawn 19px wide at its 16px height (TopbarReadouts.tsx). */
const MARK_PX = 19;
/** The wordmark, "ccdeck" at 13/20 Semibold, measured 44.1. */
const NAME_PX = 45;
/** The widest waiting count measured with two digits: "11 aguardando" (pt-BR)
 *  at 114.8, "11 în așteptare" (ro) at 114.1. */
const COUNT_PX = 115;
/** The widest words the chip has carried, measured: "4.0.1 este gata" (PR
 *  #2613's Romanian for a version waiting for a restart) at 79.4 between the
 *  chip's paddings; today's "4.0.1 is ready" is 72. */
const CHIP_WORDS_PX = 80;
/** Feedback's button in the phone bar's corner (edge-rails.css). */
const CORNER_BUTTON_PX = 32;

const bar = el("header", ["topbar"]);
const readout = el("div", ["readout"]);
const brand = el("div", ["brand"]);
const chip = [bar, el("div", ["tb-end"]), el("span", ["chip-slot"]), el("span", ["v-group"]), el("button", ["v", "stale"])];
const corner = [bar, el("div", ["tb-corner"])];

const px = (v: string | null | undefined): number => {
  if (v == null || v === "0") return 0;
  const m = /^(-?[\d.]+)px$/.exec(v);
  return m ? Number(m[1]) : NaN;
};
/** A shorthand's sides, top right bottom left, as the browser expands it. */
const sides = (v: string | null) => {
  const p = (v ?? "0").split(/\s+/).map(px);
  return [p[0], p[1] ?? p[0], p[2] ?? p[0], p[3] ?? p[1] ?? p[0]];
};
const at = (chain: El[], prop: string, width: number) => cascade(sel => selects(sel, chain), prop, width);

/** The rules whose selector ends on `subject` and asks after the chip. */
const chipRules = (subject: RegExp): SheetRule[] =>
  sheetRules().filter(r => r.selectors.some(s => subject.test(s)));
const nameRules = chipRules(/\.brand h1$/).filter(r => r.selectors.some(s => s.includes(":has(")));
const iconRules = chipRules(/^\.topbar button\.v \.v-icon$/).filter(r => r.media != null);

/** Everything the bar spends across its width at `width`, beside the widest
 *  count and the widest chip words, with the name and the icon drawn or not. */
function spentAt(width: number, { name, icon }: { name: boolean; icon: boolean }): number {
  const pad = sides(at([bar], "padding", width));
  const barGap = px(at([bar], "gap", width));
  const readoutGap = px(at([bar, readout], "gap", width));
  const brandGap = px(at([bar, readout, brand], "gap", width));
  const chipPad = sides(at(chip, "padding", width));
  const chipGap = px(at(chip, "gap", width));
  const iconW = px(at([...chip, el("span", ["v-icon"])], "width", width));
  const cornerMargin = sides(at(corner, "margin", width));
  for (const n of [barGap, readoutGap, brandGap, chipGap, iconW, ...pad, ...chipPad, ...cornerMargin]) {
    expect(Number.isFinite(n), `a length at ${width}px`).toBe(true);
  }
  const start = MARK_PX + (name ? brandGap + NAME_PX : 0) + readoutGap + COUNT_PX;
  const chipW = chipPad[1] + (icon ? iconW + chipGap : 0) + CHIP_WORDS_PX + chipPad[3];
  const cornerW = cornerMargin[3] + CORNER_BUTTON_PX + cornerMargin[1];
  return pad[3] + start + barGap + chipW + barGap + cornerW + pad[1];
}

describe("the top bar under 390px while the version chip is drawn", () => {
  it("hides the name, whole, the way .vis-hidden hides, and only while the chip is in the end group", () => {
    expect(nameRules).toHaveLength(1);
    const [rule] = nameRules;
    expect(rule.selectors).toEqual([".topbar:has(.tb-end button.v) .brand h1"]);
    // Out of sight and still the page's <h1>: never display or visibility,
    // which would take the heading out of the outline with it.
    const hidden = sheetRules().find(r => r.selectors.includes(".vis-hidden") && r.media == null)!;
    for (const prop of ["position", "width", "height", "margin", "padding", "overflow", "clip-path", "white-space", "border"]) {
      expect(declared(rule.body, prop), prop).toBe(declared(hidden.body, prop));
    }
    expect(declared(rule.body, "display")).toBeUndefined();
    expect(declared(rule.body, "visibility")).toBeUndefined();
  });

  it("holds under 390 and nowhere else on a phone, so 390 to 640, 1024 and 1440 draw what they drew", () => {
    const [rule] = nameRules;
    for (const w of [320, 340, 360, 375, 389]) expect(mediaApplies(rule.media, w), `at ${w}px`).toBe(true);
    // CHANGED ON PURPOSE: 641 left this list, for 680. The same rule now also
    // holds from 641 to 689 (679 until Search's cap named the two Shift taps),
    // the full bar's first widths, where the end group adds Board | Workspace
    // and Search beside the chip and cut the mark off at 641
    // (topbar-counts-641.test.ts pins that band). The phone's widths from 390
    // up and the wide bar are still outside it.
    for (const w of [390, 412, 480, 560, 640, 690, 1024, 1440]) expect(mediaApplies(rule.media, w), `at ${w}px`).toBe(false);
  });

  it("drops the chip's icon under 340 and nowhere wider, and nothing else of the chip", () => {
    expect(iconRules).toHaveLength(1);
    const [rule] = iconRules;
    expect(rule.body.trim()).toBe("display: none;");
    for (const w of [320, 339]) expect(mediaApplies(rule.media, w), `at ${w}px`).toBe(true);
    for (const w of [340, 360, 389, 390, 641, 1440]) expect(mediaApplies(rule.media, w), `at ${w}px`).toBe(false);
  });

  it("never hides the mark: no rule that asks after the chip reaches the logo", () => {
    const reaching = sheetRules().filter(r => r.selectors.some(s => /button\.v/.test(s) && /\.logo/.test(s)));
    expect(reaching).toEqual([]);
  });

  it("holds the mark, the widest two-digit count and the widest chip words whole at every phone width", () => {
    // What the sheet draws at each width: the name from 390, the icon from
    // 340, and from 390 both beside the same count and words.
    const drawnAt = (w: number) => ({ name: !mediaApplies(nameRules[0].media, w), icon: !mediaApplies(iconRules[0].media, w) });
    expect(drawnAt(320)).toEqual({ name: false, icon: false });
    expect(drawnAt(360)).toEqual({ name: false, icon: true });
    expect(drawnAt(390)).toEqual({ name: true, icon: true });
    for (const w of [320, 330, 339, 340, 360, 375, 384, 389, 390, 412, 480, 640]) {
      expect(spentAt(w, drawnAt(w)), `at ${w}px`).toBeLessThanOrEqual(w);
    }
  });

  it("starts each rule no narrower than the width that needs it", () => {
    // The widest width at which the worst case does not fit is the first the
    // rule has to cover: with the name drawn, and then with the icon. The
    // phone's paddings and gaps are one set from 320 to 640, so what the bar
    // spends is read once, at the width just under the one it needs.
    const needs = (drawn: { name: boolean; icon: boolean }) => {
      const w = spentAt(389, drawn) - 1;
      expect(spentAt(w, drawn), `the worst case at ${w}px`).toBeGreaterThan(w);
      return w;
    };
    const withName = needs({ name: true, icon: true });
    const withIcon = needs({ name: false, icon: true });
    expect(mediaApplies(nameRules[0].media, withName), `the name at ${withName}px`).toBe(true);
    expect(mediaApplies(iconRules[0].media, withIcon), `the icon at ${withIcon}px`).toBe(true);
  });
});
