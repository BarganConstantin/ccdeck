// Cmd+, on a Mac and Ctrl+, everywhere else opens Settings from anywhere on
// the deck — through the deck's one keydown handler, held to the gates every
// key there answers to. And M, which the Settings switch made reachable on a
// machine with no Claude Code, silences the deck there too.
//
// useDeckShortcuts is one effect that puts a listener on window; the mock
// below runs it at once so deck-keys-harness.ts can catch the listener on a
// stubbed window and hand it keystrokes.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), useEffect: (run: () => void) => { run(); } }));

const { BODY, button, mountDeckKeys } = await import("./deck-keys-harness");
const { modalStack } = await import("../modal-dismiss");
const { isSettingsChord, settingsChordLabel } = await import("../settings");
const { sourceOf } = await import("./client-source");

afterEach(() => { vi.unstubAllGlobals(); });

const noop = () => {};

// ── the chord ───────────────────────────────────────────────────────────────

describe("Cmd/Ctrl+, opens Settings from anywhere", () => {
  it("opens it on ⌘, and on Ctrl+, alike, since a build cannot know the keyboard", () => {
    const deck = mountDeckKeys();
    deck.press(",", { metaKey: true });
    deck.press(",", { ctrlKey: true });
    expect(deck.props.openSettings).toHaveBeenCalledTimes(2);
    // No section: the gear's door, which reopens the one shown last.
    expect(deck.props.openSettings).toHaveBeenCalledWith();
  });

  it("takes the chord from the browser, and only that chord", () => {
    const deck = mountDeckKeys();
    expect(deck.press(",", { metaKey: true }).preventDefault).toHaveBeenCalled();
    // A bare comma, and the chord with Alt or Shift held, are someone else's.
    for (const press of [{}, { metaKey: true, altKey: true }, { ctrlKey: true, shiftKey: true }]) {
      expect(deck.press(",", press).preventDefault, JSON.stringify(press)).not.toHaveBeenCalled();
    }
    expect(deck.props.openSettings).toHaveBeenCalledTimes(1);
  });

  it("works with a button the keyboard focused, which owns its letters and not this chord", () => {
    const deck = mountDeckKeys();
    deck.press(",", { metaKey: true, target: button() });
    expect(deck.props.openSettings).toHaveBeenCalledTimes(1);
  });

  it("leaves a field somebody is typing in alone", () => {
    const deck = mountDeckKeys();
    for (const target of [{ tagName: "INPUT", type: "text" }, { tagName: "TEXTAREA" }, { tagName: "INPUT", type: "url" }]) {
      const e = deck.press(",", { metaKey: true, target });
      expect(e.preventDefault, target.tagName).not.toHaveBeenCalled();
    }
    expect(deck.props.openSettings).not.toHaveBeenCalled();
  });

  it("opens nothing behind a dialog App keeps a flag for — the shortcuts sheet", () => {
    const deck = mountDeckKeys();
    deck.press("?");
    expect(deck.keyHelp.value).toBe(true);
    deck.press(",", { metaKey: true });
    expect(deck.props.openSettings).not.toHaveBeenCalled();
  });

  it("opens nothing behind a dialog only the dismiss stack knows about", () => {
    const deck = mountDeckKeys();
    const closeDialog = modalStack.push(noop);
    try {
      deck.press(",", { ctrlKey: true });
      expect(deck.props.openSettings).not.toHaveBeenCalled();
    } finally {
      closeDialog();
    }
    deck.press(",", { ctrlKey: true });
    expect(deck.props.openSettings).toHaveBeenCalledTimes(1);
  });

  it("opens over a popover, which covers nothing — and openSettings closes it", () => {
    const deck = mountDeckKeys();
    const closePopover = modalStack.push(noop, 0, "popover");
    try {
      deck.press(",", { metaKey: true });
    } finally {
      closePopover();
    }
    expect(deck.props.openSettings).toHaveBeenCalledTimes(1);
    expect(sourceOf("use-settings-menus.ts")).toMatch(
      /const openSettings = useCallback\(\(section\?: SettingsSection\) => \{\s*setSoundMenuOpen\(false\);/,
    );
  });

  it("is one press for a held chord", () => {
    const deck = mountDeckKeys();
    deck.press(",", { metaKey: true });
    deck.press(",", { metaKey: true, repeat: true });
    expect(deck.props.openSettings).toHaveBeenCalledTimes(1);
  });

  it("answers the chord rule the handler asks", () => {
    const k = (mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }>, key = ",") =>
      ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
    expect(isSettingsChord(k({ metaKey: true }))).toBe(true);
    expect(isSettingsChord(k({ ctrlKey: true }))).toBe(true);
    expect(isSettingsChord(k({}))).toBe(false);
    expect(isSettingsChord(k({ metaKey: true }, "."))).toBe(false);
    expect(isSettingsChord(k({ metaKey: true, altKey: true }))).toBe(false);
    expect(isSettingsChord(k({ ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it("is spelled, in the gear's tooltip, the way the keyboard in front of the reader spells it", () => {
    expect(settingsChordLabel("MacIntel")).toBe("⌘,");
    expect(settingsChordLabel("macOS")).toBe("⌘,");
    expect(settingsChordLabel("Win32")).toBe("Ctrl+,");
    expect(settingsChordLabel("Linux x86_64")).toBe("Ctrl+,");
    expect(settingsChordLabel("")).toBe("Ctrl+,");
  });
});

describe("M on a machine with no Claude Code", () => {
  it("lets M silence it there too, because there is a tone to silence and a switch it flips", () => {
    const deck = mountDeckKeys({ claude: false });
    deck.press("m");
    expect(deck.props.activateSoundRef.current).toHaveBeenCalledTimes(1);
    // V still opens nothing: the speaker it opens the popover under is not drawn.
    deck.press("v");
    expect(deck.props.setSoundMenuOpen).not.toHaveBeenCalled();
  });

  it("still waits for the stored flag before M inverts it", () => {
    const deck = mountDeckKeys();
    (deck.props.soundOnRef as { current: boolean | null }).current = null;
    deck.press("m", { target: BODY });
    expect(deck.props.activateSoundRef.current).not.toHaveBeenCalled();
  });
});
