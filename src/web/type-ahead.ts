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
// ONLY WHAT A PERSON TYPES INTO A PROMPT IS HELD: a character, Enter and
// Backspace, with no Ctrl, Cmd or Alt down (AltGr, which types characters, is
// not a chord), and nothing an input method is composing. Each goes to the
// program as xterm would have sent it, Backspace included, so a typo erased
// before the pane was ready is erased in the program, as in a terminal.
// Every other key goes where it always went: a chord can be a program's
// command, which only the pane knows how to send, and Tab is how the
// keyboard moves. Esc ends the hold, which is how a reader takes the keys back
// before the pane has them. What is held goes to the pane once the pane takes
// the keys; a stage that answers with a card instead drops it.
//
// In the first-load chunk, so plain functions and nothing heavy.

/** How long a hold waits for the pane before it lets keys through again. */
export const TYPE_AHEAD_MS = 10_000;
/** Held characters at most: a burst, not a paste. */
export const TYPE_AHEAD_MAX = 256;

export interface TypeAhead {
  /** What the pane will be handed, as xterm's onData would have given it. */
  text: string;
  /** When the hold lets keys through again. */
  until: number;
}

/** The parts of a keydown the hold reads; a real KeyboardEvent has them all. */
export interface HeldKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  getModifierState?(key: string): boolean;
}

export function startTypeAhead(now: number): TypeAhead {
  return { text: "", until: now + TYPE_AHEAD_MS };
}

/**
 * A keydown, against the hold: the hold with it, when it is a key the hold
 * keeps (the event is then the hold's, and goes nowhere else); "end" for Esc,
 * which ends the hold and goes on as usual; null for every other key, which
 * goes on as usual and leaves the hold as it was.
 */
export function holdKey(ahead: TypeAhead, e: HeldKeyEvent): TypeAhead | "end" | null {
  if (e.isComposing || e.keyCode === 229) return null;
  if (e.key === "Escape") return "end";
  const altGraph = e.getModifierState?.("AltGraph") === true;
  if (e.metaKey || (!altGraph && (e.ctrlKey || e.altKey))) return null;
  const add = e.key === "Enter" ? "\r" : e.key === "Backspace" ? "\x7f" : [...e.key].length === 1 ? e.key : null;
  if (add == null || [...ahead.text].length >= TYPE_AHEAD_MAX) return null;
  return { ...ahead, text: ahead.text + add };
}

/**
 * Is focus somewhere that takes typing itself — a field, an editor — where
 * the hold has no say? Not the pane's own textarea: a stage moving from one
 * session to the next keeps the focus in it, and what lands there before the
 * next session is live would be dropped.
 */
export function typesItself(el: Element | null | undefined): boolean {
  if (!el) return false;
  if (el.classList?.contains("xterm-helper-textarea")) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return (el as HTMLElement).isContentEditable === true;
}
