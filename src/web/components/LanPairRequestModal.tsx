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
import { modalStack } from "../modal-dismiss";
import { pressState } from "../panel-press";
import { promptShows } from "../reauth-attention";
import { useModalDismiss } from "./use-modal-dismiss";
import { askedLabel } from "../lan-roster";
import type { LanStranger } from "../lan-types";
import type { useLanPairRequests } from "../use-lan-pair-requests";

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
        aria-describedby="lan-ask-who"
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
          {/* The dialog's description, because its title is the same sentence
              for every request: entering it has to say which deck is asking. */}
          <p id="lan-ask-who" className="lan-ask-who">
            <strong className="lan-ask-name">{request.name}</strong>
            {" at "}<code className="ap-lan-code">{request.addr}</code>
            {" · asked "}{askedLabel(request.at, now)}
          </p>

          <p className="modal-note">
            Paired decks repair each other&apos;s expired logins. Accept only if you know this
            machine — what it shares is an account, not a screen.
          </p>

          {/* The one value worth comparing, printed rather than described — and
              where the other machine prints its own (#815), because comparing
              with a screen nobody can find is not a check. */}
          <p className="lan-ask-fp">
            Its fingerprint is <code className="ap-lan-code">{request.fp}</code> — that machine
            shows its own under This deck on the network; the two should match.
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

/** What DeckDialogs mounts: the request to ask about now, if there is one and
 *  it is its turn — see pairRequestFor.
 *
 *  IT WAITS ITS TURN, by the rule the re-sign-in prompt waits by (promptShows).
 *  It arrives on a poll, whatever is open, and it is not portalled, while the
 *  panel's dialogs are — the network map, Busiest processes, a sign-in and its
 *  code — so it was drawn UNDER the one somebody was using, and its mount took
 *  the keyboard all the same: Escape meant for the map put the request off, and
 *  the Enter of somebody typing a sign-in code declined the other deck unseen.
 *  So it is drawn only while no other dialog is up, and once it is, it stays,
 *  answer after answer, whatever opens over it. The stack is read on each
 *  render, which the board's clock brings every quarter second. */
export function LanPairRequests(pairs: ReturnType<typeof useLanPairRequests>) {
  // Whether a request was up last render.
  const oursRef = useRef(false);
  const dialog = pairRequestFor(pairs);
  const shows = promptShows({ rows: dialog ? 1 : 0, ours: oursRef.current, dialogs: modalStack.dialogDepth() });
  oursRef.current = shows;
  return shows ? dialog : null;
}

/** The request to ask about now, if any — the oldest not put off this session,
 *  see nextRequest — with its answers wired to the hook that holds them
 *  (use-lan-pair-requests.ts). Moved out of App.tsx's markup, where it was an
 *  inline function.
 *
 *  Keyed by the request, so the next deck in the queue is a new dialog rather
 *  than this one filled in again. The answer to one request brings the next
 *  one with it, and without the key React kept the same dialog, with focus on
 *  whichever answer was just pressed. A fresh mount puts it on Decline, the
 *  way every request is first asked. */
export function pairRequestFor({ lanPending, lanDeferred, lanBusy, answerLanPair, deferLanPair }: ReturnType<typeof useLanPairRequests>) {
  const { request, waiting } = nextRequest(lanPending, lanDeferred.current);
  if (!request) return null;
  return (
    <LanPairRequestModal
      key={request.fp}
      request={request}
      waiting={waiting}
      busy={lanBusy}
      now={Date.now()}
      onAccept={() => void answerLanPair("accept", request.fp)}
      onDecline={() => void answerLanPair("dismiss", request.fp)}
      onLater={() => deferLanPair(request.fp)}
    />
  );
}
