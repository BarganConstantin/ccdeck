// The deck's one keydown handler with the terminal stage beside it.
//
// Two promises, and the second is the one a stage could quietly break:
//
//  - with the stage open, the keys the keys bar advertises do what it says —
//    j/k walk the navigator and the stage follows once the key rests, Enter
//    and i put the keys in the pane, n and w take the next ask — and every key
//    pressed inside the pane is the session's, Escape included, except the
//    release chord;
//  - with the stage closed, or no stage at all (the flag off), every key does
//    exactly what it did before the stage existed. That is pinned the strict
//    way: the same keystrokes, into a deck with no stage and a deck with a
//    closed one, must reach the same spies with the same arguments.
//
// useDeckShortcuts is one effect that puts a listener on window; the mock runs
// it at once so deck-keys-harness.ts can catch the listener and feed it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), useEffect: (run: () => void) => { run(); } }));

const { BODY, button, mountDeckKeys, stageKeys } = await import("./deck-keys-harness");
const { modalStack } = await import("../modal-dismiss");
const { KEY_HELP } = await import("../key-help");

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

type Deck = ReturnType<typeof mountDeckKeys>;

/** Everything a deck's spies were asked, by name, with a function argument
 *  (a setter's updater) written as its result on `false` so two decks can be
 *  compared as data. */
function record(deck: Deck) {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(deck.props)) {
    const spy = typeof value === "function" ? value : (value as { current?: unknown })?.current;
    if (typeof spy === "function" && vi.isMockFunction(spy)) {
      out[name] = spy.mock.calls.map(args => args.map(a => (typeof a === "function" ? `fn→${String(a(false))}` : a)));
    }
  }
  return out;
}

/** Every key the sheet documents, the keys the stage adds, and a few the deck
 *  never bound — each pressed plain, held, and with Shift. */
const KEYS = [...new Set([
  ...KEY_HELP.flatMap(g => g.rows.flatMap(r => r.binds)),
  "Enter", "i", "I", "n", "N", "x", "X", "1", "ArrowDown", "Tab",
])];

/** The same run of keystrokes, on the body and on a keyboard-focused button. */
function sweep(deck: Deck) {
  const prevented: boolean[] = [];
  for (const target of [BODY, button()]) {
    for (const k of KEYS) {
      for (const o of [{}, { repeat: true }, { shiftKey: true }]) {
        if (k === "Escape" || k === "?") continue; // each changes what the rest of the sweep reads; covered below
        prevented.push(deck.press(k, { target, ...o }).preventDefault.mock.calls.length > 0);
      }
    }
  }
  return prevented;
}

describe("with the stage closed, or no stage at all, the keys are the deck's as they always were", () => {
  it("reaches the same spies with the same arguments as a deck with no stage", () => {
    const without = mountDeckKeys();
    const preventedWithout = sweep(without);
    const callsWithout = record(without);

    const stage = stageKeys({ open: false });
    const closed = mountDeckKeys({ stage });
    const preventedClosed = sweep(closed);

    expect(record(closed)).toEqual(callsWithout);
    expect(preventedClosed).toEqual(preventedWithout);
    // And the sweep was not vacuous: the deck's own keys ran.
    expect(callsWithout.stepAgent, "J and K stepped the canvas").not.toEqual([]);
    expect(callsWithout.togglePause, "Space paused").not.toEqual([]);
    // A closed stage is asked nothing.
    for (const fn of [stage.focusTile, stage.switchTo, stage.focusPane, stage.nextAsk, stage.release]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("is the same with a stage handed over as null, which is a flag-off deck that wired the ref anyway", () => {
    const without = mountDeckKeys();
    sweep(without);
    const nulled = mountDeckKeys({ stage: null });
    sweep(nulled);
    expect(record(nulled)).toEqual(record(without));
  });

  it("still steps the canvas on J and goes to the waiting session on W, not the stage's way", () => {
    const stage = stageKeys({ open: false });
    const deck = mountDeckKeys({ stage });
    deck.press("j");
    deck.press("w");
    vi.advanceTimersByTime(1000);
    expect(deck.props.stepAgent).toHaveBeenCalledWith(1);
    expect(stage.focusTile).not.toHaveBeenCalled();
    expect(stage.nextAsk).not.toHaveBeenCalled();
  });

  it("answers Escape as before: it blurs a focused button and clears the selection", () => {
    const deck = mountDeckKeys({ stage: stageKeys({ open: false }) });
    const blur = vi.fn();
    deck.press("Escape", { target: { tagName: "BUTTON", blur } });
    expect(blur).toHaveBeenCalled();
    expect(deck.props.clearSelection).toHaveBeenCalledTimes(1);
  });
});

describe("inside the pane every key is the session's", () => {
  const PANE = { tagName: "TEXTAREA", inPanel: true };

  it("answers nothing — no shortcut, no Escape, no Settings chord, no preventDefault", () => {
    for (const stage of [stageKeys(), stageKeys({ open: false }), undefined]) {
      const deck = mountDeckKeys({ stage });
      for (const k of [...KEYS, ","]) {
        for (const o of [{}, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }]) {
          const e = deck.press(k, { target: PANE, ...o });
          expect(e.preventDefault, `${k} ${JSON.stringify(o)}`).not.toHaveBeenCalled();
        }
      }
      const calls = Object.values(record(deck)).flat();
      expect(calls, "a key pressed in the pane reached the deck").toEqual([]);
    }
  });

  it("leaves Escape to the session even with a dialog open — the deck neither blurs nor dismisses", () => {
    const dismiss = vi.fn();
    const close = modalStack.push(dismiss);
    try {
      const deck = mountDeckKeys({ stage: stageKeys() });
      const blur = vi.fn();
      deck.press("Escape", { target: { ...PANE, blur } });
      expect(blur, "the pane lost the keys on Escape").not.toHaveBeenCalled();
      expect(dismiss).not.toHaveBeenCalled();
      expect(deck.props.clearSelection).not.toHaveBeenCalled();
    } finally {
      close();
    }
  });

  it("gives the keys back to the board on the release chord, once per press", () => {
    const stage = stageKeys();
    const deck = mountDeckKeys({ stage });
    const e = deck.press("X", { target: PANE, ctrlKey: true, shiftKey: true, code: "KeyX" });
    expect(stage.release).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalled();
    deck.press("X", { target: PANE, ctrlKey: true, shiftKey: true, code: "KeyX", repeat: true });
    expect(stage.release, "a held chord released again").toHaveBeenCalledTimes(1);
    // From anywhere in the pane, under a non-Latin layout too.
    deck.press("Ч", { target: { tagName: "DIV", inPanel: true }, ctrlKey: true, shiftKey: true, code: "KeyX" });
    expect(stage.release).toHaveBeenCalledTimes(2);
  });

  it("does nothing on the chord outside the pane, where the keys are the board's already", () => {
    const stage = stageKeys();
    const deck = mountDeckKeys({ stage });
    deck.press("X", { ctrlKey: true, shiftKey: true, code: "KeyX" });
    deck.press("X", { target: { tagName: "DIV", inPanel: false }, ctrlKey: true, shiftKey: true, code: "KeyX" });
    expect(stage.release).not.toHaveBeenCalled();
    expect(Object.values(record(deck)).flat()).toEqual([]);
  });

  it("does not throw on the chord in a pane with no stage handed over", () => {
    const deck = mountDeckKeys();
    expect(() => deck.press("X", { target: PANE, ctrlKey: true, shiftKey: true, code: "KeyX" })).not.toThrow();
  });
});

describe("with the stage open, the board's keys move the stage", () => {
  it("puts the board's focus on the next session at once, and the stage there after 160ms of rest", () => {
    const stage = stageKeys();
    const deck = mountDeckKeys({ stage });
    deck.press("j");
    expect(stage.focusTile).toHaveBeenCalledWith("s2");
    vi.advanceTimersByTime(159);
    expect(stage.switchTo, "the stage moved before the key rested").not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stage.switchTo).toHaveBeenCalledWith("s2", { focusPane: false });
    // The canvas's own j is not what ran.
    expect(deck.props.stepAgent).not.toHaveBeenCalled();
  });

  it("follows only the session a held j comes to rest on", () => {
    const stage = stageKeys({ order: ["s1", "s2", "s3", "s4"] });
    const deck = mountDeckKeys({ stage });
    deck.press("j");
    for (let i = 0; i < 2; i++) { vi.advanceTimersByTime(33); deck.press("j", { repeat: true }); }
    expect(stage.focusTile.mock.calls.map(c => c[0])).toEqual(["s2", "s3", "s4"]);
    vi.advanceTimersByTime(160);
    expect(stage.switchTo.mock.calls).toEqual([["s4", { focusPane: false }]]);
  });

  it("steps on from the tile the navigator's arrows walked focus to, not from the stage", () => {
    const tile = { tagName: "BUTTON", session: "s3" };
    const stage = stageKeys({
      order: ["s1", "s2", "s3", "s4"],
      sessionAt: vi.fn((t: EventTarget | null) => (t as unknown as { session?: string })?.session ?? null),
    });
    const deck = mountDeckKeys({ stage });
    deck.press("j", { target: tile as never });
    expect(stage.focusTile).toHaveBeenCalledWith("s4");
    vi.advanceTimersByTime(160);
    expect(stage.switchTo).toHaveBeenCalledWith("s4", { focusPane: false });
  });

  it("walks back on k, wrapping from the first session to the last", () => {
    const stage = stageKeys();
    const deck = mountDeckKeys({ stage });
    deck.press("k");
    vi.advanceTimersByTime(160);
    expect(stage.switchTo).toHaveBeenCalledWith("s3", { focusPane: false });
  });

  it("drops a flip when something else moved the stage while the key rested — a click wins", () => {
    const stage = stageKeys();
    const deck = mountDeckKeys({ stage });
    deck.press("j");
    stage.current = "s3"; // a tile clicked meanwhile
    vi.advanceTimersByTime(160);
    expect(stage.switchTo).not.toHaveBeenCalled();
  });

  it("drops a flip when the stage closed while the key rested", () => {
    const stage = stageKeys();
    const deck = mountDeckKeys({ stage });
    deck.press("j");
    stage.open = false;
    vi.advanceTimersByTime(160);
    expect(stage.switchTo).not.toHaveBeenCalled();
  });

  it("puts the keys in the pane on Enter and i", () => {
    const stage = stageKeys();
    const deck = mountDeckKeys({ stage });
    deck.press("Enter");
    deck.press("i");
    deck.press("I");
    expect(stage.focusPane).toHaveBeenCalledTimes(3);
    expect(stage.switchTo).not.toHaveBeenCalled();
  });

  it("takes Enter in the middle of a flip to the session flipped to, now, with the keys in it", () => {
    const stage = stageKeys();
    const deck = mountDeckKeys({ stage });
    deck.press("j");
    deck.press("Enter");
    expect(stage.switchTo.mock.calls).toEqual([["s2", { focusPane: true }]]);
    vi.advanceTimersByTime(500);
    expect(stage.switchTo, "the flip's own timer switched again").toHaveBeenCalledTimes(1);
    expect(stage.focusPane).not.toHaveBeenCalled();
  });

  it("takes the next ask on n and w, once per press, and leaves W's old cursor alone", () => {
    const stage = stageKeys();
    const deck = mountDeckKeys({ stage });
    deck.press("n");
    deck.press("w");
    deck.press("W");
    deck.press("n", { repeat: true });
    expect(stage.nextAsk).toHaveBeenCalledTimes(3);
    expect(deck.props.focusSession).not.toHaveBeenCalled();
    expect(deck.props.waitingCursorRef.current).toBeNull();
  });

  it("cancels a pending flip when the next ask is taken", () => {
    const stage = stageKeys();
    const deck = mountDeckKeys({ stage });
    deck.press("j");
    deck.press("n");
    vi.advanceTimersByTime(500);
    expect(stage.switchTo).not.toHaveBeenCalled();
    expect(stage.nextAsk).toHaveBeenCalledTimes(1);
  });

  it("works from the button the release left focus on, which keeps its own Enter", () => {
    const stage = stageKeys();
    const deck = mountDeckKeys({ stage });
    deck.press("j", { target: button() });
    deck.press("n", { target: button() });
    deck.press("Enter", { target: button() });
    expect(stage.focusTile).toHaveBeenCalledWith("s2");
    expect(stage.nextAsk).toHaveBeenCalledTimes(1);
    expect(stage.focusPane, "Enter pressed the button rather than going past it").not.toHaveBeenCalled();
  });

  it("claims nothing behind a dialog, or from a field being typed in", () => {
    const stage = stageKeys();
    const deck = mountDeckKeys({ stage });
    const close = modalStack.push(() => {});
    try {
      for (const k of ["j", "k", "Enter", "i", "n", "w"]) deck.press(k);
    } finally {
      close();
    }
    for (const k of ["j", "k", "i", "n", "w"]) deck.press(k, { target: { tagName: "INPUT", type: "text" } });
    vi.advanceTimersByTime(500);
    for (const fn of [stage.focusTile, stage.switchTo, stage.focusPane, stage.nextAsk]) expect(fn).not.toHaveBeenCalled();
    expect(deck.props.stepAgent, "the canvas stepped behind the stage").not.toHaveBeenCalled();
  });

  it("leaves every other key to the deck: T still turns the theme, L the session list", () => {
    const deck = mountDeckKeys({ stage: stageKeys() });
    deck.press("t");
    deck.press("l");
    expect(deck.theme.value).toBe("rider-black");
    expect(deck.props.toggleSessionList).toHaveBeenCalledTimes(1);
  });
});
