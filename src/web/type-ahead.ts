// The keys typed between a press that puts a session on the stage and the
// moment its pane can take them — a few hundred milliseconds on a quiet
// machine, a second under load — held, and handed to the pane once it can.
//
// A terminal loses no key typed right after it is chosen, and the stage must
// not either. Without this, the letters landed on the card that was clicked,
// or on the body once the board went inert under the stage: lost, or worse,
// read as the deck's own single-key shortcuts — j or k walking the stage to
// another session while the reader was writing to this one.
//
// WHAT IS HELD IS WHAT A PERSON TYPES INTO A PROMPT, as the pane would have
// sent it: a character (AltGr's, and on a Mac Option's, included), Enter,
// Shift+Enter, Backspace, and the Mac's line-editing chords the pane sends
// itself (terminal-keys.ts). Backspace goes to the program too, so a typo
// erased before the pane was ready is erased there, as in a terminal. A held
// Enter's auto-repeat adds nothing: a key held down on the Terminal button is
// not a stream of answers to whatever the session is asking.
//
// A KEY THE HOLD CANNOT SEND SPOILS IT. An arrow, Tab, Delete, a Ctrl chord
// or an input method's key goes where it always went, and the hold delivers
// nothing from then on: what it holds is no longer what was typed, and a line
// with a key missing from its middle, sent with its Enter, is an answer
// nobody gave. It still keeps the letters that follow from the deck's
// shortcuts until it ends. Esc and the release chord end it outright, which is
// how a reader takes the keys back before the pane has them. So does a burst
// longer than any prompt typed in a second, TYPE_AHEAD_MAX.
//
// In the first-load chunk, so plain functions and nothing heavy;
// terminal-keys.ts is already there for the deck's shortcuts.
import { isApplePlatform, platformName } from "./platform";
import { isReleaseChord, terminalKeyInput, terminalKeyOutcome } from "./terminal-keys";

/** How long a hold waits for the pane before it lets keys through again. */
export const TYPE_AHEAD_MS = 10_000;
/** Held characters at most: a burst, not a paste. */
export const TYPE_AHEAD_MAX = 256;

export interface TypeAhead {
  /** What the pane will be handed, as xterm's onData would have given it. */
  text: string;
  /** When the hold lets keys through again. */
  until: number;
  /** A key it could not send came between: it delivers nothing. */
  spoiled?: boolean;
}

/** The parts of a keydown the hold reads; a real KeyboardEvent has them all. */
export interface HeldKeyEvent {
  key: string;
  code?: string;
  ctrlKey: boolean;
  shiftKey?: boolean;
  metaKey: boolean;
  altKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  getModifierState?(key: string): boolean;
}

/** A keydown against the hold: the hold after it, and whether the event is
 *  the hold's (swallowed, so nothing else on the page hears it). */
export interface Held {
  ahead: TypeAhead;
  swallow: boolean;
}

/** Keys that are only held down with another, and a dead key, whose
 *  character arrives with the next keydown. */
const NOT_A_KEY: ReadonlySet<string> = new Set([
  "Shift", "Control", "Alt", "AltGraph", "Meta", "OS", "Super", "Hyper", "Fn", "FnLock", "CapsLock", "NumLock", "ScrollLock", "Dead",
]);

export function startTypeAhead(now: number): TypeAhead {
  return { text: "", until: now + TYPE_AHEAD_MS };
}

/** A live hold, as a card that answers its request sees it: keys typed into
 *  it already (or one it could not send), or none yet. */
export type HeldKeys = "typed" | "empty";

/** Which, for a hold. */
export function heldKeys(ahead: TypeAhead): HeldKeys {
  return ahead.text || ahead.spoiled ? "typed" : "empty";
}

/** What the hold gives for a delivery: nothing once it is spoiled. */
export function heldText(ahead: TypeAhead): string {
  return ahead.spoiled ? "" : ahead.text;
}

/**
 * A keydown, against the hold: "end" for Esc and the release chord, which end
 * it and go on as usual; null for a modifier on its own, which changes
 * nothing; else the hold after the key, and whether the key is the hold's.
 */
export function holdKey(ahead: TypeAhead, e: HeldKeyEvent, apple = isApplePlatform(platformName())): Held | "end" | null {
  if (NOT_A_KEY.has(e.key)) return null;
  if (e.key === "Escape") return "end";
  // Field by field: a KeyboardEvent's fields are getters on its prototype,
  // and a spread of one copies none of them.
  const chord = {
    key: e.key, code: e.code ?? "", ctrlKey: e.ctrlKey, shiftKey: e.shiftKey === true, metaKey: e.metaKey, altKey: e.altKey,
    repeat: e.repeat, isComposing: e.isComposing, keyCode: e.keyCode, getModifierState: e.getModifierState?.bind(e),
  };
  if (isReleaseChord(chord)) return "end";
  if (e.isComposing || e.keyCode === 229) return { ahead: { ...ahead, spoiled: true }, swallow: false };
  if (chord.repeat && chord.key === "Enter") return { ahead, swallow: true };
  const add = sent({ ...chord, type: "keydown" }, apple);
  // A lone ESC (Ctrl+3, which the pane sends as Esc) is an Esc, and
  // held, it would join the next key as one (use-terminal-session's type()):
  // Ctrl+3 then p arrived as Meta+P. Not one to deliver, then.
  if (add == null || add === "\x1b") return { ahead: { ...ahead, spoiled: true }, swallow: false };
  if ([...ahead.text].length + [...add].length > TYPE_AHEAD_MAX) return { ahead: { ...ahead, spoiled: true }, swallow: true };
  return { ahead: { ...ahead, text: ahead.text + add }, swallow: true };
}

/** What the pane would have sent for the key, when the hold can say. */
function sent(e: Parameters<typeof terminalKeyOutcome>[0] & HeldKeyEvent, apple: boolean): string | null {
  const outcome = terminalKeyOutcome(e, apple);
  if (outcome === "newline" || outcome === "send" || outcome === "meta") return terminalKeyInput(e, outcome, apple);
  if (outcome !== "pass") return null;
  const altGraph = e.getModifierState?.("AltGraph") === true;
  // Option types a character on a Mac (xterm's macOptionIsMeta stays off,
  // terminal-keys.ts says why); elsewhere Alt is a chord, unless it is AltGr.
  const typing = altGraph || (!e.ctrlKey && !e.metaKey && (!e.altKey || apple));
  if (!typing) return null;
  if (e.key === "Enter") return e.altKey || e.shiftKey ? null : "\r";
  if (e.key === "Backspace") return e.altKey ? null : "\x7f";
  return [...e.key].length === 1 ? e.key : null;
}

/**
 * Is focus somewhere that takes typing itself — a field, an editor — where
 * the hold has no say? Not the pane's own textarea: a stage moving from one
 * session to the next keeps the focus in it, and what lands there before the
 * next session is live would be dropped.
 */
export function typesItself(el: Element | null | undefined): boolean {
  if (!el) return false;
  if (isPaneInput(el)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return (el as HTMLElement).isContentEditable === true;
}

/** xterm's textarea, where the pane takes its keys. */
export function isPaneInput(el: Element | null | undefined): boolean {
  return el?.classList?.contains("xterm-helper-textarea") === true;
}
