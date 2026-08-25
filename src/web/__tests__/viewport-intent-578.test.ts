// #578: the + button and the minimap moved the view, and the deck took it back.
//
// Auto-fit is the deck's promise to keep the graph framed while sessions come
// and go, and the counter-promise is that it stops the instant the user frames
// something themselves. The second promise was kept for exactly one of the
// three ways this deck lets a viewport be moved.
//
// `onMoveStart` was the only signal for it, and in @reactflow/core 11.11.4 that
// callback is fenced off from most of what moves a viewport. The pane's d3-zoom
// `start` handler opens with `if (!event.sourceEvent || event.sourceEvent
// .internal) return null;`, so a change with no originating DOM event never
// arrives. Both of the deck's other viewport controls are exactly that change:
// @reactflow/minimap pans with `d3Zoom.transform(d3Selection, constrained)` and
// wheel-zooms with `d3Zoom.scaleTo(d3Selection, zoom)`, and @reactflow/controls'
// + and − call `zoomIn`/`zoomOut`, which are `d3Zoom.scaleBy(transition, 1.2)` —
// two arguments each, no event forwarded. So `disableAutoFit()` never ran for
// them, `autoFitDisabledRef` stayed false, and the next re-measure — a subagent
// spawning, a cost digit widening a card — ran `fitLeft` and animated the user's
// zoom away. Wheel over the canvas, which routes through the pane, stuck. Two
// controls doing the same thing, one obeyed and one silently overruled.
//
// The fix moves the question off `onMoveStart` and onto `onMove`, which fires
// for the pane AND for everything that goes through the store, and answers it
// with a rule that has a name and a file: isUserViewportGesture. The reason it
// is a rule and not a handler per control is the shape of the original bug — a
// list of controls to wire up is a list that can be incomplete, and this one was
// incomplete for a year without anything noticing.
//
// So the rule has to hold three things apart at once, and getting the third
// wrong is worse than the bug being fixed:
//
//   the pane's own gesture      a real DOM event, which nothing else can fake
//   a store-driven control      no event, but a press inside the canvas just now
//   a fit the deck asked for    no event, and nothing touched — including the
//                               opening fitView on a profile that has never
//                               stored a viewport, which if misread turns
//                               auto-fit off permanently on first paint
//
// Nothing in this suite renders React and React Flow is never mounted, which is
// precisely why this survived: no test could watch a callback fire or fail to.
// Extracting the decision is what makes it reachable — the four cases below are
// the event shapes the library actually produces, asserted against the rule
// directly. The source reading that follows is the second layer, and it pins the
// thing a pure function cannot: that the controls the deck mounts sit inside the
// element whose presses feed the rule, and that every fit the deck asks for is
// still marked as its own.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  isUserViewportGesture,
  CANVAS_INPUT_WINDOW_MS,
  DECK_FIT_WINDOW_MS,
  type ViewportMove,
} from "../viewport-intent";

/** A plausible wall clock, so the "never happened" sentinel of 0 is nowhere
 *  near any of the windows being measured. */
const NOW = 1_700_000_000_000;

/** One viewport change, defaulting to the quietest possible surroundings:
 *  nothing touched, nothing fitted, no event. */
function move(over: Partial<ViewportMove> = {}): ViewportMove {
  return { hasSourceEvent: false, at: NOW, lastDeckFitAt: 0, lastCanvasInputAt: 0, ...over };
}

// ── the three ways this deck lets a viewport be moved ───────────────────────

describe("the rule that decides whether the user took the wheel", () => {
  it("reads a drag on the canvas as theirs, because only a gesture has an event", () => {
    // The path that always worked. React Flow hands this one a real MouseEvent
    // or TouchEvent and has no way to invent one, so the event alone settles it.
    expect(isUserViewportGesture(move({
      hasSourceEvent: true,
      lastCanvasInputAt: NOW - 20,
      lastDeckFitAt: NOW - 5_000,
    }))).toBe(true);
  });

  it("reads a Controls zoom as theirs, though React Flow gives it no event", () => {
    // `zoomIn()` is d3Zoom.scaleBy on a transition — the viewport moves without
    // any event being forwarded, which is what kept this out of onMoveStart.
    // What the press on the button leaves behind is the pointerup that fired a
    // moment before the click handler ran.
    expect(isUserViewportGesture(move({
      hasSourceEvent: false,
      lastCanvasInputAt: NOW - 30,
      lastDeckFitAt: NOW - 9_000,
    }))).toBe(true);
  });

  it("reads a minimap pan as theirs, on the same evidence", () => {
    // d3Zoom.transform(d3Selection, constrained): same shape, same absent
    // event, and the drag began with a press inside the minimap.
    expect(isUserViewportGesture(move({
      hasSourceEvent: false,
      lastCanvasInputAt: NOW - 120,
      lastDeckFitAt: NOW - 9_000,
    }))).toBe(true);
  });

  it("does not read a fit the deck asked for as theirs", () => {
    // fitLeft on a layout change, the drift watchdog, focusSession from the
    // session list. An animated setViewport reports a viewport every frame, all
    // of them eventless, and none of them preceded by anyone touching anything.
    expect(isUserViewportGesture(move({
      hasSourceEvent: false,
      lastDeckFitAt: NOW - 16,
      lastCanvasInputAt: 0,
    }))).toBe(false);
  });
});

// ── the two readings that would be worse than the bug ───────────────────────

describe("what the rule must never mistake for a gesture", () => {
  it("leaves auto-fit on through the opening fit of a canvas nobody has touched", () => {
    // A fresh browser profile: no stored viewport, so React Flow's own fitView
    // prop runs once the first nodes are measured. Nothing has been pressed and
    // the deck has not fitted anything of its own, so both stamps are still 0 —
    // and 0 has to mean "never", not "a very long time ago", or first paint
    // would switch auto-fit off before the deck had drawn anything.
    expect(isUserViewportGesture(move())).toBe(false);
  });

  it("leaves auto-fit on when the press inside the canvas IS the recenter button", () => {
    // The recenter, re-arrange and fit-view buttons all live in the Controls
    // stack, so pressing one stamps the canvas exactly as the + button does.
    // The fit they ask for has to outrank that press, or the one control whose
    // entire job is turning auto-fit back on would turn it off again.
    expect(isUserViewportGesture(move({
      hasSourceEvent: false,
      lastCanvasInputAt: NOW - 40,
      lastDeckFitAt: NOW - 8,
    }))).toBe(false);
  });

  it("keeps the canvas gesture behaving exactly as it did before", () => {
    // onMoveStart carried this guard inline and it is unchanged: a move that
    // lands while a fit of the deck's own is still animating is not counted,
    // event or no event. The canvas path gains nothing here and loses nothing.
    expect(isUserViewportGesture(move({
      hasSourceEvent: true,
      lastCanvasInputAt: NOW - 10,
      lastDeckFitAt: NOW - 300,
    }))).toBe(false);
  });

  it("does not credit a press that has gone stale to a much later move", () => {
    // A store-driven viewport arriving five seconds after the last thing anyone
    // touched is the deck's, not a gesture's. Otherwise one click on the canvas
    // would sign every fit that followed it.
    expect(isUserViewportGesture(move({
      hasSourceEvent: false,
      lastCanvasInputAt: NOW - 5_000,
    }))).toBe(false);
  });

  it("draws both windows where the animations and the clicks actually are", () => {
    // Boundaries, so the constants cannot be quietly narrowed to nothing.
    expect(isUserViewportGesture(move({
      lastCanvasInputAt: NOW - (CANVAS_INPUT_WINDOW_MS - 1),
    }))).toBe(true);
    expect(isUserViewportGesture(move({
      lastCanvasInputAt: NOW - CANVAS_INPUT_WINDOW_MS,
    }))).toBe(false);
    expect(isUserViewportGesture(move({
      hasSourceEvent: true,
      lastDeckFitAt: NOW - (DECK_FIT_WINDOW_MS - 1),
    }))).toBe(false);
    expect(isUserViewportGesture(move({
      hasSourceEvent: true,
      lastDeckFitAt: NOW - DECK_FIT_WINDOW_MS,
    }))).toBe(true);
  });
});

// ── the wiring the rule is useless without ──────────────────────────────────

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

/** The same text with its comments gone — the prose in this repo quotes the
 *  shapes it rejected, so an "appears nowhere" assertion has to read code. */
const appCode = app
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");

/** The opening tag of the canvas element, attributes and all. */
const mainTag = /<main\b[\s\S]*?\n\s*>/.exec(appCode)?.[0] ?? "";

/** Everything the canvas element contains. */
const canvasBody = appCode.slice(appCode.indexOf(mainTag), appCode.indexOf("</main>"));

/** The body of one JSX handler prop, `name={(…) => { … }}`. */
function handler(name: string): string {
  const at = appCode.indexOf(`${name}={`);
  if (at < 0) return "";
  let depth = 0;
  for (let i = at + name.length + 1; i < appCode.length; i++) {
    const c = appCode[i];
    if (c === "{") depth++;
    else if (c === "}") { if (depth === 0) return appCode.slice(at, i); depth--; }
  }
  return "";
}

describe("every control that moves the viewport reaches that rule", () => {
  it("asks the rule on onMove, the callback a store-driven move can reach", () => {
    // onMoveStart cannot see the minimap or the zoom buttons at all, so it
    // cannot be the only place the question is asked. onMove can: the `zoom`
    // handler beside `start` guards on `!event.sourceEvent?.internal`, which is
    // falsy when there is no source event.
    expect(handler("onMove")).toMatch(/isUserViewportGesture\(/);
    expect(handler("onMove")).toMatch(/disableAutoFit\(\)/);
  });

  it("still asks it on onMoveStart, so a canvas drag is caught on the press", () => {
    expect(handler("onMoveStart")).toMatch(/isUserViewportGesture\(/);
    expect(handler("onMoveStart")).toMatch(/disableAutoFit\(\)/);
  });

  it("marks a press or a wheel anywhere in the canvas, in the capture phase", () => {
    // Capture is not a preference: React Flow calls stopImmediatePropagation()
    // on the pane's press, so a bubbling handler on <main> never sees the one
    // gesture that matters most (measured in #434, same element).
    expect(mainTag).toMatch(/onPointerDownCapture=\{markCanvasInput\}/);
    expect(mainTag).toMatch(/onWheelCapture=\{markCanvasInput\}/);
    // The release too — a Controls button calls zoomIn() on the click, and a
    // held button puts seconds between the press and the zoom.
    expect(mainTag).toMatch(/onPointerUpCapture=\{markCanvasInput\}/);
  });

  it("puts the Controls stack and the minimap inside the element it marks", () => {
    // This is what makes one listener enough, and what makes the next control
    // added to this canvas covered before anyone remembers to wire it.
    expect(canvasBody).toMatch(/<Controls\b/);
    expect(canvasBody).toMatch(/<MiniMap\b/);
  });

  it("feeds the rule the two stamps and the event, and nothing else", () => {
    const inputs = handler("onMove") + appCode.slice(appCode.indexOf("const viewportMove ="), appCode.indexOf("const viewportMove =") + 400);
    expect(inputs).toMatch(/lastCanvasInputAt: lastCanvasInputRef\.current/);
    expect(inputs).toMatch(/lastDeckFitAt: lastFitTimeRef\.current/);
  });
});

describe("the fits the deck asks for stay marked as its own", () => {
  it("stamps the fit-time ref beside every fitView the deck calls", () => {
    // stepAgent, focusSession and the selected ribbon. Under onMoveStart these
    // were safe by accident — a programmatic fit carries no source event and
    // never reached it. onMove does see them, so the stamp is now what stands
    // between an auto-fit deck and an auto-fit deck that switches itself off
    // the first time anyone clicks a session in the list.
    const lines = appCode.split("\n");
    const calls = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /\brf\.fitView\(/.test(line));
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const { i } of calls) {
      expect(lines.slice(i, i + 4).join("\n")).toMatch(/lastFitTimeRef\.current = Date\.now\(\)/);
    }
  });

  it("stamps the viewport restored from storage on reload", () => {
    // The one programmatic viewport that was never stamped, because it never
    // had to be. It runs 60ms after mount, before the user could have touched
    // anything, and unstamped it would read as their first gesture.
    const restore = appCode.slice(appCode.indexOf("if (!restoredViewport) return;"));
    expect(restore.slice(0, 400)).toMatch(/rf\.setViewport\(restoredViewport[\s\S]*?lastFitTimeRef\.current = Date\.now\(\)/);
  });

  it("stamps fitLeft, the fit every structural change runs", () => {
    const fitLeft = appCode.slice(appCode.indexOf("const fitLeft = useCallback"));
    expect(fitLeft.slice(0, 3_000)).toMatch(/lastFitTimeRef\.current = Date\.now\(\)/);
  });
});
