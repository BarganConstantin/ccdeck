// Re-arrange's way back.
//
// R, and the canvas stack's Re-arrange button, throw away every pin, every
// stored position and the three stored keys, and write a new arrangement over
// them 80ms later. That used to be final: a hand-built board went with one
// stray press, and a reload could not bring it back. Clear asks before it acts,
// but R is pressed often enough that a question would slow down every
// deliberate use of it. So R keeps a copy of what it destroys instead, and the
// canvas offers it back for a few seconds: an Undo on the board, and ⌘Z or
// Ctrl+Z (use-deck-shortcuts.ts).
//
// The React that holds the window is use-board-layout.ts's and the strip is
// components/RearrangeUndo.tsx. What lives here is the part that can be held to
// a test without either: the copy and how it goes back, the window's clock, and
// the chord.
import type { StoredArrangement } from "./layout-storage";
import { isApplePlatform } from "./platform";

type Point = { x: number; y: number };
export type Viewport = { x: number; y: number; zoom: number };

/** The canvas's live arrangement, as use-board-layout.ts holds it. */
export interface Arrangement {
  positions: Map<string, Point>;
  pinned: Map<string, Point>;
  provisional: Set<string>;
  /** The signature the last layout pass ran under (canvas-flow.ts). */
  layoutSig: { current: string };
}

/** Everything R throws away, as it was the moment before. */
export interface RearrangeSnapshot {
  positions: Map<string, Point>;
  pinned: Map<string, Point>;
  provisional: Set<string>;
  layoutSig: string;
  /** The stored keys, byte for byte, so a reload after Undo restores what a
   *  reload before R would have. */
  stored: StoredArrangement;
  /** Where the pane was. R ends in a fit, and the board coming back to a view
   *  framed for a different board would put half of it off the screen. */
  viewport: Viewport | null;
}

const copyPoints = (from: Map<string, Point>) => new Map([...from].map(([id, at]) => [id, { x: at.x, y: at.y }]));

export function snapshotArrangement(live: Arrangement, stored: StoredArrangement, viewport: Viewport | null): RearrangeSnapshot {
  return {
    positions: copyPoints(live.positions),
    pinned: copyPoints(live.pinned),
    provisional: new Set(live.provisional),
    layoutSig: live.layoutSig.current,
    stored: { ...stored },
    viewport: viewport ? { ...viewport } : null,
  };
}

/**
 * Puts the copy back into the maps the canvas is drawn from, in place.
 *
 * In place because the board, the tool bursts and the drag handlers each hold
 * these maps and not a ref to them. The signature goes back too: with the
 * board's agents unchanged since R, the next render finds every card placed
 * under the signature it was settled under, and draws them where they were
 * rather than running a layout pass over them.
 */
export function restoreArrangement(snapshot: RearrangeSnapshot, live: Arrangement): void {
  live.positions.clear();
  for (const [id, at] of copyPoints(snapshot.positions)) live.positions.set(id, at);
  live.pinned.clear();
  for (const [id, at] of copyPoints(snapshot.pinned)) live.pinned.set(id, at);
  live.provisional.clear();
  for (const id of snapshot.provisional) live.provisional.add(id);
  live.layoutSig.current = snapshot.layoutSig;
}

/** How long the canvas offers the board back: long enough to notice the board
 *  moved and reach for the button, short enough that the offer is about the
 *  press that made it. */
export const REARRANGE_UNDO_MS = 7_000;
/** What is left at least, once a pointer or focus lets go of the strip: one that
 *  left it with a second to spare would see it vanish under the next glance. */
export const REARRANGE_UNDO_RESUME_MS = 2_000;
/** The strip's exit, which the presence hook keeps it mounted for. */
export const REARRANGE_UNDO_EXIT_MS = 140;

/** What the strip says, and what the live region says for it. */
export const REARRANGE_UNDO_TEXT = "Layout re-arranged";
export const REARRANGE_UNDO_SAID = "Layout re-arranged. Undo available.";
export const REARRANGE_RESTORED_SAID = "Layout restored.";

/** Why the clock is held: the pointer is on the strip, focus is in it, or the
 *  tab is not being looked at — an offer that ran out behind another window
 *  was never made. */
export type UndoHold = "hover" | "focus" | "hidden";

export interface UndoClock {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
}

const systemClock: UndoClock = {
  set: (run, ms) => setTimeout(run, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export interface UndoWindow<T> {
  /** Offers `snapshot`, from the start of the window. A second R while it is
   *  offered hands the same copy back, and the clock starts over. */
  open(snapshot: T): void;
  /** Hands the copy back and closes, or null when nothing is offered. */
  take(): T | null;
  /** Ends the offer: Escape, a drag, the clock. */
  close(): void;
  hold(why: UndoHold): void;
  release(why: UndoHold): void;
  readonly isOpen: boolean;
  readonly snapshot: T | null;
}

/**
 * The offer and its clock. The clock runs only while nothing holds it, so a
 * reader on their way to the button — or tabbed onto it — never has it taken
 * away mid-reach, and it picks up where it stopped when they let go.
 */
export function createUndoWindow<T>(onOpenChange: (open: boolean) => void, clock: UndoClock = systemClock): UndoWindow<T> {
  let kept: T | null = null;
  let timer: unknown = null;
  let endsAt = 0;
  let left = REARRANGE_UNDO_MS;
  const holds = new Set<UndoHold>();

  const stop = () => {
    if (timer !== null) clock.clear(timer);
    timer = null;
  };
  const run = () => {
    stop();
    if (kept === null || holds.size > 0) return;
    endsAt = clock.now() + left;
    timer = clock.set(() => { timer = null; close(); }, left);
  };
  // Holds go with the offer: a strip that unmounts under the pointer never
  // hears it leave, and a hold left behind would freeze the next offer's clock.
  function close() {
    stop();
    holds.clear();
    if (kept === null) return;
    kept = null;
    onOpenChange(false);
  }

  return {
    open(snapshot) {
      const opening = kept === null;
      kept = snapshot;
      left = REARRANGE_UNDO_MS;
      run();
      if (opening) onOpenChange(true);
    },
    take() {
      const snapshot = kept;
      close();
      return snapshot;
    },
    close,
    hold(why) {
      if (kept === null) return;
      if (holds.size === 0 && timer !== null) {
        left = Math.max(0, endsAt - clock.now());
        stop();
      }
      holds.add(why);
    },
    release(why) {
      if (!holds.delete(why) || holds.size > 0 || kept === null) return;
      left = Math.max(left, REARRANGE_UNDO_RESUME_MS);
      run();
    },
    get isOpen() { return kept !== null; },
    get snapshot() { return kept; },
  };
}

/** The modifiers a keystroke carries, structural so a test can pass an object. */
export interface UndoChordKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** ⌘Z on a Mac and Ctrl+Z elsewhere, and either on any of them, for the reason
 *  isSettingsChord counts both. With Shift it is redo, and Alt is someone
 *  else's. */
export function isUndoChord(e: UndoChordKey): boolean {
  return (e.key === "z" || e.key === "Z") && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
}

/** The chord as the keys in front of the reader spell it. */
export function undoChordLabel(platform: string): string {
  return isApplePlatform(platform) ? "⌘Z" : "Ctrl+Z";
}
