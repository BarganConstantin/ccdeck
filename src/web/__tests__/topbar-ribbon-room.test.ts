// Just above a phone's width, a selection cut the waiting pill off the bar.
//
// Under 641px the ribbon naming the selected agent is not on the bar: the
// detail sheet stands over the canvas there, its hero naming the agent with
// its own ×, so the ribbon says nothing the sheet does not (#1790). From 641 up
// it is back, and the bar has to hold it beside the waiting pill whole.
//
// The bar it is held against changed on 2026-10-08: the eight panel toggles
// that stood at its right went to the window's edges, and the bar keeps two
// controls, Settings and Feedback, each with its word. The waiting queue's
// names take only what is left (topbar-controls.css), so they are not in the
// sum: they fold before anything here is touched. These add the bar up from
// the sheet's numbers, the way the browser lays it out: padding, the waiting
// pill, the gaps, the queue's box giving its own gap back, the ribbon at its
// floor, and the two utilities.
import { describe, expect, it } from "vitest";
import { cascade, el, selects, type El } from "./sheet-cascade";

/** The waiting pill with a two-digit count and its word, "12 waiting",
 *  measured in headless Brave (90.59 with one digit, 99.84 with two). */
const WAITING_PILL_PX = 100;
/** "LIVE" with its pulsing dot, the widest state the ribbon names. */
const STATE_PILL_PX = 53;
/** The utilities' words, measured in headless Brave at 12px: "Settings" and
 *  "Feedback". Everything else in their width is the sheet's. */
const UTILITY_WORDS_PX = [46.78, 55.17];
/** The chrome's glyphs are 13px on a 14 viewBox (#837). */
const GLYPH_PX = 13;

const html = el("html", [], { states: ["root"] });
const app = el("div", ["app"]);
const bar = el("header", ["topbar"]);
const names = el("div", ["wait-names"]);
const actions = el("div", ["actions"]);
const run = el("div", ["utility-run"]);
const utility = el("button", ["rail-btn", "rail-btn-bar"]);
const ribbon = el("button", ["selected-ribbon"]);
const close = el("span", ["selected-close"]);

const px = (v: string | null, vars: Record<string, number> = {}): number => {
  if (v == null) return 0;
  const named = /^var\((--[\w-]+)\)$/.exec(v);
  if (named) return vars[named[1]] ?? NaN;
  const m = /^(-?[\d.]+)px$/.exec(v);
  return m ? Number(m[1]) : v === "0" ? 0 : NaN;
};
const at = (chain: El[], prop: string, width: number) => cascade(sel => selects(sel, chain), prop, width);
/** A shorthand's sides, top right bottom left, as the browser expands it. */
const sides = (v: string | null) => {
  const p = (v ?? "0").split(/\s+/).map(s => px(s));
  return [p[0], p[1] ?? p[0], p[2] ?? p[0], p[3] ?? p[1] ?? p[0]];
};

/** Everything on the bar at `width` but the ribbon. */
function besideRibbonAt(width: number): number {
  const gap = px(at([bar], "gap", width));
  const [, right, , left] = sides(at([bar], "padding", width));
  const queueBack = px(at([app, bar, names], "margin-left", width));
  const [, uRight, , uLeft] = sides(at([app, bar, actions, run, utility], "padding", width));
  const uGap = px(at([app, bar, actions, run, utility], "gap", width));
  const runGap = px(at([app, bar, actions, run], "gap", width));
  const utilities = UTILITY_WORDS_PX.reduce((sum, word) => sum + uLeft + GLYPH_PX + uGap + word + uRight, 0)
    + runGap * (UTILITY_WORDS_PX.length - 1);
  // readout | gap | the queue's box, its margin giving that gap back | gap |
  // the ribbon | gap | the utilities.
  return left + right + WAITING_PILL_PX + gap + queueBack + gap + gap + utilities;
}

/** The least the ribbon can be and still draw its state and its × inside its
 *  own edge: its padding and border, the state, the name ellipsed to nothing
 *  with a gap either side, and the ×. */
function ribbonFloorAt(width: number) {
  const [, right, , left] = sides(at([app, bar, ribbon], "padding", width));
  const border = px((at([app, bar, ribbon], "border", width) ?? "").split(/\s+/)[0]);
  const gap = px(at([app, bar, ribbon], "gap", width));
  return left + right + 2 * border + STATE_PILL_PX + 2 * gap + px(at([app, bar, ribbon, close], "width", width));
}

/** Where the ribbon returns, a step at a time to where its cap stops binding,
 *  and the widths people run the deck at. */
const WIDTHS = [641, 645, 650, 660, 680, 700, 720, 740, 760, 765, 800, 900, 1024, 1039, 1280, 1440, 1920];

describe("a selected agent's ribbon beside the waiting pill", () => {
  it("reads every number it adds from the sheet", () => {
    for (const w of [641, 765, 1024, 1440]) {
      expect(Number.isFinite(besideRibbonAt(w)), `the bar at ${w}px`).toBe(true);
      expect(ribbonFloorAt(w), `the ribbon's floor at ${w}px`).toBeGreaterThan(STATE_PILL_PX);
    }
    // The queue's box gives the bar's gap back, so it costs nothing empty.
    expect(px(at([app, bar, names], "margin-left", 1440))).toBe(-px(at([bar], "gap", 1440)));
  });

  it("is drawn only where the bar holds it, the pill and both utilities whole", () => {
    const short: string[] = [];
    for (const w of WIDTHS) {
      if (at([app, bar, ribbon], "display", w) === "none") continue;
      const need = besideRibbonAt(w) + ribbonFloorAt(w);
      if (need > w) short.push(`${w}px needs ${need.toFixed(1)}`);
    }
    expect(short).toEqual([]);
  });

  it("leaves the bar where the detail sheet stands over the canvas, and is back beside it", () => {
    expect(at([app, bar, ribbon], "display", 481)).toBe("none");
    expect(at([app, bar, ribbon], "display", 640)).toBe("none");
    expect(at([app, bar, ribbon], "display", 641)).not.toBe("none");
  });
});
