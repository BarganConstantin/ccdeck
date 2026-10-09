// Re-arrange can be undone from the keyboard too: ⌘Z on a Mac, Ctrl+Z
// elsewhere, and either on any of them, for as long as the canvas offers the
// Undo. It is a chord, so it answers with Settings › General's single-key
// switch off as well, and it leaves a field somebody is typing in its own undo.
//
// The rest of the behaviour — what Undo restores, and when the offer goes — is
// rearrange-undo.test.ts's. useDeckShortcuts is one effect that puts a listener
// on window; the mock below runs it at once so deck-keys-harness.ts can catch
// the listener and hand it keystrokes.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), useEffect: (run: () => void) => { run(); } }));

const { BODY, button, mountDeckKeys } = await import("./deck-keys-harness");
const { modalStack } = await import("../modal-dismiss");
const { KEY_HELP, keyHelpFor } = await import("../key-help");

afterEach(() => { vi.unstubAllGlobals(); });

/** A deck whose canvas is offering the Undo right now. */
const offering = (opts: { singleKeys?: boolean } = {}) => mountDeckKeys({ ...opts, undoRearrange: () => true });

describe("re-arrange can be undone with ⌘Z / Ctrl+Z", () => {
  it("undoes on ⌘Z and on Ctrl+Z alike, and takes the chord from the browser", () => {
    const deck = offering();
    expect(deck.press("z", { metaKey: true }).preventDefault).toHaveBeenCalled();
    expect(deck.press("z", { ctrlKey: true }).preventDefault).toHaveBeenCalled();
    // Caps Lock sends the upper case for the same press.
    deck.press("Z", { metaKey: true });
    expect(deck.props.undoRearrange).toHaveBeenCalledTimes(3);
    // Not Z's own zoom, which a bare z is.
    expect(deck.props.focusAgent).not.toHaveBeenCalled();
  });

  it("leaves the chord to the browser once the notice has gone", () => {
    const deck = mountDeckKeys();
    const e = deck.press("z", { metaKey: true });
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("does nothing while somebody is typing, whose field has its own undo", () => {
    const deck = offering();
    for (const target of [{ tagName: "INPUT", type: "text" }, { tagName: "TEXTAREA" }, { tagName: "INPUT", type: "search" }]) {
      const e = deck.press("z", { metaKey: true, target });
      expect(e.preventDefault, target.tagName).not.toHaveBeenCalled();
    }
    expect(deck.props.undoRearrange).not.toHaveBeenCalled();
  });

  it("is not redo, and not someone else's chord", () => {
    const deck = offering();
    deck.press("z", { metaKey: true, shiftKey: true });
    deck.press("z", { ctrlKey: true, altKey: true });
    deck.press("z");
    expect(deck.props.undoRearrange).not.toHaveBeenCalled();
  });

  it("works with the single-key shortcuts off, since it is a chord", () => {
    const deck = offering({ singleKeys: false });
    deck.press("z", { metaKey: true });
    expect(deck.props.undoRearrange).toHaveBeenCalledTimes(1);
  });

  it("works from a button the keyboard focused, which owns its letters and not this chord", () => {
    const deck = offering();
    deck.press("z", { ctrlKey: true, target: button() });
    expect(deck.props.undoRearrange).toHaveBeenCalledTimes(1);
  });

  it("does not reach the canvas behind a dialog", () => {
    const deck = offering();
    const leave = modalStack.push(() => {});
    try {
      deck.press("z", { metaKey: true, target: BODY });
    } finally {
      leave();
    }
    expect(deck.props.undoRearrange).not.toHaveBeenCalled();
  });

  it("runs once for a held chord", () => {
    const deck = offering();
    deck.press("z", { metaKey: true });
    deck.press("z", { metaKey: true, repeat: true });
    expect(deck.props.undoRearrange).toHaveBeenCalledTimes(1);
  });
});

describe("the shortcuts sheet says so", () => {
  it("has a line for the chord beside R, printed the Mac way on a Mac", () => {
    const canvas = KEY_HELP.find(g => g.title === "Canvas")!.rows;
    const r = canvas.findIndex(row => row.cap === "R");
    const chord = canvas[r + 1];
    expect(chord?.cap).toBe("Ctrl + Z");
    expect(chord?.macCap).toBe("⌘ Z");
    expect(chord?.chord).toBe(true);
    expect(chord?.action).toMatch(/undo/i);
  });

  it("keeps the line with the single-key shortcuts off, where the chord still works", () => {
    const rows = keyHelpFor(false).flatMap(g => g.rows);
    expect(rows.some(row => row.cap === "Ctrl + Z")).toBe(true);
    expect(rows.some(row => row.cap === "R")).toBe(false);
  });
});
