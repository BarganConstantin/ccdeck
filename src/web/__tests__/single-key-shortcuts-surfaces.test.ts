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
import { SessionRun, SourceRun } from "../components/TopbarRuns";
import { WaitingStat } from "../components/TopbarReadouts";
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
const toggles = { sessionList: ref(), usage: ref(), accounts: ref(), machine: ref() };

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
  const titles = (html: string) => [...html.matchAll(/title="([^"]*)"/g)].map(m => m[1].replace(/&#x27;/g, "'"));
  const drawRuns = () => renderToStaticMarkup(createElement("div", null,
    createElement(SessionRun, {
      sessionListOpen: false, toggleSessionList: noop, usagePanelOpen: false, setUsagePanelOpen: noop,
      setUsageHistoryOpen: noop, toggles,
    }),
    createElement(SourceRun, {
      providers: { kind: "reported", claude: true, codex: true }, accountsPanelOpen: false, toggleAccountsPanel: noop,
      machinePanelOpen: false, setMachinePanelOpen: noop, watchOn: false, watchUnseen: 0, setBrowserWatchOpen: noop, toggles,
    }),
  ));

  it("names each topbar panel's letter while the keys are on", () => {
    const on = titles(drawRuns());
    for (const cap of ["L", "U", "H", "A", "S", "B"]) {
      expect(on.some(t => t.endsWith(`(${cap})`)), cap).toBe(true);
    }
  });

  it("names none of them once the keys are off, and keeps every sentence otherwise whole", () => {
    setSingleKeyShortcuts(false);
    const off = titles(drawRuns());
    expect(off).toContain("Show session list");
    expect(off).toContain("Show usage panel");
    expect(off).toContain("Usage history — ccusage");
    expect(off).toContain("Show accounts");
    expect(off).toContain("Show this machine — cores, memory, temperature");
    expect(off).toContain("Browser watch — not watching; reading the browser's history live");
    for (const t of off) expect(t, t).not.toMatch(/\([A-Z?]\)|\(Space\)/);
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

  it("says click, not press W, on the waiting count", () => {
    const waitingSessions = [{ id: "s1", label: "api", waiting: { kind: "permission", since: 0, message: "Run tests?" } }];
    const draw = () => renderToStaticMarkup(createElement(WaitingStat, {
      waitingSessions, waitingCursorRef: { current: null }, focusSession: noop, now: 1_000,
    } as unknown as Parameters<typeof WaitingStat>[0]));
    expect(draw()).toContain("click, or press W, to go to");
    setSingleKeyShortcuts(false);
    expect(draw()).toContain("Blocked waiting for you — click to go to");
    expect(draw()).not.toMatch(/press W/);
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
  it("lists only the keys that still work: the chord, the named keys and the mouse", () => {
    const rows = keyHelpFor(false).flatMap(g => g.rows);
    expect(rows.map(r => r.cap)).toEqual([
      "Delete", "Ctrl + ,", "Tab", "Enter", "Shift + Enter", "Esc",
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
