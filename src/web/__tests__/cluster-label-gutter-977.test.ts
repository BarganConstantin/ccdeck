// #846 gave the cluster header a constant SCREEN size — the layer carries
// `scale(zoom)` and the pill divides it back out — and left the cap that bounds
// it stated in LAYOUT units. The two stopped being the same thing, and nothing
// noticed because the note that justified the cap reads as if they still were:
// "a capped header stays inside the 240px gutter layout.ts leaves between two
// session columns".
//
// WHAT WAS OBSERVED, in Firefox against src/web/styles.css, with two one-card
// sessions in adjacent columns — cluster boxes at layout x -18 and x 882, both
// 276 wide, which is what layout.ts produces for a 240px card, GROUP_PAD 18, a
// 420px burst lane and a 240px column gap:
//
//   zoom  pill on screen  pill in layout units  past its own box  elementFromPoint
//                                                                 3px inside the
//                                                                 NEXT box
//   1.00      302.7px            302.7                 42.7       the pane
//   0.50      302.7px            605.5                345.5       the pane
//   0.38      302.7px            796.7                536.7       the pane
//   0.32      302.7px            946.0                686.0       THIS BUTTON
//   0.20      302.7px           1513.7               1253.7       THIS BUTTON
//
// and on the empty canvas half way between the two boxes, elementFromPoint
// returned the button from 0.5 down — so a drag there was captured by a label
// belonging to a session on the other side of it, instead of panning.
//
// 0.32 is not a corner: SessionClusters' own note records a real board settling
// there, and styles.css names the same figure. The header measured is this
// file's ordinary one, a workspace plus an ai-title already cut to the 32-column
// cap. `.session-clusters` is `z-index: 0`, so the paint slid under the nodes
// and the damage was all in the hit box: `focusSession` for the wrong session,
// with nothing on screen to explain it.
//
// After the cap, at 0.32 the same pill measures 165.1px — 516 layout units,
// which is its own 276 plus 240 — and every one of those probes returns the
// pane again.
//
// Pure functions and the sheet, like the rest of this suite: no DOM, no layout
// engine. The numbers above are the measurement; what is pinned here is the
// rule that produces them.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { labelMaxWidth } from "../components/SessionClusters";

const at = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const css = at("../styles.css");
const component = at("../components/SessionClusters.tsx");

/** The narrowest cluster there is: one 240px card plus GROUP_PAD on both sides. */
const BOX = 276;
/**
 * Clear canvas between one cluster box's right edge and the next column's left
 * edge, in layout units.
 *
 * A column is `widest session + TOOL_LANE_W (420)` and the gap after it is
 * `columnGap`, which is the widest node and never less than NODE_W (240). The
 * boxes each eat GROUP_PAD (18) of that on the facing side, so the clearance is
 * 420 + 240 - 36 = 624 whatever the sessions inside are — a wider session grows
 * its own box and its column by the same amount.
 */
const CLEARANCE = 624;

/** The zooms the measurement above was taken at. */
const ZOOMS = [1, 0.5, 0.38, 0.32, 0.2];

describe("the header pill is bounded in the unit it is drawn in (#977)", () => {
  it("caps at the cluster's own box plus one card width, in screen px", () => {
    // 165.1px is what the browser measured the capped pill at; the arithmetic
    // is (276 + 240) * 0.32.
    expect(labelMaxWidth(BOX, 0.32)).toBeCloseTo(165.12, 2);
    expect(labelMaxWidth(BOX, 1)).toBe(516);
  });

  it("spends the same 240 layout units at every zoom, which is what makes it a bound", () => {
    // The defect in one line: the pill's LAYOUT extent is what decides whose
    // canvas it lands on, and before the cap that extent was `screen / zoom` —
    // 302.7 units at 1x and 1513.7 at 0.2 for the same pill.
    for (const zoom of ZOOMS) {
      expect(labelMaxWidth(BOX, zoom) / zoom, `zoom ${zoom}`).toBeCloseTo(BOX + 240, 6);
    }
  });

  it("never reaches the next column's box, which is the click that went to the wrong session", () => {
    // 240 of the 624 units of clearance, leaving 384 between the end of the
    // pill and anything belonging to somebody else. Checked for a wide cluster
    // too: the clearance does not grow with the session, so a budget that
    // scaled with the box would eat into it.
    for (const w of [BOX, 400, 680, 1200]) {
      for (const zoom of ZOOMS) {
        const overhang = labelMaxWidth(w, zoom) / zoom - w;
        expect(overhang, `w ${w} @ ${zoom}`).toBeLessThan(CLEARANCE);
      }
    }
  });

  it("survives a zoom of zero rather than capping the header out of existence", () => {
    // React Flow clamps to minZoom 0.2 and never hands one out, so this is the
    // same fallback the transform beside it keeps — but a cap of zero would
    // hide every header, which is worse than the overhang it replaces.
    expect(labelMaxWidth(BOX, 0)).toBe(516);
  });

  it("is the cap the component actually puts on the pill", () => {
    // The rule is only worth pinning if labelStyle is where it lands.
    expect(
      /maxWidth:\s*labelMaxWidth\(c\.w,\s*zoom\)/.test(component),
      "labelStyle does not cap the pill — the rule below is not the one on screen",
    ).toBe(true);
  });
});

describe("the sheet makes the cut read as a cut (#977)", () => {
  it("clips and ellipsises the pill it already refuses to wrap", () => {
    const rule = /\.cluster-label\s*\{([^}]*)\}/.exec(css)![1];
    expect(rule).toMatch(/white-space:\s*nowrap/);
    expect(rule).toMatch(/overflow:\s*hidden/);
    expect(rule).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("still opts the pill into pointer events, which is why the bound is needed", () => {
    // `.session-clusters` is `pointer-events: none` and this button turns them
    // back on. If that ever stops being true the cap is belt without braces —
    // but it is also what makes a click on a session name work at all.
    const rule = /\.cluster-label\s*\{([^}]*)\}/.exec(css)![1];
    expect(rule).toMatch(/pointer-events:\s*auto/);
    expect(css).toMatch(/\.session-clusters\s*\{[^}]*pointer-events:\s*none/);
  });
});
