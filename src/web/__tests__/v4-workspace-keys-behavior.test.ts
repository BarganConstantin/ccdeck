// V4 Workspace, the keys as behaviour: the window listener's chord, j and k
// along the list, and Enter on a row. v4-workspace-keys.test.ts pins the same
// promises in the source; these run the listener and the handler.
//
// useDeckShortcuts is one effect that puts a listener on window; the mock runs
// it at once so deck-keys-harness.ts can catch the listener and feed it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), useEffect: (run: () => void) => { run(); } }));

const { BODY, mountDeckKeys, stageKeys } = await import("./deck-keys-harness");
const { STAGE_FLIP_REST_MS } = await import("../terminal-keys");
const { openKeysOnEnter } = await import("../components/RailParts");

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const CHORD = { ctrlKey: true, code: "Backquote" };

describe("the window listener's chord", () => {
  it("switches the view once per press, and keeps the backtick from the page", () => {
    const toggle = vi.fn();
    const deck = mountDeckKeys({ view: { available: true, toggle } });
    const e = deck.press("`", CHORD);
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalled();
    deck.press("`", { ...CHORD, repeat: true });
    expect(toggle, "a held key is one press").toHaveBeenCalledTimes(1);
  });

  it("answers from inside the terminal pane, ahead of the pane's own early return", () => {
    const toggle = vi.fn();
    const deck = mountDeckKeys({ view: { available: true, toggle }, stage: stageKeys() });
    deck.press("`", { ...CHORD, target: { tagName: "TEXTAREA", inPanel: true } });
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it("is the page's where Workspace is not on offer: not claimed, not prevented", () => {
    const toggle = vi.fn();
    const deck = mountDeckKeys({ view: { available: false, toggle } });
    const e = deck.press("`", CHORD);
    expect(toggle).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
    const none = mountDeckKeys();
    expect(none.press("`", CHORD).preventDefault).not.toHaveBeenCalled();
  });

  it("waits while a dialog is open", () => {
    const toggle = vi.fn();
    const deck = mountDeckKeys({ view: { available: true, toggle } });
    deck.keyHelp.value = true;
    deck.press("`", CHORD);
    expect(toggle).not.toHaveBeenCalled();
  });
});

describe("j and k in Workspace", () => {
  const rail = () => stageKeys({ mode: "rail", order: ["a", "b", "c"], current: "a", sessionAt: () => "a" });

  it("walk the list's rows and never switch the pane, not even when the key rests", () => {
    const stage = rail();
    const deck = mountDeckKeys({ stage });
    deck.press("j");
    expect(stage.focusTile).toHaveBeenCalledWith("b");
    vi.advanceTimersByTime(STAGE_FLIP_REST_MS * 4);
    expect(stage.switchTo).not.toHaveBeenCalled();
    deck.press("k");
    expect(stage.focusTile, "k from the first row wraps to the last").toHaveBeenLastCalledWith("c");
  });

  it("are the Board's flip where there is no list: the stage follows once the key rests", () => {
    const stage = stageKeys();
    const deck = mountDeckKeys({ stage });
    deck.press("j");
    expect(stage.focusTile).toHaveBeenCalledWith("s2");
    vi.advanceTimersByTime(STAGE_FLIP_REST_MS + 1);
    expect(stage.switchTo).toHaveBeenCalledWith("s2", { focusPane: false });
  });

  it("are the board's letters on a row button too", () => {
    const stage = rail();
    const deck = mountDeckKeys({ stage });
    deck.press("j", { target: { tagName: "BUTTON" } });
    expect(stage.focusTile).toHaveBeenCalledWith("b");
    expect(BODY.tagName).toBe("BODY");
  });
});

describe("Enter on a row", () => {
  const press = (over: Partial<{ key: string; repeat: boolean; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({
    key: "Enter", repeat: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, preventDefault: vi.fn(), ...over,
  });

  it("opens the session with the keys, and is not the button's click", () => {
    const open = vi.fn();
    const e = press();
    openKeysOnEnter("s1", open)!(e);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("s1");
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("leaves every other key, and a held or modified Enter, to the row", () => {
    const open = vi.fn();
    const handler = openKeysOnEnter("s1", open)!;
    for (const over of [{ key: "j" }, { key: " " }, { repeat: true }, { shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
      const e = press(over);
      handler(e);
      expect(e.preventDefault, JSON.stringify(over)).not.toHaveBeenCalled();
    }
    expect(open).not.toHaveBeenCalled();
  });

  it("is no handler on the Board, where Enter is the button's own click", () => {
    expect(openKeysOnEnter("s1", undefined)).toBeUndefined();
  });
});
