// #671: in a background tab the deck could not move its own camera.
//
// The deck is a dashboard. A tab left open on a second monitor, or behind an
// editor, is how it is used — and a browser does not run requestAnimationFrame
// in a page it is not rendering. Every viewport animation React Flow performs
// is a d3 transition, and a d3 transition is a chain of rAF callbacks, so in
// that tab the fit did not arrive late: it did not arrive. The recenter button
// did nothing. The drift watchdog — the failsafe whose entire purpose is to
// recover a canvas that wandered off WHILE NOBODY WAS LOOKING — could not
// execute in precisely the condition it exists for.
//
// Measured by hand in a hidden deck tab, which is also how the two background
// effects were told apart. Over three seconds: zero rAF callbacks, against
// setTimeout(16ms) callbacks arriving at 1549ms and 3442ms. Chrome's ~1Hz
// background timer clamp (the one #612/#613 measured on the idle render rate)
// slows timers down; rAF is not slowed, it is absent. That difference is the
// whole bug, and it is why the deck's own timeout-based fallback could not
// rescue it — the fallback fired, and then asked for the move through the same
// door.
//
// The trap under the trap: `{ duration: 0 }` is not an escape from it.
//
//   setViewport: (transform, options) => {
//     …
//     d3Zoom.transform(getD3Transition(d3Selection, options?.duration), next);
//   }
//   const getD3Transition = (selection, duration = 0) =>
//     selection.transition().duration(duration);
//
// — @reactflow/core 11.11.4. There is no zero-duration branch: a "non-animated"
// setViewport is still a transition, still waiting on a frame that is not
// coming. The deck's trailing correction was spelled exactly that way and could
// never once have worked. Demonstrated in the same hidden tab, on the library's
// own controls: the + button (`d3Zoom.scaleBy(getD3Transition(…), 1.2)`) moved
// nothing, while the fit-view button (`d3Zoom.transform(d3Selection, t)`, no
// transition, because it is given no duration) landed instantly — rAF at zero
// throughout. The synchronous door works; the transition door does not exist.
//
// So the fix is a rule and a second door, and this file is what a suite with no
// DOM can hold either of to. The rule is pure and lives in viewport-motion.ts,
// so the four cases below are the four states a viewport change can be in. The
// source reading that follows pins the part no pure function can: that the door
// the deck walks through when the answer is "no" is not the one that is broken,
// and that every viewport the deck asks for goes through the one function that
// chooses. What NEITHER can see is the landing itself — that a transform
// applied through d3-zoom reaches the pane, in a tab the browser is not
// rendering. That needs a browser, and it was verified in one; see the pull
// request for the before/after readings.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { shouldAnimateViewport } from "../viewport-motion";

// ── the rule ────────────────────────────────────────────────────────────────

describe("whether a viewport change the deck asks for should animate", () => {
  it("animates in a page the browser is rendering", () => {
    // The ordinary case, and the one that must not change: a canvas that
    // teleports is disorienting, which is the reason the animation exists.
    expect(shouldAnimateViewport({ durationMs: 500, documentHidden: false })).toBe(true);
  });

  it("does not animate in a page the browser is not rendering", () => {
    // Not "animates faster" and not "animates without frames" — there are no
    // frames, so an animation asked for here is a move that never happens.
    expect(shouldAnimateViewport({ durationMs: 500, documentHidden: true })).toBe(false);
  });

  it("does not animate a hidden page at any duration the deck uses", () => {
    // 400 the recenter button and the layout re-fit, 500 the debounced fit and
    // the panel toggles, 600 the drift watchdog's recovery. All the same
    // answer: the tab is not being rendered, so none of them can animate.
    for (const durationMs of [400, 500, 600]) {
      expect(shouldAnimateViewport({ durationMs, documentHidden: true })).toBe(false);
    }
  });

  it("does not animate a change that asked for no animation", () => {
    // The restored viewport and the trailing correction ask for zero, and mean
    // it. A negative or non-finite duration is nobody's intention either.
    expect(shouldAnimateViewport({ durationMs: 0, documentHidden: false })).toBe(false);
    expect(shouldAnimateViewport({ durationMs: -1, documentHidden: false })).toBe(false);
    expect(shouldAnimateViewport({ durationMs: Number.NaN, documentHidden: false })).toBe(false);
    expect(shouldAnimateViewport({ durationMs: Number.POSITIVE_INFINITY, documentHidden: false })).toBe(false);
  });
});

// ── the wiring the rule is useless without ──────────────────────────────────

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

/** The same text with its comments gone — the prose in this repo quotes the
 *  shapes it rejected, so an "appears nowhere" assertion has to read code. */
const appCode = app
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");

/**
 * One function body, from its opening line to the closing brace that matches.
 *
 * Braces are counted rather than a slice of n characters taken, because a fixed
 * slice is an assertion about a length nobody is maintaining: it reads less
 * than the function the day the function grows, and quietly stops covering the
 * lines it was written for. Throws when the opening is not found or the braces
 * never balance, so a rename shows up as a red test naming the function rather
 * than as a matcher passing over an empty string.
 */
function body(opening: string): string {
  const at = appCode.indexOf(opening);
  if (at < 0) throw new Error(`viewport-motion-671: no "${opening}" in App.tsx`);
  // From the arrow, not from the declaration: the first brace after
  // `const applyViewport = useCallback(` belongs to a parameter's type literal,
  // and counting from there would balance after three fields and call that the
  // function.
  const arrow = appCode.indexOf("=>", at);
  const from = arrow < 0 ? -1 : appCode.indexOf("{", arrow);
  if (from < 0) throw new Error(`viewport-motion-671: no body after "${opening}"`);
  let depth = 0;
  for (let i = from; i < appCode.length; i++) {
    if (appCode[i] === "{") depth++;
    else if (appCode[i] === "}") {
      depth--;
      if (depth === 0) return appCode.slice(at, i + 1);
    }
  }
  throw new Error(`viewport-motion-671: unbalanced body after "${opening}"`);
}

const applyViewport = body("const applyViewport = useCallback");
const fitLeft = body("const fitLeft = useCallback");

describe("the one door every viewport the deck asks for goes through", () => {
  it("asks the rule, and animates only when it says so", () => {
    expect(applyViewport).toMatch(/shouldAnimateViewport\(\{\s*durationMs: duration,\s*documentHidden: document\.hidden\s*\}\)/);
    expect(applyViewport).toMatch(/rf\.setViewport\(next, \{ duration \}\)/);
  });

  it("lands the other kind through d3-zoom, not through a zero-duration transition", () => {
    // The whole point. `rf.setViewport(next, { duration: 0 })` here would be a
    // fix that changes nothing: same transition, same missing frame. A
    // selection handed straight to the zoom behaviour applies the transform
    // synchronously, which is the only thing that works with no rAF.
    expect(applyViewport).toMatch(/d3Zoom\.transform\(d3Selection,/);
    expect(applyViewport).toMatch(/storeApi\.getState\(\)/);
  });

  it("keeps every setViewport in the deck inside that door", () => {
    // A fit added next year that calls rf.setViewport directly is the bug
    // again, in a tab nobody is looking at, discovered by nobody. Counting is
    // the assertion: the file may say setViewport as often as it likes, so
    // long as every one of those lines is inside the function that chooses.
    const everywhere = appCode.match(/\brf\.setViewport\(/g) ?? [];
    const insideTheDoor = applyViewport.match(/\brf\.setViewport\(/g) ?? [];
    expect(insideTheDoor.length).toBeGreaterThan(0);
    expect(everywhere.length).toBe(insideTheDoor.length);
  });
});

describe("the two fits the issue was reported for", () => {
  it("moves the pane through the door, from the function the recenter button and the watchdog share", () => {
    // fitLeft is both of them: the button calls it through
    // enableAutoFitAndRefit, the drift watchdog calls it on recovery. One
    // landing to fix, and one to keep fixed.
    expect(fitLeft).toMatch(/applyViewport\(want, duration\)/);
    expect(fitLeft).not.toMatch(/\brf\.setViewport\(/);
  });

  it("corrects a fit that never arrived through the door as well", () => {
    // The trailing check is still worth having — a foreground transition can be
    // interrupted — but it used to ask for the correction the one way that
    // could not deliver it.
    expect(fitLeft).toMatch(/applyViewport\(want, 0\)/);
  });

  it("remembers what an animation is on its way to, and only while one is", () => {
    // A fit that went straight to the pane is already there; remembering it as
    // pending would land it a second time on the next visibility change.
    // One matcher for the whole ternary, rather than three that each hold a
    // fragment: `: null` on its own would pass on any `null` anywhere in the
    // function, which is an assertion about the file rather than about this.
    expect(fitLeft).toMatch(
      /pendingFitRef\.current = shouldAnimateViewport\(\{ durationMs: duration, documentHidden: document\.hidden \}\)\s*\?\s*\{ target: want, until: Date\.now\(\) \+ duration \+ 60 \}\s*:\s*null;/,
    );
  });
});

describe("a tab that goes away while a fit is running", () => {
  const listener = body("const land = ");

  it("lands the frame in flight the moment the page stops being rendered", () => {
    // Otherwise the transition stops where it stands: a canvas parked part-way
    // to a frame nobody chose, which is also what getViewport would report to
    // the drift watchdog from then on.
    expect(listener).toMatch(/if \(!document\.hidden\) return;/);
    expect(listener).toMatch(/applyViewport\(pending\.target, 0\)/);
    expect(listener).toMatch(/lastFitTimeRef\.current = Date\.now\(\)/);
  });

  it("is registered on visibilitychange, and taken down again", () => {
    expect(appCode).toMatch(/document\.addEventListener\("visibilitychange", land\)/);
    expect(appCode).toMatch(/document\.removeEventListener\("visibilitychange", land\)/);
  });

  it("ignores a fit whose animation was already over", () => {
    expect(listener).toMatch(/Date\.now\(\) > pending\.until/);
  });
});

describe("React Flow's own opening fit, which the deck does not perform itself", () => {
  it("asks the same rule for its duration", () => {
    // The first frame a deck ever draws, and the most likely one to be drawn
    // for nobody: the deck opens its own browser tab, which lands behind
    // whatever the user was already reading. Left animated, that tab showed a
    // graph at the identity transform until it was brought forward.
    const props = appCode.slice(appCode.indexOf("fitViewOptions={"), appCode.indexOf("minZoom={"));
    expect(props).toMatch(/shouldAnimateViewport\(\{ durationMs: OPENING_FIT_MS, documentHidden: document\.hidden \}\)/);
    expect(props).toMatch(/\?\s*OPENING_FIT_MS\s*:\s*0/);
  });
});
