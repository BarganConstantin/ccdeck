// Just above a phone's width, a selection cut the waiting pill off the bar.
//
// Under 480px the ribbon naming the selected agent leaves the bar, and History,
// Browser watch and Feedback fold into the ⋯ (topbar-phone-width.test.ts). At
// 481 all nine controls are back, and so was the ribbon, at its floor — a
// state, a name ellipsed to nothing and its × — with no room for it: the
// readout gives first, so the waiting pill lost up to 5px of its left edge
// from 481 to 499, and with a running agent's cost in the ribbon up to 15px,
// as far as 520, while the cost and the × ran on over the Session list button.
//
// Below 640px the detail sheet stands over the canvas, its hero naming the
// agent with its own ×, so the ribbon says nothing the sheet does not; with the
// sheet closed the card on the canvas still says which agent it is. So the
// ribbon leaves the bar at the sheet's own narrow breakpoint, and from there up
// the bar holds the pill beside it whole. These add the bar up from the sheet's
// numbers, the way the browser lays it out: padding, the waiting pill, the gap
// between the groups, the ribbon at its floor, and the controls in their runs.
import { describe, expect, it } from "vitest";
import { cascade, el, selects, type El } from "./sheet-cascade";

/** The waiting pill with a one-digit count, measured in Chromium on a live
 *  deck: its dot and count alone under 640px, where the word is dropped, and
 *  with "waiting" above. */
const waitingPillPx = (width: number) => (width <= 640 ? 40 : 80);
/** The widest state the ribbon names, "LIVE" with its pulsing dot, measured
 *  in Chromium. "DONE" and "ERR" are narrower. */
const STATE_PILL_PX = 53;

const html = el("html", [], { states: ["root"] });
const app = el("div", ["app"]);
const bar = el("header", ["topbar"]);
const actions = el("div", ["actions"]);
const run = el("div", ["action-run"]);
const utility = el("div", ["action-run", "action-run-utility"]);
const button = (...more: string[]) => el("button", ["btn", "icon-btn", ...more]);
const ribbon = el("button", ["selected-ribbon"]);
const close = el("span", ["selected-close"]);

/** The bar's controls, run by run, as TopbarRuns.tsx and TopbarMore.tsx draw them. */
const RUNS: { run: El; controls: El[][] }[] = [
  { run, controls: [[button()], [button()], [button("tb-fold")]] },
  { run, controls: [[button()], [button()], [button("bw-btn", "tb-fold")]] },
  { run: utility, controls: [
    [el("div", ["sound-slot"]), button()], [button()],                                    // Sound, Settings
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
/** A shorthand's sides, top right bottom left, as the browser expands it. */
const sides = (v: string | null) => {
  const p = (v ?? "0").split(/\s+/).map(s => px(s));
  return [p[0], p[1] ?? p[0], p[2] ?? p[0], p[3] ?? p[1] ?? p[0]];
};

/** The bar at `width`: its padding and gap, the controls' run, and whether
 *  the ribbon is drawn there. */
function barAt(width: number) {
  const vars = { "--ctl-h": px(at([html], "--ctl-h", width)) };
  const drawn = (chain: El[]) => at(chain, "display", width) !== "none";
  let total = 0, runsDrawn = 0;
  for (const r of RUNS) {
    const shown = r.controls.filter(c => drawn([bar, actions, r.run, ...c]));
    if (shown.length === 0) continue;
    runsDrawn++;
    total += shown.length * px(at([bar, actions, r.run, ...shown[0]], "width", width), vars)
      + (shown.length - 1) * px(at([bar, actions, r.run], "gap", width))
      + px(at([bar, actions, r.run], "margin-left", width));
  }
  total += (runsDrawn - 1) * px(at([bar, actions], "gap", width));
  return {
    padding: sides(at([bar], "padding", width))[1],
    gap: px(at([bar], "gap", width)),
    actions: total,
    ribbon: drawn([app, bar, ribbon]),
  };
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

/** Every width either side of the old breakpoint, then a step at a time to
 *  the glyph band, where monthly-topbar-737.test.ts does this sum instead. */
const WIDTHS = [
  ...Array.from({ length: 41 }, (_, i) => 470 + i),
  ...Array.from({ length: 19 }, (_, i) => 520 + i * 10), 641, 800, 900, 1039,
];

describe("a selected agent's ribbon beside the waiting pill", () => {
  it("reads every number it adds from the sheet", () => {
    for (const w of [481, 640, 641, 1039]) {
      const b = barAt(w);
      for (const [k, v] of Object.entries(b)) expect(Number.isFinite(Number(v)), `${k} at ${w}px`).toBe(true);
      expect(ribbonFloorAt(w), `the ribbon's floor at ${w}px`).toBeGreaterThan(STATE_PILL_PX);
    }
  });

  it("is drawn only where the bar holds it, the pill and every control whole", () => {
    const short: string[] = [];
    for (const w of WIDTHS) {
      const b = barAt(w);
      if (!b.ribbon) continue;
      const need = b.padding * 2 + waitingPillPx(w) + b.gap + ribbonFloorAt(w) + b.gap + b.actions;
      if (need > w) short.push(`${w}px needs ${need}`);
    }
    expect(short).toEqual([]);
  });

  it("leaves the bar where the detail sheet stands over the canvas, and is back beside it", () => {
    expect(barAt(481).ribbon).toBe(false);
    expect(barAt(640).ribbon).toBe(false);
    expect(barAt(641).ribbon).toBe(true);
  });
});
