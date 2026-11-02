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
// The wait reserves the chart room and keeps its baseline. Its decorative
// file-to-report illustration shows activity, never sample values or measured
// progress. When data arrives, the actual columns rise from that baseline in
// chronological order.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withoutComments } from "./tsx-scan";
import { usageHistorySurface } from "./usage-history-surface";
import { sheetText } from "./sheet-source";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const css = sheetText();
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
    // Asked of the modal and every file lifted out of it.
    expect(withoutComments(usageHistorySurface())).not.toMatch(/skeleton|shimmer|placeholder-bar/i);
    // The wait keeps a word group and a baseline; its SVG is decorative.
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
    const packets = block(".uh-reading-packets rect");
    expect(packets).toMatch(/animation: uh-reading-transfer 1800ms/);
    expect(packets).toMatch(/infinite/);
    // Packets travel along the connection without changing layout.
    const sweep = frames("uh-reading-transfer");
    expect(sweep).toMatch(/translateX/);
    expect(sweep).not.toMatch(/width|height|margin/);
  });
});

describe("the days land on it, oldest first", () => {
  it("rises with a transform, so a 2px item cannot reflow the label above it", () => {
    const bar = block(".uh-bar");
    expect(bar).toMatch(/transform-origin: bottom/);
    // V4's motion rules (rule 6): a transition from @starting-style, not a
    // keyframe, so a range that changes mid-rise turns round from where it is.
    expect(bar).toMatch(/transition:[^;]*\btransform var\(--dur-slow\) var\(--ease\)/);
    // At rest the bar has its real height and no transform; the squash is the rise only.
    expect(bar).toMatch(/height: calc\(var\(--uh-h, 1\) \* 100%\)/);
    expect(bar).toMatch(/transform: none/);
    expect(bar).not.toMatch(/transform:\s*scaleY/);
    expect(css).not.toMatch(/@keyframes uh-bar-rise/);
    expect(css).toMatch(/@starting-style \{ \.uh-bar \{ transform: scaleY\(0\); opacity: 0\.4; \} \}/);
    // The only layout property that eases is the height, for a range that
    // changes under an open chart (#863); nothing else.
    expect(bar).not.toMatch(/transition:[^;]*\b(width|margin|padding|top|left)\b/);
  });

  it("starts flat, so no frame paints the chart at full height first", () => {
    // The @starting-style value is what the first frame paints, so the whole
    // chart never paints full-size for one frame and then drops.
    expect(css).toMatch(/@starting-style \{ \.uh-bar \{ transform: scaleY\(0\)/);
  });

  it("divides the stagger rather than fixing it, so 90 days is not 90 delays", () => {
    // A per-column delay makes the longest range the slowest to appear, which
    // is backwards: the longer the range, the more the reader is waiting on.
    // The span is 160ms whatever the count, and the per-step cap keeps a short
    // range reading as a sequence rather than as one block.
    expect(modal).toMatch(/"--uh-step": `\$\{Math\.min\(10, 160 \/ Math\.max\(days\.length, 1\)\)\}ms`/);
    expect(modal).toMatch(/"--uh-i": i/);
    // The rise staggers (transform, opacity); the height of a changing range does not.
    expect(block(".uh-bar")).toMatch(/transition-delay: 0s, calc\(var\(--uh-i, 0\) \* var\(--uh-step, 10ms\)\), calc\(var\(--uh-i, 0\) \* var\(--uh-step, 10ms\)\)/);
    // The arithmetic the sentence above depends on, so the cap cannot be
    // loosened without this saying so: at 160ms of span plus a 400ms column (--dur-slow),
    // every range arrives inside the band an authored entrance is allowed.
    for (const n of [7, 14, 30, 90]) {
      const step = Math.min(10, 160 / n);
      expect(step * (n - 1) + 400, `${n} days`).toBeLessThanOrEqual(560);
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
    expect(rm).toContain(".uh-reading-packets rect { animation: none;");
    expect(rm).toContain(".uh-bar { transition: none; }");
  });

  it("keeps the part that was never motion", () => {
    // The reserved box is layout, not animation, so it is outside the media
    // query: a reader who asked for less movement gets the same non-jumping
    // dialog, and the words still say a subprocess is running.
    const rm = reducedMotion();
    expect(rm).not.toMatch(/\.uh-status-wait/);
    expect(modal).toMatch(/t\("insights\.usage\.running"\)/);
  });
});
