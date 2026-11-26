// Zen Mode: Workspace's panes alone, over the whole window. The top bar, the
// stripes, the list, the Inspector, the side column and the status bar step
// out of sight; the pane headers stay, and one small Exit Zen Mode sits in the
// top right corner (StageShell.tsx draws it, zen-mode.css places it).
//
// LAYOUT ONLY, THE SAME TREE. Entering or leaving changes one attribute on
// the app root (data-zen) and nothing that is mounted: the panes, their
// terminals and Chat's drafts are the elements they were, and the chrome is
// hidden where it stands, so the list keeps its scroll and its filter. The
// pane's cell is what grows (.ws-cell, measured by use-stage.ts), so the
// split keeps its ratios, the terminals fit their new boxes and keep running.
//
// FULL SCREEN WHERE ESC CAN STAY THE TERMINAL'S. The browser's full screen is
// asked for only where the Keyboard Lock API exists (Chromium, the desktop
// app): Esc is locked for the page, so one press still reaches Claude Code
// and only the browser's long press leaves. Firefox and Safari have no lock,
// and there Esc would end full screen on every press: Zen fills the window
// instead, and the browser's own full screen is still the reader's to use. A
// refused request is the same fill-window Zen. Full screen ending by the
// platform's own way out (Esc held, the browser's controls) ends Zen too.
// Only a full screen Zen asked for is ever left by Zen: one ⤢ made is ⤢'s.
//
// NOT REMEMBERED. Every load starts with Zen off; it ends with Workspace (the
// Board, a phone-sized window, the pane gone).
import { useCallback, useEffect, useRef, useState } from "react";
import { enterFullStage, leaveFullStage } from "./tab-keys";
import { focusFirstTaking } from "./fold-focus";

// Keys, read with `t` where they are drawn.
export const ZEN_LABEL_MSG = "board.view.zen";
export const ZEN_HINT_MSG = "board.view.zenHint";
export const ZEN_EXIT_MSG = "board.view.zenExit";
export const ZEN_TOGGLE_MSG = "board.quick.action.zen";

interface KeyboardLockable { keyboard?: { lock?: unknown } }

/** Whether Zen also asks for the browser's full screen: only where Esc can be
 *  kept for the terminal (the Keyboard Lock API), and full screen exists. */
export function canZenFullScreen(
  doc: Pick<Document, "fullscreenEnabled"> | undefined = typeof document === "undefined" ? undefined : document,
  nav: KeyboardLockable | undefined = typeof navigator === "undefined" ? undefined : navigator as KeyboardLockable,
): boolean {
  return doc?.fullscreenEnabled === true && typeof nav?.keyboard?.lock === "function";
}

/** Where the keys go in the pane: its terminal, else Chat's composer (the
 *  pane shows Chat), else its first control. Never the list's row (out of
 *  sight in Zen), and never another pane's terminal: in a split, only the
 *  pane that has the keys (StageShell marks it data-focused), so Zen never
 *  moves them to a pane of its own choosing. */
const PANE_PLACES = [".xterm-helper-textarea", ".chat-composer-draft", "button:not(:disabled)"];
const FOCUSED_PANE_FOCUS = PANE_PLACES.map(s => `.stage-dock .wsp-pane[data-focused] ${s}`);
const ONE_PANE_FOCUS = PANE_PLACES.map(s => `.stage-dock ${s}`);

/** The keyboard into the pane that had it, a frame after the change. On the
 *  way in, from wherever it was outside the panes (the hidden chrome, the
 *  page); on the way out, only where it was left on nothing (Exit Zen Mode
 *  goes with Zen). A focus already in a pane stays where it is. */
function keysToPane(entering: boolean): void {
  if (typeof document === "undefined" || typeof requestAnimationFrame !== "function") return;
  requestAnimationFrame(() => {
    const at = document.activeElement;
    const lost = !at || at === document.body || !at.isConnected;
    if (entering ? !lost && at.closest?.(".stage-dock") : !lost) return;
    const split = document.querySelector(".stage-dock .wsp-pane[data-focused]") != null;
    focusFirstTaking(document, split ? FOCUSED_PANE_FOCUS : ONE_PANE_FOCUS);
  });
}

export interface ZenMode {
  /** Zen is on, and Workspace is there for it. */
  on: boolean;
  /** In the full screen Zen asked for. */
  full: boolean;
  enter(): void;
  exit(): void;
  toggle(): void;
}

/**
 * Zen's state. `available` is Workspace with its panes on screen: Zen is
 * offered only then, and ends the moment it is not. `canFull` stands in for
 * canZenFullScreen() in a test.
 */
export function useZenMode(available: boolean, canFull?: boolean): ZenMode {
  const [on, setOn] = useState(false);
  const [full, setFull] = useState(false);
  const onRef = useRef(false);
  /** The page is in full screen because Zen asked for it. */
  const ours = useRef(false);
  const availableRef = useRef(available);
  availableRef.current = available;

  const exit = useCallback(() => {
    if (!onRef.current) return;
    onRef.current = false;
    setOn(false);
    setFull(false);
    if (ours.current) {
      ours.current = false;
      leaveFullStage();
    }
    keysToPane(false);
  }, []);

  const enter = useCallback(() => {
    if (onRef.current || !availableRef.current) return;
    onRef.current = true;
    setOn(true);
    keysToPane(true);
    // Asked for inside the press, which full screen needs. A full screen the
    // page is already in (⤢'s) is not Zen's to ask for, nor to leave.
    if (!(canFull ?? canZenFullScreen()) || typeof document === "undefined" || document.fullscreenElement) return;
    void enterFullStage().then(ok => {
      if (!ok) return; // refused: Zen fills the window
      // Left again while the browser was on its way.
      if (!onRef.current) { leaveFullStage(); return; }
      ours.current = true;
      setFull(true);
    });
  }, [canFull]);

  const toggle = useCallback(() => (onRef.current ? exit() : enter()), [enter, exit]);

  // Full screen ended by the platform's way out (Esc held, the browser's own
  // control): Zen goes with it, and the lock with Zen.
  useEffect(() => {
    if (!on || typeof document === "undefined") return;
    const changed = () => {
      if (document.fullscreenElement || !ours.current) return;
      ours.current = false;
      leaveFullStage();
      exit();
    };
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, [on, exit]);

  // Workspace gone (the Board, a phone-sized window, the pane closed): Zen
  // ends with it.
  useEffect(() => { if (!available) exit(); }, [available, exit]);

  // The deck going away leaves the full screen it asked for.
  useEffect(() => () => {
    if (!ours.current) return;
    ours.current = false;
    leaveFullStage();
  }, []);

  return { on: on && available, full: full && on && available, enter, exit, toggle };
}
