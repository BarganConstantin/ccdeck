// The strip that offers a re-arranged board back, for a few seconds after R.
//
// The auto-fit chip's shape, beside it at the bottom of the canvas: a status in
// words that is not a control, and one action that is. What it offers and for
// how long is use-board-layout.ts's (rearrange-undo.ts holds the rules); this is
// the strip, the polite region that says it arrived, and the three things a
// transient control owes the keyboard — Escape through the shared dismiss
// stack, a clock that waits while focus is in it, and focus handed on when it
// goes from under the reader.
import { useEffect, useRef } from "react";

import { modalStack } from "../modal-dismiss";
import { isMounted, usePanelPresence } from "../panel-exit";
import { platformName } from "../platform";
import { REARRANGE_UNDO_EXIT_MS, REARRANGE_UNDO_TEXT, undoChordLabel } from "../rearrange-undo";
import type { useBoardLayout } from "../use-board-layout";

type RearrangeUndoState = ReturnType<typeof useBoardLayout>["rearrangeUndo"];

export default function RearrangeUndo({ undo }: { undo: RearrangeUndoState }) {
  const { open, said, undo: undoRearrange, dismiss, hold, release } = undo;
  const phase = usePanelPresence(open, REARRANGE_UNDO_EXIT_MS);
  const stripRef = useRef<HTMLDivElement>(null);

  // Escape's, while it is offered: a popover to the stack, so it answers the
  // key without covering the canvas the way a dialog does, and the letters
  // keep working beside it.
  useEffect(() => (open ? modalStack.push(dismiss, 0, "popover") : undefined), [open, dismiss]);

  // Gone from under focus — Undo pressed, Escape, the clock after a blur that
  // came back — focus goes to the canvas the strip sits on rather than falling
  // to the page, and the keys keep working from there.
  useEffect(() => {
    if (open) return;
    const strip = stripRef.current;
    if (strip && strip.contains(document.activeElement)) strip.closest<HTMLElement>("main")?.focus({ preventScroll: true });
  }, [open]);

  return (
    <>
      {/* Mounted whether or not anything is offered: words that arrive with
          their region are the ones screen readers drop (#1763). The strip
          below says nothing itself, so nothing is read twice. */}
      <div className="vis-hidden" role="status" aria-atomic="true">{said}</div>
      {isMounted(phase) && (
        <div
          ref={stripRef}
          className={phase === "leaving" ? "rearrange-undo leaving" : "rearrange-undo"}
          onPointerEnter={() => hold("hover")}
          onPointerLeave={() => release("hover")}
          onFocus={() => hold("focus")}
          onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) release("focus"); }}
        >
          <span id="rearrange-undo-state" className="rearrange-undo-state">{REARRANGE_UNDO_TEXT}</span>
          {/* Described by the status, so a reader who Tabs onto it hears what
              it would undo and not the word alone. One canvas, one strip, so
              the id is the page's only one. */}
          <button
            type="button"
            className="rearrange-undo-act"
            onClick={undoRearrange}
            aria-describedby="rearrange-undo-state"
            aria-keyshortcuts="Meta+Z Control+Z"
          >
            Undo
            <span className="rearrange-undo-key" aria-hidden="true">{undoChordLabel(platformName())}</span>
          </button>
        </div>
      )}
    </>
  );
}
