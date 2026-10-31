// "Leave site?" while the terminal pane has the keys.
//
// In a browser tab Ctrl+W — readline's delete-a-word — closes the deck before
// the page sees it (tab-keys.ts). So while the pane has the keys, leaving asks
// first: the browser's own dialog, the confirmation Ghostty and iTerm give
// before closing on a running program. Nothing is lost by leaving (tmux keeps
// the session, and the stage comes back on reload), so it guards only the
// moment the keys are the pane's — a slip mid-word, not a choice. On a Mac
// too, where ⌘W is a choice: closing over a running program is what Ghostty
// and Terminal ask about there.
//
// Out of the stage's lazy chunk, because the deck's own reload has to say it
// is deliberate (leaveDeliberately), so an upgrade is never held at a dialog.
// Never inside the desktop app: Electron does not ask, it silently refuses to
// close a window whose page objects.
import { inDesktopApp } from "./in-app";

let deliberate = false;

/** The deck is about to leave the page by itself (a reload into a new
 *  bundle): no guard asks. For good — the page is going. */
export function leaveDeliberately(): void {
  deliberate = true;
}

/** What says the reader is back on the page after its dialog. */
const BACK = ["focus", "keydown", "pointerdown"] as const;
const CAPTURE = { capture: true };
/** How long after the event the page looks again. Neither browser runs the
 *  page's timers while its dialog is up — Chrome holds the page, Firefox
 *  suspends its timeouts — but Firefox puts its prompt up a beat after the
 *  event, and a timer due sooner ran in that beat, under a prompt not yet
 *  drawn (measured: ~100 ms, Firefox 155). Due later, it waits out the
 *  answer in both. */
const ASK_SETTLE_MS = 400;

/**
 * Ask before the page goes, until the returned function is called.
 * `onStayed` runs once the reader called the leave off, and never if they
 * went: ASK_SETTLE_MS after the event with the page focused, or at the
 * window's focus, a key or a press, whichever comes first. Inside the
 * desktop app, nothing.
 */
export function guardLeaving(onStayed?: () => void, ua?: string): () => void {
  if (typeof window === "undefined" || inDesktopApp(ua)) return () => {};
  let waiting: (() => void) | null = null;
  const ask = (e: BeforeUnloadEvent) => {
    if (deliberate) return;
    e.preventDefault();
    // The older spelling, still the one some browsers read.
    e.returnValue = "";
    if (!onStayed || waiting) return;
    const back = () => {
      waiting?.();
      onStayed();
    };
    const timer = setTimeout(() => { if (typeof document !== "undefined" && document.hasFocus?.()) back(); }, ASK_SETTLE_MS);
    for (const t of BACK) window.addEventListener(t, back, CAPTURE);
    waiting = () => {
      clearTimeout(timer);
      for (const t of BACK) window.removeEventListener(t, back, CAPTURE);
      waiting = null;
    };
  };
  window.addEventListener("beforeunload", ask);
  // A wait already under way is left to finish: the dialog itself takes the
  // focus, and with it the keys, so the guard is taken away mid-question.
  return () => window.removeEventListener("beforeunload", ask);
}
