// How long a closed dialog stays drawn so it can leave.
//
// A dialog mounted by `{open && <Dialog/>}` has no exit: the node is gone the
// next frame. V4's motion rules give a dialog one, Exit 150, and say that
// closing during the open, or reopening during the close, turns around from the
// current frame. So the owner keeps the LAST rendered dialog mounted, flagged
// as closing, for the length of its exit. This file is the decision, as pure
// functions with no renderer and no timer of their own, the way panel-exit.ts
// is; Dialog.tsx is the React that applies it.

/** Where a dialog is. `open` follows the owner's flag; `closing` is true only
 *  between the flag going false and the exit being over. */
export interface Presence {
  open: boolean;
  closing: boolean;
}

export function startPresence(open: boolean): Presence {
  return { open, closing: false };
}

export interface CloseContext {
  /** The last input was a key (input-modality.ts sets data-motion="instant"):
   *  "Opened by a key, or closed with Esc / a key: no motion at all". */
  instant: boolean;
  /** There is a rendered dialog to keep. A flag that was never true has none. */
  hasContent: boolean;
}

/** The presence after the owner's flag is `open`.
 *
 *  REOPENING MID-EXIT keeps the same node: `closing` is cleared, nothing is
 *  unmounted, and the CSS transition turns around from where it is rather than
 *  starting again from 0. Returns the same object when nothing changed, so a
 *  render-phase `if (next !== p) setP(next)` settles in one pass. */
export function settle(p: Presence, open: boolean, ctx: CloseContext): Presence {
  if (open) return p.open && !p.closing ? p : { open: true, closing: false };
  if (!p.open) return p;
  return { open: false, closing: ctx.hasContent && !ctx.instant };
}

/** The exit is over: unmount. */
export function finish(p: Presence): Presence {
  return p.closing ? { open: false, closing: false } : p;
}

/** Whether the dialog is in the DOM. */
export function isDrawn(p: Presence): boolean {
  return p.open || p.closing;
}

/** Whether a key, not a pointer, was the last input. Read at the moment a
 *  dialog closes. */
export function lastInputWasKey(root: { dataset?: { motion?: string } } | null | undefined): boolean {
  return root?.dataset?.motion === "instant";
}

/** A timer slightly longer than the transition it backs up, for the case where
 *  no transitionend comes (a hidden tab, a stylesheet that removed the motion). */
export const EXIT_SLACK_MS = 60;

/** Whether the dialog holds focus, the Tab trap, Escape and pointer input: not
 *  while it is leaving. The hook and the shell both ask this one question. */
export function holdsInput(closing: boolean): boolean {
  return !closing;
}
