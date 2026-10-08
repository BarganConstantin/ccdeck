// A running agent's ribbon ran its cost and × over the controls.
//
// The ribbon naming the selected agent comes back to the bar at 641px
// (topbar-ribbon-room.test.ts), and from there to 1040, where #737's caps take
// over, nothing held its cost back: the ribbon's cap is its
// usual 24vw, the bar beside the controls gives it less, and the cost — a
// running agent's "$3.96 · 88¢/min", which does not shrink — kept its width
// while the name ellipsed to nothing. The rest ran on past the ribbon's edge:
// at 641 the × was drawn 67px into the controls, at 700 39px, and from 720 to
// 750 it sat on the Session list button and took its presses.
//
// The cost is in the agent's card, in the detail panel and in the ribbon's own
// title, so the ribbon drops it wherever the bar cannot hold it, as it already
// did from 1040 to 1139. These add the bar up from the sheet's numbers, the way
// the browser lays it out — padding, the waiting pill, the gaps, the ribbon at
// its least with whatever the cascade still draws in it, and the controls in
// their runs — at every width the ribbon is on the bar; and ask the cascade
// whether the ribbon keeps to that least when the bar squeezes it.
import { describe, expect, it } from "vitest";
import { cascade, el, selects, type El } from "./sheet-cascade";

/** The waiting pill with a one-digit count, measured in Chromium on a live
 *  deck: its dot and count alone under 640px, and with "waiting" above. */
const waitingPillPx = (width: number) => (width <= 640 ? 40 : 80);
/** "LIVE" with its pulsing dot, the widest state the ribbon names. */
const STATE_PILL_PX = 53;
/** A running agent's cost and rate, "$3.96 · 88¢/min", measured in Chromium,
 *  light and dark alike. It does not shrink, and a costlier agent's is wider. */
const RUNNING_COST_PX = 93;

const html = el("html", [], { states: ["root"] });
const app = el("div", ["app"]);
const bar = el("header", ["topbar"]);
const actions = el("div", ["actions"]);
const run = el("div", ["action-run"]);
const utility = el("div", ["action-run", "action-run-utility"]);
const button = (...more: string[]) => el("button", ["btn", "icon-btn", ...more]);
const ribbon = el("button", ["selected-ribbon"]);
const close = el("span", ["selected-close"]);
const cost = el("span", ["selected-cost"]);

/** The bar's controls, run by run, as TopbarRuns.tsx and TopbarMore.tsx draw them. */
const RUNS: { run: El; controls: El[][] }[] = [
  { run, controls: [[button()], [button()], [button("tb-fold")]] },
  { run, controls: [[button()], [button()], [button("bw-btn", "tb-fold")]] },
  { run: utility, controls: [
    [button()],                                                                          // Settings
    [button("tb-fold")], [button("tb-more")],
  ] },
];

const px = (v: string | null, vars: Record<string, number> = {}): number => {
  if (v == null) return 0;
  const named = /^var\((--[\w-]+)\)$/.exec(v);
  if (named) return vars[named[1]] ?? NaN;
  const m = /^(-?[\d.]+)px$/.exec(v);
  return m ? Number(m[1]) : v === "0" ? 0 : NaN;
};
const at = (chain: El[], prop: string, width: number) => cascade(sel => selects(sel, chain), prop, width);
const drawn = (chain: El[], width: number) => at(chain, "display", width) !== "none";
/** A shorthand's sides, top right bottom left, as the browser expands it. */
const sides = (v: string | null) => {
  const p = (v ?? "0").split(/\s+/).map(s => px(s));
  return [p[0], p[1] ?? p[0], p[2] ?? p[0], p[3] ?? p[1] ?? p[0]];
};

/** Everything on the bar at `width` but the ribbon: its padding, the waiting
 *  pill, the two gaps either side of the ribbon, and the controls' runs. */
function besideRibbonAt(width: number): number {
  const vars = { "--ctl-h": px(at([html], "--ctl-h", width)) };
  let controls = 0, runsDrawn = 0;
  for (const r of RUNS) {
    const shown = r.controls.filter(c => drawn([bar, actions, r.run, ...c], width));
    if (shown.length === 0) continue;
    runsDrawn++;
    controls += shown.length * px(at([bar, actions, r.run, ...shown[0]], "width", width), vars)
      + (shown.length - 1) * px(at([bar, actions, r.run], "gap", width))
      + px(at([bar, actions, r.run], "margin-left", width));
  }
  controls += (runsDrawn - 1) * px(at([bar, actions], "gap", width));
  const gap = px(at([bar], "gap", width));
  return sides(at([bar], "padding", width))[1] * 2 + waitingPillPx(width) + 2 * gap + controls;
}

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

/** Either side of the ribbon's return, then a step at a time up to the words'
 *  arrival, and the edges of the cost's bands. */
const WIDTHS = [
  600, 620, 640, 641, ...Array.from({ length: 24 }, (_, i) => 645 + i * 5),
  ...Array.from({ length: 33 }, (_, i) => 780 + i * 20), 1039, 1040, 1139, 1140, 1439,
];

describe("a running agent's ribbon beside the controls", () => {
  it("reads every number it adds from the sheet", () => {
    for (const w of [641, 800, 1039, 1140]) {
      expect(Number.isFinite(besideRibbonAt(w)), `the bar at ${w}px`).toBe(true);
      expect(runningRibbonAt(w), `the ribbon at ${w}px`).toBeGreaterThan(STATE_PILL_PX);
    }
  });

  it("draws its cost only where the bar holds it, the × inside its edge and off the controls", () => {
    const short: string[] = [];
    for (const w of WIDTHS) {
      if (!drawn([app, bar, ribbon], w)) continue;
      const need = besideRibbonAt(w) + runningRibbonAt(w);
      if (need > w) short.push(`${w}px needs ${need}`);
    }
    expect(short).toEqual([]);
  });

  it("is on the bar from 641px, and keeps its cost from where the cap leaves room for it", () => {
    expect(drawn([app, bar, ribbon], 640)).toBe(false);
    expect(drawn([app, bar, ribbon], 641)).toBe(true);
    for (const w of [641, 700, 800, 900, 1039, 1040, 1139]) expect(drawn([app, bar, ribbon, cost], w), `${w}px`).toBe(false);
    for (const w of [1140, 1439]) expect(drawn([app, bar, ribbon, cost], w), `${w}px`).toBe(true);
  });

  // The sums above say the bar has room for the ribbon at its least; the
  // browser also has to keep it there. The bar shrinks the ribbon with the
  // readout, in proportion to their widths, and a ribbon with `min-width: 0`
  // has no least: a short name or a +N chip had it cut under its own state and
  // ×, and the × was drawn past its edge — with a +2 chip, 18px into the
  // Session list button at 641. In columns where only the name's can go under
  // its content, the ribbon's min-content is that least, and it holds it.
  it("is never cut under its own state, chips and ×, only its name", () => {
    for (const w of [641, 800, 1039, 1040, 1440, 1700]) {
      expect(at([app, bar, ribbon], "display", w), `${w}px`).toBe("inline-grid");
      expect(at([app, bar, ribbon], "grid-auto-flow", w), `${w}px`).toBe("column");
      expect(at([app, bar, ribbon], "grid-template-columns", w), `${w}px`).toBe("auto minmax(0, max-content)");
      expect(at([app, bar, ribbon], "min-width", w), `${w}px`).toBe("min-content");
    }
  });
});
