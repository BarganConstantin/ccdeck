// A shortcut held past the key-repeat delay ran again on every repeat.
//
// The handler never read `e.repeat`, so holding Space flipped pause and resume
// about thirty times a second and the stream ended paused or live depending on
// when the key came up; T flickered the theme and L, D and U the panels the
// same way. A held key is one press. J and K are the exception: holding them
// to step through the board quickly is what a held key is for there.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), useEffect: (run: () => void) => { run(); } }));

const { mountDeckKeys } = await import("./deck-keys-harness");

afterEach(() => { vi.unstubAllGlobals(); });

/** The key pressed once and then held through `n` auto-repeats. */
function hold(deck: ReturnType<typeof mountDeckKeys>, key: string, n = 5) {
  const first = deck.press(key);
  const repeats = Array.from({ length: n }, () => deck.press(key, { repeat: true }));
  return { first, repeats };
}

describe("a held shortcut acts once", () => {
  it("pauses once for a held Space, and still keeps the repeats from scrolling the page", () => {
    const deck = mountDeckKeys();
    const { repeats } = hold(deck, " ");
    expect(deck.props.togglePause).toHaveBeenCalledTimes(1);
    for (const e of repeats) expect(e.preventDefault).toHaveBeenCalled();
  });

  it("switches the theme once for a held T", () => {
    const deck = mountDeckKeys();
    hold(deck, "t");
    expect(deck.theme.value).toBe("rider-black");
    expect(deck.theme.set).toHaveBeenCalledTimes(1);
  });

  it("opens a panel once for a held L, D or U", () => {
    const deck = mountDeckKeys();
    hold(deck, "l");
    hold(deck, "d");
    hold(deck, "u");
    expect(deck.props.toggleSessionList).toHaveBeenCalledTimes(1);
    expect(deck.detail.set).toHaveBeenCalledTimes(1);
    expect(deck.usage.value).toBe(true);
  });

  it("keeps stepping for a held J or K", () => {
    const deck = mountDeckKeys();
    hold(deck, "j", 4);
    hold(deck, "k", 2);
    expect(deck.props.stepAgent).toHaveBeenCalledTimes(1 + 4 + 1 + 2);
  });
});
