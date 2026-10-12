// At a phone's width the topbar ran off its left edge.
//
// The controls do not shrink (#849): the readout group gives first, from the
// left, so a narrow bar loses its wordmark and keeps every way in. Feedback
// joined the controls (#1853) and nine of them came to 314px, which a 360px bar
// cannot hold beside anything: the readout group was left a sliver, the waiting
// pill — the one light the bar exists to show — was cut off at x=-15, and at
// 320 the last control went past the right edge too. With an agent selected,
// the ribbon squeezed under its own state pill and × drew them over the Session
// list button. Under 480px History, Browser watch and Feedback folded into a ⋯
// for it, and the ribbon left the bar.
//
// THE BAR HOLDS NO CONTROL ON A PHONE NOW. The panel toggles left the topbar
// for the window's edges (2026-10-08), and under 641px the edges and the
// topbar's two utilities are one dock along the bottom (EdgeRails.tsx,
// edge-dock-phone.test.ts) — so the ⋯ went with the fold it held, and the bar
// is the readout alone: the mark, the stream's pill when it has something to
// say, and the waiting count, which has the room for its word again. What is
// pinned here is the guarantee the fold was for — the count whole on every
// phone, beside the widest thing the bar can draw ahead of it — and that
// nothing a selection or a control adds can take that room back.
//
// The numbers are the sheet's own where the sheet has them (padding, gaps,
// what is drawn at which width), and measured in headless Brave on a demo deck
// where only a browser can say (a word's width).
import { describe, expect, it } from "vitest";
import { cascade, el, selects, type El } from "./sheet-cascade";
import { sourceOf } from "./client-source";

/** The kit's small mark, drawn 19px wide at its 16px height (TopbarReadouts.tsx). */
const MARK_PX = 19;
/** The waiting count with one digit and its word, "1 waiting", measured. */
const WAITING_COUNT_PX = 91;
/** What each further digit of the count adds: one 14px bold tabular figure. */
const DIGIT_PX = 9;
/** The stream pill at its widest, the paused tone's worst case, which the pill
 *  holds while it is drawn at all — measured, status-pill.ts. */
const PAUSED_PILL_PX = 103;
/** Settings and Feedback with their words, measured at 86 and 95. */
const UTILITIES_PX = [86, 95];

const bar = el("header", ["topbar"]);
const readout = el("div", ["readout"]);

const px = (v: string | null): number => {
  if (v == null || v === "0") return 0;
  const m = /^(-?[\d.]+)px$/.exec(v);
  return m ? Number(m[1]) : NaN;
};
const at = (chain: El[], prop: string, width: number) => cascade(sel => selects(sel, chain), prop, width);
/** A shorthand's sides, top right bottom left, as the browser expands it. */
const sides = (v: string | null) => {
  const p = (v ?? "0").split(/\s+/).map(px);
  return [p[0], p[1] ?? p[0], p[2] ?? p[0], p[3] ?? p[1] ?? p[0]];
};

/** The bar at `width`: its inline padding, the gap inside the readout, and
 *  whether each thing that could take the count's room is drawn there. */
function barAt(width: number) {
  const pad = sides(at([bar], "padding", width));
  return {
    inline: pad[1] + pad[3],
    gap: px(at([bar, readout], "gap", width)),
    word: at([bar, readout, el("button", ["waiting-stat"]), el("span", ["ws-word"])], "display", width) !== "none",
    ribbon: at([el("div", ["app"]), bar, el("button", ["selected-ribbon"])], "display", width) !== "none",
  };
}

const PHONES = [320, 360, 390, 412, 480, 640];

describe("the topbar at a phone's width", () => {
  it("reads every number it adds from the sheet", () => {
    for (const w of PHONES) {
      const b = barAt(w);
      expect(Number.isFinite(b.inline), `padding at ${w}px`).toBe(true);
      expect(Number.isFinite(b.gap), `gap at ${w}px`).toBe(true);
    }
  });

  for (const w of PHONES) {
    it(`keeps a two-digit waiting count whole, with its word, beside a paused pill at ${w}px`, () => {
      const b = barAt(w);
      expect(b.word, "the count says its word on a phone").toBe(true);
      const count = WAITING_COUNT_PX + DIGIT_PX;
      expect(b.inline + MARK_PX + b.gap + PAUSED_PILL_PX + b.gap + count, `at ${w}px`).toBeLessThanOrEqual(w);
    });

    it(`leaves no selection ribbon to take the count's room at ${w}px`, () => {
      expect(barAt(w).ribbon).toBe(false);
    });
  }

  it("draws no control on the bar under 641px: the dock holds them all, and the queue's names stay off it", () => {
    // App.tsx mounts the topbar's utilities and the waiting queue's names only
    // above a phone's width, and the dock below it — the swap
    // edge-dock-phone.test.ts holds to the sheet's own breakpoint.
    const app = sourceOf("App.tsx");
    expect(app).toMatch(/\{!phone && <div className="actions"><UtilityRun items=\{rails\.utilities\} \/><\/div>\}/);
    expect(app).toMatch(/\{!phone && \(\s*<WaitingNames\b/);
    expect(app).toMatch(/\{phone\s*\?\s*<EdgeDock\b/);
    expect(app).not.toMatch(/TopbarMore|tb-more|tb-fold/);
  });

  it("keeps both utilities whole beside the count from the first width that has them", () => {
    // At 641 the bar is its widest padding, a two-digit count, the gap to the
    // utilities and the pair: the readout gives first from the left (#849),
    // so this is the least the bar has to hold, and it holds it.
    const w = 641;
    const pad = sides(at([bar], "padding", w));
    const between = px(at([bar], "gap", w));
    const pair = UTILITIES_PX[0] + px(at([bar, el("div", ["actions"]), el("div", ["utility-run"])], "gap", w)) + UTILITIES_PX[1];
    expect(pad[1] + pad[3] + WAITING_COUNT_PX + DIGIT_PX + between + pair).toBeLessThanOrEqual(w);
  });
});
