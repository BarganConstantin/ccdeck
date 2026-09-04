// The prompt in front of the deck's one irreversible action. Clear does not
// tidy a view: it empties the server's ring buffer and, when this deck is the
// one writing it, truncates events.jsonl — the log a restarted deck replays to
// rebuild everything on the canvas. The wording says so, because "Clear canvas"
// reads like something a refresh would undo and nothing here does.
//
// Every word of that wording comes from clearCopy in ../clear-confirm, driven by
// what `GET /api/clear` says this press would actually destroy. It used to be a
// sentence built here from the agent count alone, promising to delete one
// server's event log in a product that runs several decks over ONE log file —
// so the deck scoped to a single tree was quietly speaking for the machine-wide
// deck's whole history (#698). A component is also the wrong place for a rule a
// bare-node test has to be able to call.
//
// Escape and a backdrop click cancel, through the same useModalDismiss every
// other modal uses. Cancel takes focus on mount so a stray Enter or Space —
// and the "c" that opened this, since ownsKeystroke() leaves the keys of a
// focused button alone — lands on the harmless answer. CONFIRM_LAYER is what
// keeps that Escape here: this is rendered last so it paints over a session
// summary that pops in from a Stop hook while the user is still deciding, and
// the prompt on top must be the one the key closes.
import { useEffect, useRef, useState } from "react";
import { CONFIRM_LAYER } from "../modal-dismiss";
import { clearCopy, readClearPlan, type ClearPlan } from "../clear-confirm";
import { useModalDismiss } from "./use-modal-dismiss";

interface Props {
  /** Agents on the canvas right now: the visible half of what goes away. */
  agentCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ClearConfirm({ agentCount, onConfirm, onCancel }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDismiss(onCancel, { focusRef: cancelRef, layer: CONFIRM_LAYER });

  // The other half of what goes away, and the half this dialog used to get
  // wrong: whose log is on the line. Asked as the dialog opens rather than kept
  // on a timer — a deck starting or stopping changes the answer, and this is the
  // one moment it matters. Until it lands (a loopback request, so a frame or
  // two) clearCopy says the cautious thing; a deck too old to answer the route,
  // or a request that fails, keeps saying it. See clear-confirm.ts.
  const [plan, setPlan] = useState<ClearPlan | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/clear")
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled) setPlan(readClearPlan(d)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const { note, confirm } = clearCopy(agentCount, plan);

  return (
    <div className="modal-backdrop" onClick={onCancel} role="presentation">
      <div
        ref={dialogRef}
        className="modal clear-confirm"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="clear-confirm-title"
      >
        <header className="modal-head">
          <div className="modal-title">
            <span className="status-dot err" aria-hidden />
            <span id="clear-confirm-title" className="modal-tool-name">Clear the deck?</span>
          </div>
          <div className="modal-actions">
            <button type="button" className="glyph-btn" onClick={onCancel} aria-label="Cancel (Esc)" title="Cancel (Esc)">×</button>
          </div>
        </header>

        <section className="modal-body">
          <p className="modal-note">{note}</p>
          <div className="cc-actions">
            <button type="button" ref={cancelRef} className="btn" onClick={onCancel}>Cancel</button>
            <button type="button" className="btn danger" onClick={onConfirm}>{confirm}</button>
          </div>
        </section>
      </div>
    </div>
  );
}
