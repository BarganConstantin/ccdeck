// A guide is pictures, one at a time, with one line under each.
//
// WHY PICTURES. The deck explained itself in prose, and the two places a new
// reader most needed explaining were the two with the most of it: the welcome
// was a changelog for a release they had never used the one before, and Local
// network was a sentence in a panel and three dialogs of controls. Reported as
// "there is value here and it is not clear" — and "a lot of text is tiring".
// Every step is a drawing of the thing the reader is about to see, so the
// picture carries the idea and the line under it only names it.
//
// ONE LINE PER STEP, and it is a budget rather than a style: a caption past
// fourteen words is a paragraph again, and guide.test.ts counts them.
//
// NEXT TAKES FOCUS, not the ×. A guide is read forwards; a reader who opened
// it pressing Enter should be able to keep pressing Enter to the end. The ×
// and Escape still close it from any step, and the arrow keys move either way.
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useModalDismiss } from "./use-modal-dismiss";

export interface GuideStep {
  /** The drawing, which is the step. Decorative to a screen reader — the line
   *  under it says the same thing in words. */
  art: ReactNode;
  /** One sentence, fourteen words at most. */
  line: string;
  /** A second, quieter line — the one exception a step may need, never a
   *  second paragraph. */
  tip?: string;
}

interface Act { label: string; act: () => void }

export default function GuideModal({ title, steps, finish, aside, onClose }: {
  title: string;
  steps: GuideStep[];
  /** What the last step's primary button does. Absent, it says Done and closes. */
  finish?: Act;
  /** A quiet second way out, on the last step only. */
  aside?: Act;
  onClose: () => void;
}) {
  const nextRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDismiss(onClose, { focusRef: nextRef });
  const [at, setAt] = useState(0);
  const last = at === steps.length - 1;
  const step = steps[at];
  const go = (i: number) => setAt(Math.max(0, Math.min(steps.length - 1, i)));

  // The arrows, and nothing else: Escape belongs to the dismiss queue, and Tab
  // to its trap. Stopped here so no listener behind the dialog hears them.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    e.stopPropagation();
    go(e.key === "ArrowRight" ? at + 1 : at - 1);
  };

  const next = () => {
    if (!last) { go(at + 1); return; }
    if (finish) finish.act(); else onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div ref={dialogRef} className="modal guide" onClick={e => e.stopPropagation()}
        onKeyDown={onKey} role="dialog" aria-modal="true" aria-labelledby="guide-title">
        <header className="modal-head">
          <div className="modal-title">
            <span id="guide-title" className="modal-tool-name">{title}</span>
            <span className="modal-tool-id">{at + 1} / {steps.length}</span>
          </div>
          <div className="modal-actions">
            <button type="button" className="glyph-btn" onClick={onClose}
              aria-label="Close (Esc)" title="Close (Esc)">×</button>
          </div>
        </header>

        <section className="modal-body">
          {/* Keyed by the step so each drawing arrives on its own fade rather
              than being morphed out of the last one — and so its animation
              starts from the beginning every time somebody lands on it. */}
          <div className="guide-stage" key={at}>{step.art}</div>
          <p className="guide-line" aria-live="polite">{step.line}</p>
          {/* Always in the flow, empty or not: the dialog is one height on
              every step, so a reader stepping through it never has the
              buttons move under their pointer. */}
          <p className="guide-tip">{step.tip ?? ""}</p>
          <div className="guide-foot">
            <div className="guide-dots">
              {steps.map((_, i) => (
                <button key={i} type="button" className="glyph-btn guide-dot"
                  aria-label={`Step ${i + 1} of ${steps.length}`}
                  aria-current={i === at ? "step" : undefined}
                  onClick={() => go(i)} />
              ))}
            </div>
            {last && aside && (
              <button type="button" className="ap-lan-word guide-aside" onClick={aside.act}>
                {aside.label}
              </button>
            )}
            {at > 0 && (
              <button type="button" className="btn" onClick={() => go(at - 1)}>Back</button>
            )}
            <button ref={nextRef} type="button" className="btn primary" onClick={next}>
              {last ? (finish?.label ?? "Done") : "Next"}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
