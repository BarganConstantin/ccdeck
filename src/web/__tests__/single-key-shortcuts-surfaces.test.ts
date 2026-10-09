// WCAG 2.1.4 Character Key Shortcuts, on screen: Settings › General's
// "Single-key shortcuts" switch — the row itself, that it is remembered, every
// tooltip and hint that names a letter and stops naming it once the switch is
// off, and the shortcuts sheet, which then says the keys are off and where to
// turn them on. The keys themselves are single-key-shortcuts-keys.test.ts's.
//
// Drawn with renderToStaticMarkup; no DOM.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isCharacterKey, setSingleKeyShortcuts, singleKeyShortcutsOn, SINGLE_KEY_SHORTCUTS_KEY } from "../single-key-shortcuts";
import { KEY_HELP, KEY_HELP_NOTE, KEY_HELP_OFF_TITLE, KEY_HELP_SWITCH_NOTE, keyHelpFor } from "../key-help";
import { pauseTitle, statusPill } from "../status-pill";
import { boardScopeTitle, BOARD_SCOPE_TITLE } from "../board-usage";
import { WaitingStat } from "../components/TopbarReadouts";
import { EdgeRail, UtilityRun, liveKey, railHint } from "../components/EdgeRails";
import { attr, buttons, draw, items } from "./edge-keys-rails";
import DragTrashZone from "../components/DragTrashZone";
import KeyboardHelp from "../components/KeyboardHelp";
import SoundSwitch from "../components/SoundSwitch";
import ThemeSection from "../components/ThemeSection";
import KeyboardSection, { SINGLE_KEYS_LABEL, SINGLE_KEYS_NOTE } from "../components/KeyboardSection";
import { sourceOf } from "./client-source";

afterEach(() => {
  vi.unstubAllGlobals();
  setSingleKeyShortcuts(true);
});

const noop = () => {};
const ref = () => ({ current: null });

// ── the setting ─────────────────────────────────────────────────────────────

describe("the switch persists across a reload", () => {
  function fakeWindow(stored: Map<string, string>) {
    const listeners = new Map<string, (e: StorageEvent) => void>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => stored.get(k) ?? null,
        setItem: (k: string, v: string) => { stored.set(k, v); },
        removeItem: (k: string) => { stored.delete(k); },
      },
      addEventListener: (type: string, fn: (e: StorageEvent) => void) => { listeners.set(type, fn); },
      removeEventListener: (type: string) => { listeners.delete(type); },
    });
    return listeners;
  }

  it("stores off under its own key and reads it back off after a reload", async () => {
    const stored = new Map<string, string>();
    fakeWindow(stored);
    vi.resetModules();
    const before = await import("../single-key-shortcuts");
    expect(before.singleKeyShortcutsOn()).toBe(true);
    before.setSingleKeyShortcuts(false);
    expect(stored.get("agent-dag.single-key-shortcuts")).toBe("0");

    vi.resetModules();
    const after = await import("../single-key-shortcuts");
    expect(after.SINGLE_KEY_SHORTCUTS_KEY).toBe("agent-dag.single-key-shortcuts");
    expect(after.singleKeyShortcutsOn()).toBe(false);
    after.setSingleKeyShortcuts(true);
    expect(stored.get("agent-dag.single-key-shortcuts")).toBe("1");
  });

  it("tells every reader the moment it flips, and follows a flip made in another tab", async () => {
    const stored = new Map<string, string>();
    const windowListeners = fakeWindow(stored);
    vi.resetModules();
    const store = await import("../single-key-shortcuts");
    const heard = vi.fn();
    const stop = store.subscribeSingleKeyShortcuts(heard);
    store.setSingleKeyShortcuts(false);
    expect(heard).toHaveBeenCalledTimes(1);
    windowListeners.get("storage")?.({ key: "agent-dag.single-key-shortcuts", newValue: "1" } as StorageEvent);
    expect(store.singleKeyShortcutsOn()).toBe(true);
    expect(heard).toHaveBeenCalledTimes(2);
    windowListeners.get("storage")?.({ key: "agent-dag.theme", newValue: "light" } as StorageEvent);
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
    expect(windowListeners.has("storage")).toBe(false);
  });

  it("is written by its store alone, never by the Settings row", () => {
    expect(sourceOf("components/KeyboardSection.tsx")).not.toMatch(/localStorage|writeStored|readStored/);
    expect(SINGLE_KEY_SHORTCUTS_KEY).toBe("agent-dag.single-key-shortcuts");
  });
});

describe("the Settings row", () => {
  it("is a switch named Single-key shortcuts, with its one-line note, on by default", () => {
    const html = renderToStaticMarkup(createElement(KeyboardSection, { singleKeys: true, onToggleSingleKeys: noop }));
    expect(SINGLE_KEYS_LABEL).toBe("Single-key shortcuts");
    expect(html).toContain(`>${SINGLE_KEYS_LABEL}</span>`);
    expect(html).toMatch(/role="switch" aria-checked="true" aria-labelledby="settings-single-keys-label" aria-describedby="settings-single-keys-note"/);
    expect(html).toContain(SINGLE_KEYS_NOTE);
    expect(html).toMatch(/<h3 id="settings-keyboard-caption">Keyboard<\/h3>/);
  });

  it("names keys the sheet lists and the switch silences, Space and ? among them", () => {
    expect(SINGLE_KEYS_NOTE).toMatch(/\bL, U, M, \? and Space\b/);
    const caps = KEY_HELP.flatMap(g => g.rows).filter(r => !r.chord && r.binds.some(isCharacterKey)).map(r => r.cap);
    for (const cap of ["L", "U", "M", "?", "Space"]) expect(caps, cap).toContain(cap);
    expect(SINGLE_KEYS_NOTE).toMatch(/voice control/);
  });

  it("draws T's cap and names it to assistive tech only while T does something", () => {
    const on = renderToStaticMarkup(createElement(ThemeSection, { theme: "dark", onTheme: noop, singleKeys: true }));
    const off = renderToStaticMarkup(createElement(ThemeSection, { theme: "dark", onTheme: noop, singleKeys: false }));
    expect(on).toMatch(/<kbd class="settings-key"[^>]*>T<\/kbd>/);
    expect(on).toContain('aria-keyshortcuts="T"');
    expect(off).not.toMatch(/<kbd/);
    expect(off).not.toContain("aria-keyshortcuts");
  });

  it("draws M's note under the sound switch only while M does something", () => {
    expect(renderToStaticMarkup(createElement(SoundSwitch, { soundOn: true, onToggleSound: noop }))).toContain("<kbd>M</kbd>");
    setSingleKeyShortcuts(false);
    expect(renderToStaticMarkup(createElement(SoundSwitch, { soundOn: true, onToggleSound: noop }))).not.toContain("<kbd>");
  });
});

// ── the titles ──────────────────────────────────────────────────────────────

describe("titles drop the letter when the switch is off", () => {
  // The panel buttons left the topbar for the window's edges (2026-10-08,
  // EdgeRails.tsx), and the deck's chrome traded `title` for one hint
  // (use-hint.tsx): the control's name and its key in a keycap. The rule this
  // block holds is unchanged — a control names its letter while the letter
  // does something, and never once the switch is off — and it now reaches
  // three places: the hint's keycap, aria-keyshortcuts, and the hint itself,
  // which says nothing at all when the key was the one thing it added.
  /** Both stripes and the topbar's utilities, drawn, by their data-rail-item. */
  const drawChrome = () => {
    const chrome = items();
    return buttons(draw(createElement("div", null,
      createElement(EdgeRail, { side: "left", label: "Left column", groups: [chrome.left] }),
      createElement(EdgeRail, { side: "right", label: "Right panels", groups: chrome.right }),
      createElement(UtilityRun, { items: chrome.utilities }),
    )));
  };
  const LETTERS: Array<[string, string]> = [
    ["session-list", "L"], ["usage", "U"], ["history", "H"], ["accounts", "A"], ["machine", "S"], ["browser-watch", "B"],
  ];
  const every = () => { const c = items(); return [...c.left, ...c.right.flat(), ...c.utilities]; };

  it("names each panel button's letter while the keys are on", () => {
    const on = drawChrome();
    for (const [id, cap] of LETTERS) {
      expect(attr(on.get(id)!, "aria-keyshortcuts"), id).toBe(cap);
      expect(railHint(every().find(i => i.id === id)!, true, true)?.keys, id).toBe(cap);
    }
  });

  it("names none of them once the keys are off, and keeps every hint that says more than the word", () => {
    setSingleKeyShortcuts(false);
    const off = drawChrome();
    for (const [id] of LETTERS) {
      expect(attr(off.get(id)!, "aria-keyshortcuts"), id).toBeNull();
      expect(railHint(every().find(i => i.id === id)!, false, true)?.keys, id).toBeUndefined();
    }
    // What the old titles said beyond the letter is still said wherever there
    // was more to say — a longer name than the word on the button, or Browser
    // watch's state — and a button whose word is the whole of its name says
    // nothing more, rather than a hint repeating the word.
    for (const item of every().filter(i => i.key?.single)) {
      const hint = railHint(item, false, true);
      const more = (item.hint != null && item.hint !== item.label) || item.detail != null;
      expect(hint === null, `${item.id}: a hint ${more ? "missing" : "repeating its word"}`).toBe(!more);
      if (hint) expect(hint.label, item.id).toBe(item.hint ?? item.label);
    }
    expect(railHint(every().find(i => i.id === "browser-watch")!, false, true)?.detail).toMatch(/watching/i);
    // No letter anywhere in the drawn chrome, as a title or otherwise.
    for (const tag of off.values()) expect(tag, tag).not.toMatch(/title=|\([A-Z?]\)|\(Space\)/);
  });

  it("keeps the gear's chord whichever way the switch is set — a chord is not a single key", () => {
    for (const singleKeys of [true, false]) {
      setSingleKeyShortcuts(singleKeys);
      const gear = drawChrome().get("settings")!;
      expect(attr(gear, "aria-keyshortcuts"), `switch ${singleKeys ? "on" : "off"}`).toBe("Control+, Meta+,");
      const settings = every().find(i => i.id === "settings")!;
      expect(liveKey(settings.key, singleKeys)?.aria).toBe("Control+, Meta+,");
      expect(railHint(settings, singleKeys, true)?.keys).toBe(settings.key!.cap);
    }
  });

  it("drops Space from the pause control's and the pill's titles", () => {
    for (const paused of [false, true]) {
      expect(pauseTitle({ paused, held: 3 })).toMatch(/\(Space\)$/);
      expect(pauseTitle({ paused, held: 3, singleKeys: false })).not.toMatch(/Space/);
    }
    expect(statusPill({ connected: true, paused: true, held: 2 }).title).toMatch(/\(Space\)$/);
    expect(statusPill({ connected: true, paused: true, held: 2, singleKeys: false }).title).not.toMatch(/Space/);
    expect(statusPill({ connected: true, paused: true, held: 2, dropped: 1, singleKeys: false }).title).not.toMatch(/Space/);
  });

  it("points the usage scope at Usage history by name instead of by H", () => {
    expect(boardScopeTitle(true)).toBe(BOARD_SCOPE_TITLE);
    expect(boardScopeTitle(false)).not.toMatch(/\bH\b/);
    expect(boardScopeTitle(false)).toMatch(/Usage history has the totals ccusage reads/);
    expect(boardScopeTitle(false).startsWith(BOARD_SCOPE_TITLE.slice(0, BOARD_SCOPE_TITLE.indexOf("Press H")))).toBe(true);
  });

  it("names W on the waiting count only while W does anything", () => {
    // The count's title said "click, or press W"; since the chrome's hint
    // replaced titles it names W in a keycap and in aria-keyshortcuts, and
    // the click is offered either way.
    const waitingSessions = [{ id: "s1", label: "api", waiting: { kind: "permission", since: 0, message: "Run tests?" } }];
    const count = () => buttons(draw(createElement(WaitingStat, {
      waitingSessions, waitingCursorRef: { current: null }, focusSession: noop, now: 1_000, named: 0,
    } as unknown as Parameters<typeof WaitingStat>[0])).replace(/<button /g, '<button data-rail-item="count" '));
    expect(attr(count().get("count")!, "aria-keyshortcuts")).toBe("W");
    setSingleKeyShortcuts(false);
    expect(attr(count().get("count")!, "aria-keyshortcuts")).toBeNull();
    expect(count().get("count")!).not.toMatch(/press W|title=/);
    // The hint's keycap follows the same switch: the spec handed to it.
    expect(sourceOf("components/TopbarReadouts.tsx")).toContain('keys: singleKeys ? "W" : undefined');
  });

  it("says the session list brings a card back, without its letter, while one is dragged to the bin", () => {
    const draw = () => renderToStaticMarkup(createElement(DragTrashZone, {
      trashZoneRef: ref(), trashState: "over", trashPhase: "shown", trashLabel: "api",
    } as unknown as Parameters<typeof DragTrashZone>[0]));
    expect(draw()).toContain("The session list (L) brings it back");
    setSingleKeyShortcuts(false);
    expect(draw()).toContain("The session list brings it back");
  });

  it("builds every other title that names a key through the same rule", () => {
    for (const [rel, call] of [
      ["components/CanvasControls.tsx", 'withKey("Auto-arrange — clear pins", "R", singleKeys)'],
      ["components/CanvasControls.tsx", 'singleKeys ? withKey("Keyboard shortcuts", "?", true) : "Keyboard shortcuts — the single-key ones are off"'],
      ["components/CanvasControls.tsx", "dropped: pauseGate.dropped, singleKeys })"],
      ["components/SessionList.tsx", 'withKey("Hide sidebar", "L", singleKeys)'],
      ["components/UsagePanel.tsx", 'withKey("Close", "U", singleKeys)'],
      ["components/AccountsPanel.tsx", 'withKey("Close", "A", singleKeys)'],
      ["components/SelectedRibbon.tsx", '"Z", singleKeys)'],
      ["components/Detail.tsx", 'withKey("The session list", "L", singleKeys)'],
    ] as const) {
      expect(sourceOf(rel), rel).toContain(call);
    }
  });
});

// ── the shortcuts sheet ─────────────────────────────────────────────────────

describe("the shortcuts sheet with the switch off", () => {
  it("lists only the keys that still work: the chords, the named keys and the mouse", () => {
    const rows = keyHelpFor(false).flatMap(g => g.rows);
    // Ctrl + Z since Re-arrange can be undone: the stack's button still
    // re-arranges with the letters off, and the chord still takes it back.
    expect(rows.map(r => r.cap)).toEqual([
      "Delete", "Ctrl + Z", "Ctrl + ,", "Tab", "Enter", "Shift + Enter", "Esc",
      "drag", "shift-click", "click", "double-click", "hover",
    ]);
    expect(keyHelpFor(false).map(g => g.title)).not.toContain("Panels and dialogs");
    expect(rows.find(r => r.cap === "Delete")?.action).toBe("take the selected card off the board — the session list brings it back");
    expect(keyHelpFor(true)).toBe(KEY_HELP);
  });

  it("says the keys are off and where they are turned on, with a way there", () => {
    setSingleKeyShortcuts(false);
    const html = renderToStaticMarkup(createElement(KeyboardHelp, { onClose: noop, onSettings: noop }));
    expect(html).toContain(KEY_HELP_OFF_TITLE);
    expect(html).toContain('<span class="kh-place">Settings › General</span>');
    expect(html).toMatch(/<button type="button" class="btn">Open Settings<\/button>/);
    expect(html).not.toMatch(/<kbd>[A-Z?]<\/kbd>/);
    expect(html).not.toContain("kh-foot");
    // Said with the dialog's title, not only found by reading on.
    expect(html).toContain('aria-describedby="key-help-off"');
    expect(html).toContain('id="key-help-off"');
  });

  it("is the sheet it always was while the switch is on, with where to turn the letters off under the keys", () => {
    const html = renderToStaticMarkup(createElement(KeyboardHelp, { onClose: noop, onSettings: noop }));
    expect(html).not.toContain("kh-off");
    expect(html).not.toContain("aria-describedby");
    expect(html).toContain("<kbd>L</kbd>");
    expect(html).toContain(`<p class="kh-foot">${KEY_HELP_NOTE} ${KEY_HELP_SWITCH_NOTE}</p>`);
    expect(KEY_HELP_SWITCH_NOTE).toBe("Single-key shortcuts can be turned off in Settings › General.");
  });

  it("says on the ? button, with the keys off, why ? does nothing", () => {
    expect(sourceOf("components/CanvasControls.tsx")).toContain('"Keyboard shortcuts — the single-key ones are off"');
  });

  it("is still reachable with the keys off: the canvas stack's button opens it, and its door opens Settings at General", () => {
    expect(sourceOf("components/CanvasControls.tsx")).toContain("onClick={() => setKeyHelpOpen(o => !o)}");
    expect(sourceOf("components/DeckDialogs.tsx")).toContain('onSettings={() => { setKeyHelpOpen(false); openSettings("general"); }}');
    expect(singleKeyShortcutsOn()).toBe(true);
  });
});
