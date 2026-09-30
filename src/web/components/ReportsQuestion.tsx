// The one time the deck asks whether it may send anonymous reports (#1853).
//
// Asked after the tour and the release notes, never over them, and only while
// the answer is "never asked". Both answers are one press and look alike: this
// is a question, not a funnel. Escape and the backdrop are "No thanks" — closing
// the question is not a yes — and No thanks takes focus, so a stray Enter lands
// on the answer that sends nothing.
//
// The two lists say exactly what reports.mjs sends and what it never can; a
// change there is a change here.
import { useRef } from "react";
import { useModalDismiss } from "./use-modal-dismiss";

interface Props {
  onAnswer: (on: boolean) => void;
}

export default function ReportsQuestion({ onAnswer }: Props) {
  const noRef = useRef<HTMLButtonElement>(null);
  const decline = () => onAnswer(false);
  const dialogRef = useModalDismiss(decline, { focusRef: noRef });

  return (
    <div className="modal-backdrop" onClick={decline} role="presentation">
      <div
        ref={dialogRef}
        className="modal reports-question"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="reports-question-title"
        aria-describedby="reports-question-lead"
      >
        <header className="modal-head">
          <div className="modal-title">
            <span id="reports-question-title" className="modal-tool-name">Help improve ccdeck?</span>
          </div>
        </header>
        <section className="modal-body">
          <p id="reports-question-lead" className="rq-lead">
            With your yes, this deck tells the people who make ccdeck when it is installed or updated, that it
            was used today, and about the errors it runs into.
          </p>
          <dl className="rq-plan">
            <dt>Sent</dt>
            <dd>
              <span>the ccdeck version, your system and whether it is the app or npm</span>
              <span>a random id made now, tied to nothing on this machine</span>
              <span>errors, with folders, addresses and keys taken out</span>
            </dd>
            <dt>Never</dt>
            <dd><span>your sessions, prompts, projects, files, or anything that names you</span></dd>
          </dl>
          <p className="rq-final">You can change this under Appearance at any time. Turning it off deletes what was sent.</p>
          <div className="rq-actions">
            <button type="button" ref={noRef} className="btn" onClick={decline}>No thanks</button>
            <button type="button" className="btn primary" onClick={() => onAnswer(true)}>Send reports</button>
          </div>
        </section>
      </div>
    </div>
  );
}
