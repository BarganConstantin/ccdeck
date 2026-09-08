// The Usage history modal's wait, and the arrival it was hiding.
//
// MEASURED BEFORE ANY OF IT WAS DRAWN, and the measurement is the reason there
// is anything here at all:
//
//   busy   186px tall     "running ccusage…" on one line, in an empty box
//   loaded 429px tall
//   wait   2.4-4.4s
//
// So four seconds after a keypress the dialog grew by 243px — and it is
// centred, so it lurched 121px upward under the pointer that had just been on
// the range buttons. That is not a missing flourish, it is a layout jump with a
// four-second fuse.
//
// The thesis: the axis arrives before the days, and the days land on it oldest
// first. The wait stands in the room the chart will need and draws only the
// hairline the columns are measured against — furniture, which is honest before
// there is data, rather than a skeleton of grey bars, which stands in for
// CONTENT nobody has yet. Then the columns rise from that same line, left to
// right, because left to right is not a decorative sweep on this chart: it is
// the order the days were lived in.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withoutComments } from "./tsx-scan";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const css = read("../styles.css");
const modal = read("../components/UsageHistoryModal.tsx");
/** The markup with its prose gone. This file's own comments say the words its
 *  "appears nowhere" assertions look for — "not a skeleton of grey bars" is a
 *  sentence explaining why there is no skeleton, and a substring match cannot
 *  tell the explanation from the thing. */
const code = withoutComments(modal);

/** A rule's body by exact selector, the way the rest of this suite reads CSS. */
const block = (selector: string) => {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
};
const frames = (name: string) => {
  const at = css.indexOf(`@keyframes ${name}`);
  expect(at, `no @keyframes ${name}`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("\n}", at));
};

describe("the wait stands in the room the answer needs", () => {
  it("reserves the chart's own height, read off the chart's own rule", () => {
    // 184 = .uh-chart's 168px plus the 16px it reserves for date labels. Both
    // numbers are asserted against that rule rather than trusted here, so the
    // placeholder and the thing it stands in for cannot drift apart.
    const chart = block(".uh-chart");
    expect(chart).toMatch(/height: 168px/);
    expect(chart).toMatch(/padding-bottom: 16px/);
    expect(block(".uh-status-wait")).toMatch(/min-height: 184px/);
  });

  it("reserves the chart and stops there, rather than faking the numbers", () => {
    // The totals, the provider bar and the legend are CONTENT — four cards with
    // figures in them, and a legend whose height depends on how many models ran.
    // Reserving those would mean drawing plausible empty cards for a reading
    // that has not come back, which is the shape of lie this panel refuses
    // everywhere else. The largest single fixed piece is taken; the rest
    // arrives.
    expect(css).not.toMatch(/\.uh-(totals|legend|agents)-skeleton/);
    expect(code).not.toMatch(/skeleton|shimmer|placeholder-bar/i);
    // And the wait draws exactly one thing: the axis.
    const wait = modal.slice(modal.indexOf('className="uh-status uh-status-wait"'), modal.indexOf('view.phase === "error"'));
    expect([...wait.matchAll(/className="uh-wait-/g)]).toHaveLength(2);
  });

  it("draws the axis where the chart will draw it", () => {
    // Same hairline token, so nothing about the line moves when the columns
    // land on it.
    expect(block(".uh-chart")).toMatch(/border-bottom: 1px solid var\(--line-soft\)/);
    expect(block(".uh-wait-axis")).toMatch(/var\(--line-soft\)/);
  });

  it("travels rather than fills, because no progress was measured", () => {
    // The deck knows a subprocess is running and does not know how far through
    // the logs it is. A bar that filled would be claiming a number nobody has.
    const axis = block(".uh-wait-axis");
    expect(axis).toMatch(/animation: uh-wait-sweep 1600ms/);
    expect(axis).toMatch(/infinite/);
    // Paint on a 1px strip: a background position, never a width.
    const sweep = frames("uh-wait-sweep");
    expect(sweep).toMatch(/background-position/);
    expect(sweep).not.toMatch(/width|height|transform|margin/);
  });
});

describe("the days land on it, oldest first", () => {
  it("rises with a transform, so a 2px item cannot reflow the label above it", () => {
    const bar = block(".uh-bar");
    expect(bar).toMatch(/transform-origin: bottom/);
    expect(bar).toMatch(/animation: uh-bar-rise 340ms/);
    const rise = frames("uh-bar-rise");
    expect(rise).toMatch(/scaleY\(0\)/);
    expect(rise).toMatch(/scaleY\(1\)/);
    // The height transition beside it belongs to a range that CHANGES while the
    // chart is up; this belongs to a chart that was not there a moment ago. The
    // entrance must not be the one animating layout.
    expect(rise).not.toMatch(/\bwidth\b|\bheight\b|\bmargin\b|\bpadding\b|\btop\b|\bleft\b/);
  });

  it("starts flat, so no frame paints the chart at full height first", () => {
    // Without a backwards fill the whole chart paints full-size for one frame
    // and then drops — which is the jump this replaces, arriving 16ms later.
    expect(block(".uh-bar")).toMatch(/animation: uh-bar-rise 340ms [^;]*\bboth\b/);
  });

  it("divides the stagger rather than fixing it, so 90 days is not 90 delays", () => {
    // A per-column delay makes the longest range the slowest to appear, which
    // is backwards: the longer the range, the more the reader is waiting on.
    // The span is 200ms whatever the count, and the per-step cap keeps a short
    // range reading as a sequence rather than as one block.
    expect(modal).toMatch(/"--uh-step": `\$\{Math\.min\(10, 200 \/ Math\.max\(days\.length, 1\)\)\}ms`/);
    expect(modal).toMatch(/"--uh-i": i/);
    expect(block(".uh-bar")).toMatch(/animation-delay: calc\(var\(--uh-i, 0\) \* var\(--uh-step, 10ms\)\)/);
    // The arithmetic the sentence above depends on, so the cap cannot be
    // loosened without this saying so: at 200ms of span plus a 340ms column,
    // every range arrives inside the band an authored entrance is allowed.
    for (const n of [7, 14, 30, 90]) {
      const step = Math.min(10, 200 / n);
      expect(step * (n - 1) + 340, `${n} days`).toBeLessThanOrEqual(560);
    }
  });

  it("is the index of the day, not of the tallest bar", () => {
    // `days.map((d, i) =>` — the stagger has to follow the array the chart is
    // drawn from, which is chronological. Any other order would make the sweep
    // decorative, and a decorative stagger is the thing this is not.
    expect(modal).toContain("{days.map((d, i) => {");
  });
});

/** EVERY `@media (prefers-reduced-motion: reduce)` block, each bounded to its
 *  own braces and joined.
 *
 *  There are eighteen of them in this sheet — the rules live next to the
 *  animations they switch off rather than in one pile — so `indexOf` finds a
 *  block four thousand lines from the one being asserted about. And slicing to
 *  the END OF THE FILE, which is what this did first, reads the whole rest of
 *  the sheet as if it were inside the query: the "is in here" half then passes
 *  for any rule that happens to come later, and the "is NOT in here" half fails
 *  on prose. Both halves have to read the same bounded text. */
function reducedMotion(): string {
  const out: string[] = [];
  for (let at = css.indexOf("@media (prefers-reduced-motion: reduce)"); at !== -1;
       at = css.indexOf("@media (prefers-reduced-motion: reduce)", at + 1)) {
    let depth = 0;
    for (let i = css.indexOf("{", at); i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) { out.push(css.slice(at, i + 1)); break; }
    }
  }
  expect(out.length, "no reduced-motion blocks").toBeGreaterThan(0);
  return out.join("\n");
}

describe("reduced motion keeps the meaning and drops the movement", () => {
  it("stops both loops and both entrances", () => {
    const rm = reducedMotion();
    expect(rm).toContain(".uh-wait-axis { animation: none; }");
    expect(rm).toContain(".uh-bar { animation: none; }");
  });

  it("keeps the part that was never motion", () => {
    // The reserved box is layout, not animation, so it is outside the media
    // query: a reader who asked for less movement gets the same non-jumping
    // dialog, and the words still say a subprocess is running.
    const rm = reducedMotion();
    expect(rm).not.toMatch(/\.uh-status-wait/);
    expect(modal).toMatch(/running ccusage…/);
  });
});
