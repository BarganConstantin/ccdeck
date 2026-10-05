// Delete did nothing after a card was selected through a button.
//
// Click a session row in the list (L), a session's name on the canvas, or the
// topbar ribbon: the card is selected and the detail panel opens, and the
// clicked button keeps focus, because selecting a card moves no DOM focus.
// Delete — which the panel's "Remove from board" and the shortcuts sheet both
// name — then went to the button. #851 gives a mouse-pressed button's keys
// back to the deck, but only single characters, and "Delete" is six; the
// focused-control gate kept it, and the handler returned before its Delete
// line. Esc first did not help either: Esc also clears the selection Delete
// was going to act on.
//
// A button has no more use for Delete than for a letter. It keeps Space and
// Enter, which are how it is pressed.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), useEffect: (run: () => void) => { run(); } }));

const { button, mountDeckKeys } = await import("./deck-keys-harness");

afterEach(() => { vi.unstubAllGlobals(); });

describe("Delete after selecting a card through a button", () => {
  it("removes the selected card while the button the mouse pressed still has focus", () => {
    const deck = mountDeckKeys();
    deck.press("Delete", { target: button(), pointer: true });
    expect(deck.removeSelected).toHaveBeenCalledTimes(1);
  });

  it("does the same for a role=button the mouse pressed", () => {
    const deck = mountDeckKeys();
    deck.press("Delete", { target: { tagName: "DIV", role: "button" }, pointer: true });
    expect(deck.removeSelected).toHaveBeenCalledTimes(1);
  });

  it("still leaves Space and Enter to the button, which is how it is pressed", () => {
    const deck = mountDeckKeys();
    deck.press(" ", { target: button(), pointer: true });
    deck.press("Enter", { target: button(), pointer: true });
    expect(deck.props.togglePause).not.toHaveBeenCalled();
  });

  it("leaves Delete with a button reached by Tab, as it leaves the letters (#851)", () => {
    const deck = mountDeckKeys();
    deck.press("Delete", { target: button() });
    expect(deck.removeSelected).not.toHaveBeenCalled();
  });
});
