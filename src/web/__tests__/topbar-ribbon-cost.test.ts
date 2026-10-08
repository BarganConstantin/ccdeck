// A running agent's ribbon ran its cost and × over the controls.
//
// The ribbon naming the selected agent comes back to the bar at 641px
// (topbar-ribbon-room.test.ts), and nothing held its cost back: a running
// agent's "$3.96 · 88¢/min" does not shrink, so it kept its width while the
// name ellipsed to nothing, and the rest ran on past the ribbon's edge — at 641
// the × was drawn 67px into the controls, and from 720 to 750 it sat on the
// Session list button and took its presses. The cost is in the agent's card,
// in the detail panel and in the ribbon's own title, so the ribbon drops it
// wherever the bar cannot hold it.
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

/** A running agent's cost and rate, "$3.96 · 88¢/min", measured in Chromium,
 *  light and dark alike. It does not shrink, and a costlier agent's is wider. */
const RUNNING_COST_PX = 93;

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
const cost = el("span", ["selected-cost"]);

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
const drawn = (chain: El[], width: number) => at(chain, "display", width) !== "none";

/** The least a running agent's ribbon can be at `width` and still draw what
 *  the cascade leaves in it inside its own edge: its padding and border, the
 *  state, the name ellipsed to nothing, the cost where it is drawn, and the ×,
 *  with the ribbon's gap between each. */
function runningRibbonAt(width: number): number {
  const [, right, , left] = sides(at([app, bar, ribbon], "padding", width));
  const border = px((at([app, bar, ribbon], "border", width) ?? "").split(/\s+/)[0]);
  const gap = px(at([app, bar, ribbon], "gap", width));
  const withCost = drawn([app, bar, ribbon, cost], width);
  return left + right + 2 * border + STATE_PILL_PX + 2 * gap
    + (withCost ? RUNNING_COST_PX + gap : 0)
    + px(at([app, bar, ribbon, close], "width", width));
}

/** Either side of the ribbon's return, the edge of the cost's band, and the
 *  widths people run the deck at. */
const WIDTHS = [640, 641, 660, 700, 720, 750, 765, 800, 900, 1024, 1139, 1140, 1280, 1440, 1920];

describe("a running agent's ribbon beside the controls", () => {
  it("reads every number it adds from the sheet", () => {
    for (const w of [641, 800, 1139, 1140]) {
      expect(Number.isFinite(besideRibbonAt(w)), `the bar at ${w}px`).toBe(true);
      expect(runningRibbonAt(w), `the ribbon at ${w}px`).toBeGreaterThan(STATE_PILL_PX);
    }
  });

  it("draws its cost only where the bar holds it, the × inside its edge and off the controls", () => {
    const short: string[] = [];
    for (const w of WIDTHS) {
      if (!drawn([app, bar, ribbon], w)) continue;
      const need = besideRibbonAt(w) + runningRibbonAt(w);
      if (need > w) short.push(`${w}px needs ${need.toFixed(1)}`);
    }
    expect(short).toEqual([]);
  });

  it("is on the bar from 641px, and keeps its cost from where its cap leaves room for it", () => {
    expect(drawn([app, bar, ribbon], 640)).toBe(false);
    expect(drawn([app, bar, ribbon], 641)).toBe(true);
    for (const w of [641, 700, 800, 900, 1024, 1139]) expect(drawn([app, bar, ribbon, cost], w), `${w}px`).toBe(false);
    for (const w of [1140, 1280, 1440, 1920]) expect(drawn([app, bar, ribbon, cost], w), `${w}px`).toBe(true);
  });

  // The sums above say the bar has room for the ribbon at its least; the
  // browser also has to keep it there. In columns where only the name's can go
  // under its content, the ribbon's min-content is that least, and it holds it.
  it("is never cut under its own state, chips and ×, only its name", () => {
    for (const w of [641, 800, 1039, 1040, 1440, 1700]) {
      expect(at([app, bar, ribbon], "display", w), `${w}px`).toBe("inline-grid");
      expect(at([app, bar, ribbon], "grid-auto-flow", w), `${w}px`).toBe("column");
      expect(at([app, bar, ribbon], "grid-template-columns", w), `${w}px`).toBe("auto minmax(0, max-content)");
      expect(at([app, bar, ribbon], "min-width", w), `${w}px`).toBe("min-content");
    }
  });
});
