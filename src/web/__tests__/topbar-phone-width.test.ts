// At a phone's width the topbar ran off its left edge.
//
// The controls do not shrink (#849): the readout group gives first, from the
// left, so a narrow bar loses its wordmark and keeps every way in. Feedback
// joined the controls (#1853) and nine of them came to 314px, which a 360px bar
// cannot hold beside anything: the readout group was left a sliver, the waiting
// pill — the one light the bar exists to show — was cut off at x=-15, and at
// 320 the last control went past the right edge too. With an agent selected,
// the ribbon squeezed under its own state pill and × drew them over the Session
// list button.
//
// So, under 480px, History, Browser watch and Feedback fold into a ⋯
// (TopbarMore.tsx) and the ribbon leaves the bar. These ask the cascade which
// controls are drawn at each phone width, and add the bar up from the sheet's
// own numbers, the way the browser lays it out: padding, the readout's waiting
// pill, the gap between the two groups, and the controls in their runs.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cascade, el, selects, type El } from "./sheet-cascade";
import { sourceOf } from "./client-source";
import TopbarMore from "../components/TopbarMore";

/** The waiting pill at the sheet's narrow breakpoint — its dot and a one-digit
 *  count, the word dropped — measured in Chromium on a live deck. */
const WAITING_PILL_PX = 40;

const html = el("html", [], { states: ["root"] });
const app = el("div", ["app"]);
const bar = el("header", ["topbar"]);
const actions = el("div", ["actions"]);
const run = el("div", ["action-run"]);
const utility = el("div", ["action-run", "action-run-utility"]);
const button = (...more: string[]) => el("button", ["btn", "icon-btn", ...more]);

/** The bar's controls, run by run, as TopbarRuns.tsx and TopbarMore.tsx draw them. */
const RUNS: { run: El; controls: El[][] }[] = [
  { run, controls: [[button()], [button()], [button("tb-fold")]] },                     // Session list, Usage, History
  { run, controls: [[button()], [button()], [button("bw-btn", "tb-fold")]] },           // Accounts, Machine, Browser watch
  { run: utility, controls: [
    [el("div", ["sound-slot"]), button()], [el("div", ["appearance-slot"]), button()],   // Sound, Appearance
    [button("tb-fold")], [button("tb-more")],                                            // Feedback, ⋯
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

function barAt(width: number) {
  const vars = { "--ctl-h": px(at([html], "--ctl-h", width)) };
  const drawn = (chain: El[]) => at(chain, "display", width) !== "none";
  let controls = 0, total = 0, runsDrawn = 0;
  for (const r of RUNS) {
    const shown = r.controls.filter(c => drawn([bar, actions, r.run, ...c]));
    if (shown.length === 0) continue;
    controls += shown.length;
    runsDrawn++;
    total += shown.length * px(at([bar, actions, r.run, ...shown[0]], "width", width), vars)
      + (shown.length - 1) * px(at([bar, actions, r.run], "gap", width))
      + px(at([bar, actions, r.run], "margin-left", width));
  }
  total += (runsDrawn - 1) * px(at([bar, actions], "gap", width));
  const padding = px(at([bar], "padding", width).split(/\s+/)[1] ?? null);
  return { controls, actions: total, padding, gap: px(at([bar], "gap", width)) };
}

const ribbonDrawn = (width: number) => at([app, bar, el("button", ["selected-ribbon"])], "display", width) !== "none";

const PHONES = [320, 360, 390, 412, 480];

describe("the topbar at a phone's width", () => {
  it("reads every number it adds from the sheet", () => {
    for (const w of PHONES) {
      const b = barAt(w);
      for (const [k, v] of Object.entries(b)) expect(Number.isFinite(v), `${k} at ${w}px`).toBe(true);
    }
  });

  for (const w of PHONES) {
    it(`keeps the waiting pill whole beside the controls at ${w}px`, () => {
      const b = barAt(w);
      expect(b.padding * 2 + WAITING_PILL_PX + b.gap + b.actions, `controls ${b.actions}px`).toBeLessThanOrEqual(w);
    });

    it(`leaves no selection ribbon to squeeze over the controls at ${w}px`, () => {
      expect(ribbonDrawn(w)).toBe(false);
    });
  }

  it("keeps every control above a phone's width, and the ⋯ off the bar there", () => {
    // Up to 1440, where the controls grow their words and topbar-words-836
    // does this arithmetic instead.
    for (const w of [481, 640, 1024, 1439]) {
      const b = barAt(w);
      expect(b.controls, `at ${w}px`).toBe(9);
      expect(b.padding * 2 + b.actions, `at ${w}px`).toBeLessThanOrEqual(w);
    }
    expect(barAt(390).controls).toBe(7);
  });
});

describe("the ⋯ that holds them", () => {
  const markup = (unseen: number) => renderToStaticMarkup(createElement(TopbarMore, {
    watchUnseen: unseen, setUsageHistoryOpen: () => {}, setBrowserWatchOpen: () => {}, onFeedback: () => {},
  }));

  it("is a menu button that says what it holds, and carries Browser watch's unread count", () => {
    expect(markup(0)).toMatch(/aria-haspopup="menu"/);
    expect(markup(0)).toMatch(/aria-expanded="false"/);
    expect(markup(0)).toMatch(/aria-label="More: usage history, Browser watch, feedback"/);
    expect(markup(3)).toMatch(/aria-label="More: usage history, Browser watch, feedback, 3 unread"/);
    expect(markup(3)).toMatch(/<span class="bw-badge" aria-hidden="true">3<\/span>/);
  });

  it("is what the three folded buttons fold into", () => {
    const runs = sourceOf("components/TopbarRuns.tsx");
    expect(runs.match(/className="btn icon-btn(?: bw-btn)? tb-fold"/g)).toHaveLength(3);
    expect(runs).toMatch(/<TopbarMore\s/);
  });
});
