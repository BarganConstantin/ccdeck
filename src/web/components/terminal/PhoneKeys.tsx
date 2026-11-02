// The phone's key row: the six keys a fingertip cannot type on a screen
// keyboard, under the note at the foot of the Term takeover (640 and under;
// styles/stage-shell.css draws it only there).
//
// NOTHING NEW IS SENT. A key press goes up the pane's existing terminal input
// (use-terminal-session.ts `press`, the same `onInput` xterm's own keyboard
// reaches), as the bytes a terminal sends for that key. The row is always on
// screen, so the way out of a prompt (Esc, Ctrl+C) is never behind a keyboard;
// it is dimmed and inert while the pane cannot take keys.
import type { PointerEvent } from "react";

/** One key of the row: its cap, what a screen reader hears, and the bytes. */
export interface PhoneKey {
  id: string;
  cap: string;
  name: string;
  bytes: string;
}

/** Left to right, as the phone frame draws the row. */
export const PHONE_KEYS: readonly PhoneKey[] = [
  { id: "esc", cap: "Esc", name: "Escape", bytes: "\x1b" },
  { id: "tab", cap: "Tab", name: "Tab", bytes: "\t" },
  { id: "up", cap: "↑", name: "Up arrow", bytes: "\x1b[A" },
  { id: "down", cap: "↓", name: "Down arrow", bytes: "\x1b[B" },
  { id: "ctrl-c", cap: "Ctrl+C", name: "Control C", bytes: "\x03" },
  { id: "enter", cap: "⏎", name: "Enter", bytes: "\r" },
];

/** A press must not move the focus off the terminal: the screen keyboard that
 *  is up stays up, and the next letter typed still goes to the session. */
const keepFocus = (e: PointerEvent<HTMLButtonElement>) => e.preventDefault();

/** Whether the terminal held the focus when the press now under way began. The
 *  browser may take the focus off the terminal before the click lands (a
 *  pointerdown that is not cancelled), so it is read at the start of the press,
 *  at pointerdown and at the keydown of a keyboard press, and used after the
 *  key is sent. null: no start was seen (a click made by other means). One
 *  press at a time, so one value. */
let heldAtStart: boolean | null = null;

/** A press begins: note whether the terminal holds the focus. */
export function pressBegins(holdsFocus: (() => boolean) | undefined): void {
  heldAtStart = holdsFocus ? holdsFocus() : null;
}

/** A press ends: send the key with what was noted at its start. */
export function pressEnds(onKey: (bytes: string, held?: boolean) => void, bytes: string): void {
  const held = heldAtStart ?? undefined;
  heldAtStart = null;
  onKey(bytes, held);
}

export default function PhoneKeys({ canType, paneless = false, onKey, holdsFocus }: {
  /** The pane takes keys right now. */
  canType: boolean;
  /** No pane to type into (the keys bar is hidden too): hidden, not removed,
   *  because the stage measures the row by element. */
  paneless?: boolean;
  onKey(bytes: string, held?: boolean): void;
  /** Whether the terminal holds the focus now. */
  holdsFocus?(): boolean;
}) {
  return (
    <div className="ts-keyrow" role="group" aria-label="Terminal keys" hidden={paneless || undefined}>
      {PHONE_KEYS.map(key => (
        <button
          key={key.id}
          type="button"
          className="ts-key"
          data-key={key.id}
          aria-label={key.name}
          disabled={!canType}
          onPointerDown={e => { pressBegins(holdsFocus); keepFocus(e); }}
          onKeyDown={e => { if (e.key === "Enter" || e.key === " ") pressBegins(holdsFocus); }}
          onClick={() => pressEnds(onKey, key.bytes)}
        >
          {key.cap}
        </button>
      ))}
    </div>
  );
}
