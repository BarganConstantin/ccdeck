// T did nothing while a dialog was open.
//
// The owner pressed T over the Jira panel and the deck stayed in its theme:
// the modal gate drops every single-key shortcut behind a dialog, T with them,
// and only Settings answered T itself. The next theme acts on nothing the
// scrim covers — the theme is the page's, and the dialog repaints with the
// deck — so since 2026-10-23 T goes through every dialog, by the owner's call,
// on one path for all of them. A field being typed in keeps its letters, a
// chord stays the browser's, a held key is one press, and every other letter
// still stops at the dialog.
//
// The handler runs through deck-keys-harness.ts, as settings-chord.test.ts
// runs it.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), useEffect: (run: () => void) => { run(); } }));

const { BODY, button, mountDeckKeys } = await import("./deck-keys-harness");
const { modalStack } = await import("../modal-dismiss");
const { THEMES, nextTheme } = await import("../theme");
const { sourceOf } = await import("./client-source");

afterEach(() => { vi.unstubAllGlobals(); });

/** A dialog on the dismiss stack, the way every dialog joins it on mount;
 *  closed again once `run` is done, so no test inherits another's. */
function withDialog<T>(run: (dismissed: ReturnType<typeof vi.fn>) => T): T {
  const dismissed = vi.fn();
  const close = modalStack.push(dismissed);
  try {
    return run(dismissed);
  } finally {
    close();
  }
}

const TEXT = [
  { tagName: "INPUT" }, { tagName: "INPUT", type: "text" }, { tagName: "INPUT", type: "search" },
  { tagName: "INPUT", type: "url" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" },
  { tagName: "DIV", isContentEditable: true },
];

describe("T behind an open dialog", () => {
  it("moves to the next theme, and leaves the dialog open", () => {
    const deck = mountDeckKeys();
    withDialog(dismissed => {
      deck.press("t");
      expect(deck.theme.value).toBe(nextTheme("dark"));
      deck.press("T");
      expect(deck.theme.value).toBe(nextTheme(nextTheme("dark")));
      expect(dismissed).not.toHaveBeenCalled();
    });
    expect(deck.theme.set).toHaveBeenCalledTimes(2);
  });

  it("answers whatever in the dialog has focus that is not text", () => {
    // A dialog puts focus on its first control by program, which the
    // focused-control gate would have handed the letter: the sheet's ×, a
    // panel's tab, Settings' section tab or a theme radio.
    const targets = [BODY, button(), { tagName: "BUTTON", role: "tab" }, { tagName: "BUTTON", role: "radio" },
      { tagName: "A" }, { tagName: "INPUT", type: "checkbox" }, { tagName: "DIV", role: "switch" }];
    const deck = mountDeckKeys();
    withDialog(() => { for (const target of targets) deck.press("t", { target }); });
    expect(deck.theme.set).toHaveBeenCalledTimes(targets.length);
  });

  it("works over the shortcuts sheet, from the × it gave focus to, and leaves the sheet open", () => {
    const deck = mountDeckKeys();
    deck.press("?");
    deck.press("t", { target: button() });
    expect(deck.theme.value).toBe(nextTheme("dark"));
    expect(deck.keyHelp.value).toBe(true);
  });

  it("types into a field inside the dialog instead", () => {
    const deck = mountDeckKeys();
    withDialog(() => {
      for (const target of TEXT) {
        deck.press("t", { target });
        deck.press("T", { target, shiftKey: true });
      }
    });
    expect(deck.theme.set).not.toHaveBeenCalled();
  });

  it("leaves Ctrl+T, Cmd+T and Alt+T to the browser, over a dialog and on the board", () => {
    const deck = mountDeckKeys();
    const chords = [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { ctrlKey: true, shiftKey: true }];
    withDialog(() => { for (const chord of chords) deck.press("t", { ...chord, target: button() }); });
    for (const chord of chords) deck.press("t", chord);
    expect(deck.theme.set).not.toHaveBeenCalled();
  });

  it("is one press for a held key", () => {
    const deck = mountDeckKeys();
    withDialog(() => {
      deck.press("t");
      for (let i = 0; i < 5; i++) deck.press("t", { repeat: true });
    });
    expect(deck.theme.set).toHaveBeenCalledTimes(1);
  });

  it("is the only letter that goes through: every other one still stops at the dialog", () => {
    const deck = mountDeckKeys();
    withDialog(() => {
      for (const key of [..."abcdefghijklmnopqrsuvwxyzABCDEFGHIJKLMNOPQRSUVWXYZ", " ", "?"]) {
        deck.press(key);
        deck.press(key, { target: button(), pointer: true });
      }
    });
    const props = deck.props as unknown as Record<string, unknown>;
    const reached = Object.entries(props)
      .filter(([, v]) => typeof v === "function" && "mock" in (v as object) && (v as ReturnType<typeof vi.fn>).mock.calls.length > 0)
      .map(([name]) => name);
    expect(reached).toEqual([]);
    expect(deck.props.removeSelectedRef.current).not.toHaveBeenCalled();
    expect(deck.props.activateSoundRef.current).not.toHaveBeenCalled();
  });
});

describe("T on the board, with no dialog", () => {
  it("moves to the next theme as before, and walks every theme in turn", () => {
    const deck = mountDeckKeys();
    for (let i = 0; i < THEMES.length; i++) deck.press("t");
    expect(deck.theme.value).toBe("dark");
    expect(deck.theme.set).toHaveBeenCalledTimes(THEMES.length);
  });

  it("is still kept by a button the keyboard focused, and not by one the pointer pressed (#851)", () => {
    const deck = mountDeckKeys();
    deck.press("t", { target: button() });
    expect(deck.theme.set).not.toHaveBeenCalled();
    deck.press("t", { target: button(), pointer: true });
    expect(deck.theme.set).toHaveBeenCalledTimes(1);
  });

  it("still types into a field", () => {
    const deck = mountDeckKeys();
    for (const target of TEXT) deck.press("t", { target });
    expect(deck.theme.set).not.toHaveBeenCalled();
  });
});

describe("T inside Settings", () => {
  it("switches exactly once per press, from the section tab Settings opens on and from a theme radio", () => {
    // Settings joins the stack as a dialog, and answers no T of its own: the
    // deck's handler is the one path, so a press cannot apply two themes.
    const deck = mountDeckKeys();
    withDialog(() => {
      deck.press("t", { target: { tagName: "BUTTON", role: "tab" } });
      expect(deck.theme.set).toHaveBeenCalledTimes(1);
      deck.press("t", { target: { tagName: "BUTTON", role: "radio" } });
      expect(deck.theme.set).toHaveBeenCalledTimes(2);
    });
    expect(deck.theme.value).toBe(nextTheme(nextTheme("dark")));
    expect(sourceOf("components/SettingsModal.tsx")).not.toMatch(/key [!=]== "[tT]"/);
    expect(sourceOf("components/ThemeSection.tsx")).not.toMatch(/key [!=]== "[tT]"/);
  });

  it("leaves its search field and its <select>s their letters", () => {
    const deck = mountDeckKeys();
    withDialog(() => {
      deck.press("t", { target: { tagName: "INPUT", type: "search" } });
      deck.press("t", { target: { tagName: "SELECT" } });
    });
    expect(deck.theme.set).not.toHaveBeenCalled();
  });
});
