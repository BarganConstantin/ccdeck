// The deck's one keydown handler, run without a browser.
//
// useDeckShortcuts is a single effect that puts a listener on window. A test
// that mocks React's useEffect to run at once (the mock has to sit in the test
// file, where vitest hoists it) can call the hook as a plain function, catch
// the listener on a stubbed window, and hand it keystrokes shaped the way the
// handler reads them: the key, its modifiers, `repeat`, and a target with a tag
// and a role. What each keystroke reached is read back off the spies.
//
// The terminal stage is optional twice over, the way it is in the deck: a
// test that hands no `stage` mounts the hook with exactly the props it took
// before the stage existed, and a target that is not marked `inPanel` has no
// `closest` to answer the pane's question with.
import { vi } from "vitest";
import type { SetStateAction } from "react";
import { initialState } from "../reducer";
import type { Theme } from "../theme";
import { useDeckShortcuts, type DeckShortcuts, type StageShortcuts } from "../use-deck-shortcuts";

/** A flag the handler flips through a React setter, with its value kept. */
export interface Flag<T> {
  value: T;
  set: ReturnType<typeof vi.fn>;
}

function flag<T>(initial: T): Flag<T> {
  const f: Flag<T> = {
    value: initial,
    set: vi.fn((next: SetStateAction<T>) => {
      f.value = typeof next === "function" ? (next as (prev: T) => T)(f.value) : next;
    }),
  };
  return f;
}

/** The focused element, as much of one as the handler reads. */
export interface KeyTarget {
  tagName: string;
  role?: string;
  type?: string;
  blur?: () => void;
  /** Inside the terminal pane: the target answers `closest("[data-terminal-panel]")`.
   *  Left out, the target has no `closest` at all, as every target here had
   *  before the stage existed. */
  inPanel?: boolean;
}

export const BODY: KeyTarget = { tagName: "BODY" };
export const button = (): KeyTarget => ({ tagName: "BUTTON" });

/** What a deck mounts with, where a test needs other than the default. */
export interface DeckKeysOptions {
  /** Whether Claude Code is on the machine; it is, unless a test says not. */
  claude?: boolean;
  /** The terminal stage the deck is handed, if any — see `stageKeys`. Left
   *  out, the deck is mounted exactly as it was before the stage existed. */
  stage?: StageShortcuts | null;
}

/** A terminal stage whose every callback is a spy, open on `s1` with three
 *  sessions in the navigator. Mutable, so a test can move or close it. */
export function stageKeys(over: Partial<StageShortcuts> = {}): StageShortcuts {
  return {
    open: true,
    current: "s1",
    order: ["s1", "s2", "s3"],
    focusTile: vi.fn(),
    switchTo: vi.fn(),
    focusPane: vi.fn(),
    nextAsk: vi.fn(),
    release: vi.fn(),
    ...over,
  };
}

export function mountDeckKeys({ claude = true, stage }: DeckKeysOptions = {}) {
  let onKey: ((e: KeyboardEvent) => void) | null = null;
  vi.stubGlobal("window", {
    addEventListener: (type: string, fn: (e: KeyboardEvent) => void) => { if (type === "keydown") onKey = fn; },
    removeEventListener: () => {},
  });
  const keyHelp = flag(false);
  const theme = flag<Theme>("dark");
  const detail = flag(false);
  const usage = flag(false);
  const pointerFocusRef = { current: null as EventTarget | null };
  const removeSelected = vi.fn();
  const props: DeckShortcuts = {
    pointerFocusRef,
    nodesRef: { current: [] },
    stateRef: { current: initialState() },
    primarySelectedIdRef: { current: "s1" },
    providersRef: { current: { claude } },
    soundOnRef: { current: true },
    // Mirrored from the flag, the way App mirrors its state into the ref.
    keyHelpOpenRef: { get current() { return keyHelp.value; } },
    // The sheet is one of App's own dialogs, so it counts here while open.
    modalOpenRef: { get current() { return keyHelp.value; } },
    waitingCursorRef: { current: null },
    removeSelectedRef: { current: removeSelected },
    activateSoundRef: { current: vi.fn() },
    clearSelection: vi.fn(),
    selectAgent: vi.fn(),
    focusAgent: vi.fn(),
    stepAgent: vi.fn(),
    focusSession: vi.fn(),
    requestClear: vi.fn(),
    handleRelayout: vi.fn(),
    handleFit: vi.fn(),
    togglePause: vi.fn(),
    toggleSessionList: vi.fn(),
    toggleAccountsPanel: vi.fn(),
    setDetailOpen: detail.set,
    setUsageHistoryOpen: vi.fn(),
    setUsagePanelOpen: usage.set,
    setMachinePanelOpen: vi.fn(),
    setBrowserWatchOpen: vi.fn(),
    setKeyHelpOpen: keyHelp.set,
    setTheme: theme.set,
    openSettings: vi.fn(),
    // Only when a test hands one over, so every other test mounts the deck
    // with the very props it always had.
    ...(stage !== undefined ? { stageRef: { current: stage } } : {}),
  };
  useDeckShortcuts(props);
  if (!onKey) throw new Error("useDeckShortcuts put no keydown listener on window");
  const listener: (e: KeyboardEvent) => void = onKey;

  /** One keydown. `pointer` marks the target as focused by a pointer press (#851). */
  function press(key: string, o: {
    target?: KeyTarget; repeat?: boolean; shiftKey?: boolean; pointer?: boolean;
    ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; code?: string;
  } = {}) {
    const target = o.target ?? BODY;
    const { inPanel, ...rest } = target;
    const e = {
      key, repeat: o.repeat ?? false, shiftKey: o.shiftKey ?? false,
      ctrlKey: o.ctrlKey ?? false, metaKey: o.metaKey ?? false, altKey: o.altKey ?? false,
      code: o.code,
      target: {
        ...rest,
        getAttribute: (name: string) => (name === "role" ? target.role ?? null : null),
        ...(inPanel !== undefined ? { closest: (sel: string) => (inPanel && sel === "[data-terminal-panel]" ? {} : null) } : {}),
      },
      preventDefault: vi.fn(),
    };
    // The handler compares the target with the pointer's mark by identity.
    if (o.pointer) pointerFocusRef.current = e.target as unknown as EventTarget;
    listener(e as unknown as KeyboardEvent);
    return e;
  }

  return { props, press, keyHelp, theme, detail, usage, removeSelected };
}
