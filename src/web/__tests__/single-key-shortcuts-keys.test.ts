// WCAG 2.1.4 Character Key Shortcuts, at the keyboard: with Settings ›
// General's "Single-key shortcuts" off, no key that types a character does
// anything — every letter, digit and punctuation mark, `?` and Space — while
// the chord, Escape and the other named keys go on working. On, which is where
// every deck starts, nothing changes. What the switch does to the surfaces that
// name a key is single-key-shortcuts-surfaces.test.ts's.
//
// The handler runs through deck-keys-harness.ts, as settings-chord.test.ts
// runs it.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), useEffect: (run: () => void) => { run(); } }));

const { BODY, mountDeckKeys } = await import("./deck-keys-harness");
const { modalStack } = await import("../modal-dismiss");
const { resolveSingleKeyShortcuts, setSingleKeyShortcuts } = await import("../single-key-shortcuts");
const { sourceOf } = await import("./client-source");

afterEach(() => {
  vi.unstubAllGlobals();
  setSingleKeyShortcuts(true);
});

/** Every spy the deck's keys can reach, so "nothing happened" is one check. */
function reached(deck: ReturnType<typeof mountDeckKeys>): string[] {
  const props = deck.props as unknown as Record<string, unknown>;
  const spies = Object.entries(props).filter(([, v]) => typeof v === "function" && "mock" in (v as object));
  const refSpies = [["removeSelected", deck.props.removeSelectedRef.current], ["activateSound", deck.props.activateSoundRef.current]] as const;
  return [...spies, ...refSpies]
    .filter(([, spy]) => (spy as ReturnType<typeof vi.fn>).mock.calls.length > 0)
    .map(([name]) => name as string);
}

// ── the keys ────────────────────────────────────────────────────────────────

describe("with Single-key shortcuts off, no character key does anything", () => {
  it("leaves L, U, M, R, ? and V doing nothing", () => {
    const deck = mountDeckKeys({ singleKeys: false });
    for (const key of ["l", "L", "u", "U", "m", "M", "r", "R", "?", "v", "V"]) deck.press(key);
    expect(reached(deck)).toEqual([]);
    expect(deck.keyHelp.value).toBe(false);
    expect(deck.usage.value).toBe(false);
  });

  it("silences every letter, digit, punctuation mark and Space the deck could answer", () => {
    const deck = mountDeckKeys({ singleKeys: false });
    const keys = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789?/.,;'[]-=` "];
    for (const key of keys) deck.press(key);
    expect(reached(deck)).toEqual([]);
    expect(deck.theme.value).toBe("dark");
    expect(deck.detail.value).toBe(false);
  });

  it("leaves Space to the page rather than cancelling it for a pause that no longer happens", () => {
    const on = mountDeckKeys();
    expect(on.press(" ").preventDefault).toHaveBeenCalled();
    const off = mountDeckKeys({ singleKeys: false });
    expect(off.press(" ").preventDefault).not.toHaveBeenCalled();
    expect(off.props.togglePause).not.toHaveBeenCalled();
  });

  it("is asked after the chord, Escape and a focused card's own keys, which are not on its list", () => {
    const handler = sourceOf("use-deck-shortcuts.ts");
    const gate = handler.indexOf("if (characterKeyMuted(e.key, singleKeyShortcutsOn())) return;");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(handler.indexOf('if (e.key === "Escape")'));
    expect(gate).toBeGreaterThan(handler.indexOf('if (e.key === "," && isSettingsChord(e))'));
    expect(gate).toBeGreaterThan(handler.indexOf('if (intent.kind === "node") return;'));
    expect(gate).toBeLessThan(handler.indexOf("closesKeySheet({"));
  });

  it("silences T inside Settings too, which the dialog answers itself", () => {
    const modal = sourceOf("components/SettingsModal.tsx");
    const gate = modal.indexOf("if (characterKeyMuted(event.key, singleKeys)) return;");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(modal.indexOf('if ((event.key !== "t" && event.key !== "T")'));
  });
});

describe("with Single-key shortcuts off, the keys that are not characters keep working", () => {
  it("opens Settings on Cmd+, and Ctrl+,", () => {
    const deck = mountDeckKeys({ singleKeys: false });
    deck.press(",", { metaKey: true });
    deck.press(",", { ctrlKey: true });
    expect(deck.props.openSettings).toHaveBeenCalledTimes(2);
  });

  it("closes the dialog on top with Escape", () => {
    const deck = mountDeckKeys({ singleKeys: false });
    const close = vi.fn();
    const leave = modalStack.push(close);
    try {
      deck.press("Escape");
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      leave();
    }
  });

  it("clears the selection on Escape with nothing open", () => {
    const deck = mountDeckKeys({ singleKeys: false });
    deck.press("Escape", { target: BODY });
    expect(deck.props.clearSelection).toHaveBeenCalledTimes(1);
  });

  it("takes the selected card off the board on Delete, a named key", () => {
    const deck = mountDeckKeys({ singleKeys: false });
    deck.press("Delete");
    expect(deck.removeSelected).toHaveBeenCalledTimes(1);
  });
});

describe("with Single-key shortcuts on, every key works as before", () => {
  it("answers L, U, M, R, ? and V", () => {
    const deck = mountDeckKeys();
    deck.press("l");
    deck.press("u");
    deck.press("m");
    deck.press("r");
    deck.press("v");
    deck.press("?");
    expect(deck.props.toggleSessionList).toHaveBeenCalledTimes(1);
    expect(deck.usage.value).toBe(true);
    expect(deck.props.activateSoundRef.current).toHaveBeenCalledTimes(1);
    expect(deck.props.handleRelayout).toHaveBeenCalledTimes(1);
    expect(deck.props.openSettings).toHaveBeenCalledWith("sounds");
    expect(deck.keyHelp.value).toBe(true);
  });

  it("is where a deck starts, with nothing stored", () => {
    expect(resolveSingleKeyShortcuts(null)).toBe(true);
    expect(resolveSingleKeyShortcuts("1")).toBe(true);
    expect(resolveSingleKeyShortcuts("0")).toBe(false);
  });
});
