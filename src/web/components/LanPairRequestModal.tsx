// The one moment in LAN sync that cannot wait behind a panel.
//
// A deck that dials this one without an invite stops there: the far machine is
// on the roster with a request in flight, and until somebody here says yes or
// no, nothing moves between them. The answer lived in the accounts panel, three
// panels and a scroll away from anybody who was not already looking at it —
// which is a question asked of a person who never hears it.
//
// So the question comes to the front. Everything else about LAN sync is still
// configuration and still belongs behind the setup door; this is the one thing
// that arrives on its own, and it is drawn the way the deck draws everything
// else that arrives on its own: one dialog, one sentence, two answers.
//
// WHAT THE ANSWERS COST, which is why the fingerprint is printed rather than
// hidden behind a tooltip. Accepting is not "allow a connection" — it is
// agreeing to hand this machine's logins to that one when its own expire. The
// name and the address both come from the far deck and both can be chosen; the
// fingerprint is the key it proved it holds, so it is the only line worth
// comparing against what the other person can see on their screen.
//
// Escape and the backdrop mean LATER, not no. A request answered by accident is
// a request that has to be made again on the other machine, so the key that
// gets pressed by reflex leaves it exactly where it was — in the panel, where
// the section has listed it all along.
import { useRef } from "react";
import { pressState } from "../panel-press";
import { useModalDismiss } from "./use-modal-dismiss";
import { askedLabel } from "./LanSyncSection";
import type { LanStranger } from "./LanSyncSection";

/** Which request to put in front of somebody, and how many are behind it.
 *
 *  Oldest first: the deck that has been waiting longest is the one whose owner
 *  is standing there wondering whether this is broken. One at a time, because
 *  a stack of these is a list, and a list is the thing the panel already is. */
export function nextRequest(
  pending: LanStranger[] | null | undefined,
  deferred: ReadonlySet<string>,
): { request: LanStranger | null; waiting: number } {
  const live = (pending ?? []).filter(p => p && typeof p.fp === "string" && !deferred.has(p.fp));
  if (!live.length) return { request: null, waiting: 0 };
  const ordered = [...live].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return { request: ordered[0], waiting: ordered.length - 1 };
}

interface Props {
  request: LanStranger;
  /** Requests behind this one. Counted, not listed — answering this one brings
   *  the next, and a dialog that enumerates a queue is the panel again. */
  waiting: number;
  /** Which answer is in flight, so the pressed one says so and its sibling
   *  cannot be pressed on top of it. */
  busy: "accept" | "dismiss" | null;
  now: number;
  onAccept: () => void;
  onDecline: () => void;
  /** Escape, the backdrop, the ×. The request stays where it was. */
  onLater: () => void;
}

export default function LanPairRequestModal({ request, waiting, busy, now, onAccept, onDecline, onLater }: Props) {
  // Decline takes focus, for the reason the clear prompt gives Cancel: a stray
  // Enter or Space has to land on the answer that shares nothing. Declining
  // costs the other person one more press; accepting by accident costs a login.
  const declineRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDismiss(onLater, { focusRef: declineRef });
  /** #518's rule, in a dialog rather than in the panel: the answer that was
   *  pressed stays enabled and says it is working — disabling it would drop
   *  focus to `<body>` and leave a keyboard user outside the dialog its own
   *  trap is holding — and the other answer goes inert meanwhile. */
  const accept = pressState(busy, "accept");
  const decline = pressState(busy, "dismiss");

  return (
    <div className="modal-backdrop" onClick={onLater} role="presentation">
      <div
        ref={dialogRef}
        className="modal lan-ask"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lan-ask-title"
      >
        <header className="modal-head">
          <div className="modal-title">
            <i className="ap-pulse" aria-hidden />
            <span id="lan-ask-title" className="modal-tool-name">A deck wants to pair</span>
          </div>
          <div className="modal-actions">
            <button type="button" className="glyph-btn" onClick={onLater}
              aria-label="Answer later (Esc)" title="Answer later (Esc)">×</button>
          </div>
        </header>

        <section className="modal-body">
          <p className="lan-ask-who">
            <strong className="lan-ask-name">{request.name}</strong>
            {" at "}<code className="ap-lan-code">{request.addr}</code>
            {" · asked "}{askedLabel(request.at, now)}
          </p>

          <p className="modal-note">
            Paired decks repair each other&apos;s expired logins. Accept only if you know this
            machine — what it shares is an account, not a screen.
          </p>

          {/* The one value worth comparing, printed rather than described. */}
          <p className="lan-ask-fp">
            Its fingerprint is <code className="ap-lan-code">{request.fp}</code> — it should match
            the one on their screen.
          </p>

          {waiting > 0 && (
            <p className="lan-ask-more">
              {waiting === 1 ? "One more deck is waiting behind this one." : `${waiting} more decks are waiting behind this one.`}
            </p>
          )}

          <div className="lan-ask-acts">
            <button type="button" ref={declineRef} className="btn"
              disabled={decline.disabled} aria-busy={decline.busy}
              onClick={onDecline}
              title="Nothing is shared. If that deck asks again, this comes back.">
              {busy === "dismiss" ? "declining…" : "Decline"}
            </button>
            <button type="button" className="btn primary"
              disabled={accept.disabled} aria-busy={accept.busy}
              onClick={onAccept}
              title="Talk to this deck from now on, and repair its expired logins with this deck's own.">
              {busy === "accept" ? "accepting…" : "Accept"}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
