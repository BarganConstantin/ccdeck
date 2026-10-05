// `?` could not close the shortcuts sheet it had just opened from the keyboard.
//
// Opening the sheet hands focus to its first stop, the header ×, by program —
// so the button is not marked as one the mouse pressed (#851) and owns every
// key. The next `?` was aimed at that BUTTON, the focused-control gate kept it,
// and the handler returned before the modal gate's one exception, written for
// exactly this toggle. It worked only when the sheet had been opened with the
// mouse, inside the 250ms that marks a focus as the pointer's.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), useEffect: (run: () => void) => { run(); } }));

const { button, mountDeckKeys } = await import("./deck-keys-harness");

afterEach(() => { vi.unstubAllGlobals(); });

describe("? toggles the shortcuts sheet", () => {
  it("opens it from the canvas", () => {
    const deck = mountDeckKeys();
    deck.press("?");
    expect(deck.keyHelp.value).toBe(true);
  });

  it("closes it again while the sheet's own × holds the focus it was given on opening", () => {
    const deck = mountDeckKeys();
    deck.press("?");
    // Focus moved to the × by program: a button, not one the pointer pressed.
    deck.press("?", { target: button() });
    expect(deck.keyHelp.value).toBe(false);
  });

  it("does not close it on the auto-repeat of the press that opened it", () => {
    const deck = mountDeckKeys();
    deck.press("?");
    deck.press("?", { target: button(), repeat: true });
    expect(deck.keyHelp.value).toBe(true);
  });

  it("types into a text field rather than closing anything", () => {
    const deck = mountDeckKeys();
    deck.press("?");
    deck.press("?", { target: { tagName: "INPUT", type: "text" } });
    expect(deck.keyHelp.value).toBe(true);
  });
});
