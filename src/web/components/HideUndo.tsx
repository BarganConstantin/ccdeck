// The notice that offers a hidden row back, for a few seconds after Hide from
// list: Re-arrange's undo strip (RearrangeUndo.tsx), with its look, its clock
// and its manners, at the foot of the Sessions list instead of the canvas.
//
// A status in words that is not a control and one action that is; the polite
// region that says it arrived, mounted before there is anything to say; Escape
// through the shared dismiss stack; a clock that waits while the pointer or
// focus is on it; and focus handed on when it goes from under the reader. What
// is offered and for how long is use-list-hidden.ts's.
import { useEffect, useRef } from "react";

import { modalStack } from "../modal-dismiss";
import { isMounted, usePanelPresence } from "../panel-exit";
import { REARRANGE_UNDO_EXIT_MS } from "../rearrange-undo";
import { useT } from "../i18n";
import type { ListHiddenOffer } from "../use-list-hidden";

export default function HideUndo({ offer }: { offer: ListHiddenOffer }) {
  const t = useT();
  const { open, name, undo, dismiss, hold, release } = offer;
  const phase = usePanelPresence(open, REARRANGE_UNDO_EXIT_MS);
  const stripRef = useRef<HTMLDivElement>(null);
  // The name it said, kept for its exit: the offer has ended by then.
  const shown = useRef(name);
  if (name) shown.current = name;

  // Escape's, while it is offered: a popover on the stack, so the letters keep
  // working beside it.
  useEffect(() => (open ? modalStack.push(dismiss, 0, "popover") : undefined), [open, dismiss]);

  // Gone from under focus (Escape): to the list's heading, the list it was
  // about, rather than to the page. Undo hands focus to the row it brought
  // back (SessionList.tsx), after this.
  useEffect(() => {
    if (open || typeof document === "undefined") return;
    const strip = stripRef.current;
    if (strip && strip.contains(document.activeElement)) {
      strip.closest(".session-list")?.querySelector<HTMLElement>(".sl-header h2")?.focus({ preventScroll: true });
    }
  }, [open]);

  return (
    <>
      {/* Mounted whether or not anything is offered: words that arrive with
          their region are the ones screen readers drop (#1763). */}
      <div className="vis-hidden" role="status" aria-atomic="true">{open ? t("board.list.hiddenSaid", { name }) : ""}</div>
      {isMounted(phase) && (
        <div
          ref={stripRef}
          className={phase === "leaving" ? "rearrange-undo sl-undo leaving" : "rearrange-undo sl-undo"}
          onPointerEnter={() => hold("hover")}
          onPointerLeave={() => release("hover")}
          onFocus={() => hold("focus")}
          onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) release("focus"); }}
        >
          <span id="sl-undo-state" className="rearrange-undo-state">{t("board.list.hiddenRow", { name: shown.current })}</span>
          {/* Described by the status, so a reader who Tabs onto it hears what
              it would undo. One list, one notice, so the id is the page's only one. */}
          <button type="button" className="rearrange-undo-act" onClick={undo} aria-describedby="sl-undo-state">
            {t("board.rearrange.undo")}
          </button>
        </div>
      )}
    </>
  );
}
