// How big the terminal's text is: the pane's own zoom, apart from the page's.
//
// THE PAGE'S ZOOM WAS THE ONLY ONE. Ctrl and + over the pane made the whole
// deck bigger — the board, the header, the bar — because the stage drew its
// text at one fixed 13.3px and the browser's zoom was the only way to read it
// larger. A native terminal has its own: Windows Terminal, GNOME Terminal and
// Konsole take Ctrl and = / - / 0, Terminal.app and iTerm2 take ⌘. So does
// the pane now, while it has the keys, and the −/+ in its header does the same
// with the pointer (StageHeader.tsx).
//
// STEPS, AS THE BROWSER'S ZOOM HAS THEM. 100% is the 13.3px the stage has
// always drawn at, the size whose cells are whole pixels on DejaVu Sans Mono
// and Menlo (stage-geometry.ts); the other steps are Chrome's own between
// 67% and 200%, so a reader who knows the browser's −/+ knows these. Below
// two thirds the glyphs stop being readable, above twice the 80 columns a TUI
// needs no longer fit a laptop's screen.
//
// THE SAME KEYS, NOT THE SAME FAMILY. Shift with minus is Ctrl+_ — readline's
// undo, Claude Code's chat:undo — so zoom out is minus WITHOUT Shift; Ctrl+=
// and Ctrl++ (Shift on most layouts) both zoom in, and 0 goes back to 100%.
// Alt is never part of it. On a Mac only ⌘ zooms: Control there is the
// session's, as it is in Terminal.app.
//
// KEPT PER BROWSER, NOT PER ACCOUNT. How big a terminal's text should be is
// the screen's question — a laptop's 13" and a 32" monitor want different
// answers for the same person — so it is not one of the settings an account
// carries (account-ui-fields.ts). Another tab of the same deck follows a
// change through the browser's `storage` event.
import { useSyncExternalStore } from "react";
import { readStored, writeStored } from "./storage";
import { isApplePlatform, platformName } from "./platform";

export const TERM_TEXT_SIZE_KEY = "agent-dag.term-text-size";

/** The terminal's font size at 100%: the stage's 13.3px. */
export const BASE_FONT_SIZE = 13.3;

/** The steps, in percent of BASE_FONT_SIZE, as the browser's own zoom steps. */
export const TEXT_STEPS = [67, 75, 80, 90, 100, 110, 125, 150, 175, 200] as const;
export const DEFAULT_STEP = 100;

export type TextStepDirection = "larger" | "smaller" | "reset";

/** A stored or asked-for percent, as one of the steps: the nearest, or 100. */
export function resolveTextStep(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_STEP;
  let best: number = DEFAULT_STEP;
  for (const s of TEXT_STEPS) if (Math.abs(s - n) < Math.abs(best - n)) best = s;
  return best;
}

/** The step one press away, or the same one at either end. */
export function nextTextStep(current: number, direction: TextStepDirection): number {
  if (direction === "reset") return DEFAULT_STEP;
  const at = TEXT_STEPS.indexOf(resolveTextStep(current) as (typeof TEXT_STEPS)[number]);
  const to = direction === "larger" ? Math.min(TEXT_STEPS.length - 1, at + 1) : Math.max(0, at - 1);
  return TEXT_STEPS[to];
}

export const canGoLarger = (step: number) => resolveTextStep(step) < TEXT_STEPS[TEXT_STEPS.length - 1];
export const canGoSmaller = (step: number) => resolveTextStep(step) > TEXT_STEPS[0];

/** The pixel size xterm is given for a step. Not rounded: 13.3 is not either. */
export function fontSizeFor(step: number): number {
  return Math.round(BASE_FONT_SIZE * resolveTextStep(step)) / 100;
}

/** Which way a keystroke zooms the pane, or null when it is not a zoom key.
 *  `apple`: the keyboard's main modifier is ⌘ rather than Control. */
export function textSizeChord(
  e: { key: string; code?: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean },
  apple = isApplePlatform(platformName()),
): TextStepDirection | null {
  if (e.altKey) return null;
  if (apple ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return null;
  const key = String(e.key ?? "");
  if (key === "=" || key === "+" || e.code === "NumpadAdd") return "larger";
  // Shift with minus is Ctrl+_, the undo a TUI reads: the session's.
  if ((key === "-" || e.code === "NumpadSubtract") && !e.shiftKey) return "smaller";
  if ((key === "0" || e.code === "Digit0" || e.code === "Numpad0") && !e.shiftKey) return "reset";
  return null;
}

/** The three chords as the reader's keyboard labels them, for the control. */
export function textSizeKeysLabel(apple = isApplePlatform(platformName())): string {
  return apple ? "⌘+ · ⌘− · ⌘0" : "Ctrl++ · Ctrl+− · Ctrl+0";
}

// ── the one value, shared by every pane and tab ─────────────────────────────

const listeners = new Set<() => void>();
let cached: number | null = null;

export function terminalTextStep(): number {
  if (cached === null) cached = resolveTextStep(readStored(TERM_TEXT_SIZE_KEY));
  return cached;
}

export function setTerminalTextStep(step: number): void {
  const next = resolveTextStep(step);
  if (next === terminalTextStep()) return;
  cached = next;
  writeStored(TERM_TEXT_SIZE_KEY, String(next));
  for (const l of [...listeners]) l();
}

/** One press of −, + or reset, from the header or the keyboard. */
export function stepTerminalText(direction: TextStepDirection): void {
  setTerminalTextStep(nextTextStep(terminalTextStep(), direction));
}

function onStorage(e: StorageEvent) {
  if (e.key !== null && e.key !== TERM_TEXT_SIZE_KEY) return;
  cached = null;
  for (const l of [...listeners]) l();
}

export function subscribeTerminalText(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

/** The step the pane's text is at, kept current. */
export function useTerminalTextStep(): number {
  return useSyncExternalStore(subscribeTerminalText, terminalTextStep, () => DEFAULT_STEP);
}

/** For the suite: forget the value read, as a new page would. */
export function forgetTerminalTextStep(): void {
  cached = null;
}
