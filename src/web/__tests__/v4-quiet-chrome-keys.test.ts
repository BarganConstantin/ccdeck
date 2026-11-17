// V4 top-10 #5, the keys the status bar names, as behaviour: the deck's one
// keydown handler counts a use of each named key as it answers it, once per
// press, and every key still does what it did. The counting itself (three
// uses, kept per browser) is v4-quiet-chrome.test.ts's; here it is a spy, so
// each press is read back as the id it was counted under.
//
// useDeckShortcuts is one effect that puts a listener on window; the mock runs
// it at once so deck-keys-harness.ts can catch the listener and feed it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), useEffect: (run: () => void) => { run(); } }));
vi.mock("../key-learning", async (orig) => ({ ...(await orig<typeof import("../key-learning")>()), noteKeyUse: vi.fn() }));

const { BODY, button, mountDeckKeys, stageKeys } = await import("./deck-keys-harness");
const { noteKeyUse } = await import("../key-learning");
const { boardKeyLearned, stageKeyLearned } = await import("../use-deck-shortcuts");

const counted = () => vi.mocked(noteKeyUse).mock.calls.map(([id]) => id);
const PANE = { tagName: "TEXTAREA", inPanel: true };
const CHORD = { ctrlKey: true, code: "Backquote" };

beforeEach(() => { vi.useFakeTimers(); vi.mocked(noteKeyUse).mockClear(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("the board's named keys are counted as the handler answers them, and still work", () => {
  it("j and k walk the cards, each press one use of 'cards'", () => {
    const deck = mountDeckKeys();
    deck.press("j");
    deck.press("K");
    expect(deck.props.stepAgent).toHaveBeenNthCalledWith(1, 1);
    expect(deck.props.stepAgent).toHaveBeenNthCalledWith(2, -1);
    expect(counted()).toEqual(["cards", "cards"]);
  });

  it("counts a held key once: its repeats still walk, and are not uses", () => {
    const deck = mountDeckKeys();
    deck.press("j");
    deck.press("j", { repeat: true });
    deck.press("j", { repeat: true });
    expect(deck.props.stepAgent).toHaveBeenCalledTimes(3);
    expect(counted()).toEqual(["cards"]);
  });

  it("Space has no Board action; n and p still report their shortcuts", () => {
    const deck = mountDeckKeys();
    deck.press(" ");
    expect(deck.props.togglePause).not.toHaveBeenCalled();
    deck.press("n");
    deck.press("p");
    expect(counted()).toEqual(["nextWaiting", "peek"]);
  });

  it("counts nothing for a key the bar does not name, which still does its job", () => {
    const deck = mountDeckKeys();
    deck.press("c");
    deck.press("r");
    expect(deck.props.requestClear).toHaveBeenCalledWith("shortcut");
    expect(deck.props.handleRelayout).toHaveBeenCalledTimes(1);
    expect(counted()).toEqual([]);
  });

  it("counts nothing a focused control answers itself, or the single-key switch silences", () => {
    // Space on a button presses the button: that is not the deck's pause.
    mountDeckKeys().press(" ", { target: button() });
    const off = mountDeckKeys({ singleKeys: false });
    off.press("j");
    off.press(" ");
    expect(off.props.stepAgent).not.toHaveBeenCalled();
    expect(off.props.togglePause).not.toHaveBeenCalled();
    expect(counted()).toEqual([]);
  });

  it("counts the view chord once per press, as it switches the view once", () => {
    const toggle = vi.fn();
    const deck = mountDeckKeys({ view: { available: true, toggle } });
    deck.press("`", CHORD);
    deck.press("`", { ...CHORD, repeat: true });
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(counted()).toEqual(["view"]);
  });
});

describe("with the Command Panel open, the deck's named keys", () => {
  it("j walks the sessions ('sessions'), Enter opens one to type in ('openAndType'), n takes the next ask", () => {
    const stage = stageKeys();
    const deck = mountDeckKeys({ stage });
    deck.press("j", { target: BODY });
    // Enter in the middle of the flip j started takes the session flipped to, with the keys in it.
    deck.press("Enter", { target: BODY });
    deck.press("n", { target: BODY });
    expect(stage.switchTo.mock.calls).toEqual([["s2", { focusPane: true }]]);
    expect(stage.nextAsk).toHaveBeenCalled();
    expect(counted()).toEqual(["sessions", "openAndType", "nextWaiting"]);
  });

  it("never counts the pane's way out, which the bar names for as long as focus is in the pane", () => {
    const stage = stageKeys();
    const deck = mountDeckKeys({ stage });
    deck.press("X", { target: PANE, ctrlKey: true, shiftKey: true, code: "KeyX" });
    expect(stage.release).toHaveBeenCalledTimes(1);
    expect(counted()).toEqual([]);
  });
});

describe("the tables the handler counts by", () => {
  it("name the board's keys, a card's Enter, and nothing on a repeat", () => {
    expect(boardKeyLearned(" ", false)).toBeNull();
    expect(boardKeyLearned("J", false)).toBe("cards");
    expect(boardKeyLearned("N", false)).toBe("nextWaiting");
    expect(boardKeyLearned("p", false)).toBe("peek");
    expect(boardKeyLearned("p", false, { stageOpen: true }), "no peek under the stage").toBeNull();
    expect(boardKeyLearned("Enter", false, { onCard: true })).toBe("select");
    expect(boardKeyLearned(" ", false, { onCard: true }), "Space on a card selects, unnamed").toBeNull();
    expect(boardKeyLearned("c", false)).toBeNull();
    expect(boardKeyLearned("j", true)).toBeNull();
  });

  it("name the stage's moves the bar names, and not i or w", () => {
    expect(stageKeyLearned({ kind: "step", delta: 1 } as never, "j", false)).toBe("sessions");
    expect(stageKeyLearned({ kind: "focus-pane" } as never, "Enter", false)).toBe("openAndType");
    expect(stageKeyLearned({ kind: "focus-pane" } as never, "i", false)).toBeNull();
    expect(stageKeyLearned({ kind: "next-ask" } as never, "n", false)).toBe("nextWaiting");
    expect(stageKeyLearned({ kind: "next-ask" } as never, "w", false)).toBeNull();
    expect(stageKeyLearned({ kind: "step", delta: 1 } as never, "j", true)).toBeNull();
  });
});
