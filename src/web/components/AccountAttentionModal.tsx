// An account the deck signed in has stopped working, and only its owner can
// bring it back (#1893).
//
// The accounts panel already marks such a row — "Login expired", with a sign-in
// beside it — but the panel is a place somebody goes, and the person this is for
// finds out by switching to the account and getting nothing. So the question
// comes to the front, the way a LAN pairing request does: one dialog for every
// account in that state, each with its own way back in.
//
// CALM, BECAUSE NOTHING IS LOST. The account keeps its slot, its alias and its
// history, and every other account keeps working; the dialog says that rather
// than painting an error. "Not now" is an answer, not a failure to answer — the
// row in the panel stays marked, and this incident is not asked about again.
// Escape, the backdrop and the × all mean the same "Not now".
import { useRef, type Ref } from "react";
import { useModalDismiss } from "./use-modal-dismiss";
import {
  attentionLead, attentionTitle, LATER_EXPLAINED, LOGIN_EXPIRED, SINGLE_NOTE, type AttentionRow,
} from "../reauth-attention";
import type { AccountAttention as Attention } from "../use-account-attention";
import AddAccountDialog from "./AddAccountDialog";

interface BodyProps {
  rows: AttentionRow[];
  onSignIn: (row: AttentionRow) => void;
  onLater: () => void;
  /** The first "Sign in again", which takes focus when the dialog opens: the
   *  press that is the point of the dialog, and one that only opens the
   *  sign-in dialog — nothing leaves the machine on it. */
  firstRef?: Ref<HTMLButtonElement>;
}

/** What the dialog says, for one account or several. Its own component so it
 *  can be drawn without the dialog's focus handling — see the 1893 test. */
export function AttentionBody({ rows, onSignIn, onLater, firstRef }: BodyProps) {
  const single = rows.length === 1 ? rows[0] : null;
  return (
    <section className="modal-body">
      {single ? (
        <>
          <p id="reauth-lead" className="reauth-lead">
            The Claude login for <strong className="reauth-name">{single.name}</strong>
            {single.alias ? <span className="reauth-alias"> ({single.alias})</span> : null}
            {" "}has expired and needs a new sign-in.
          </p>
          <p className="reauth-note">{SINGLE_NOTE}</p>
        </>
      ) : (
        <>
          <p id="reauth-lead" className="reauth-lead">{attentionLead(rows.length)}</p>
          <ul className="reauth-list">
            {rows.map((r, i) => (
              <li key={r.id} className="reauth-row">
                <span className="reauth-who" title={r.alias ? `${r.alias} — ${r.name}` : r.name}>
                  {r.name}
                  {r.alias ? <span className="reauth-alias"> {r.alias}</span> : null}
                </span>
                <span className="reauth-what">{LOGIN_EXPIRED}</span>
                <button type="button" className="btn" ref={i === 0 ? firstRef : undefined}
                  aria-label={`Sign in again as ${r.name}`} onClick={() => onSignIn(r)}>
                  Sign in again
                </button>
              </li>
            ))}
          </ul>
          <p className="reauth-note">Each keeps its slot, its alias and its history.</p>
        </>
      )}
      <div className="reauth-acts">
        <button type="button" className="btn" title={LATER_EXPLAINED} onClick={onLater}>Not now</button>
        {single && (
          <button type="button" className="btn primary" ref={firstRef} onClick={() => onSignIn(single)}>
            Sign in again
          </button>
        )}
      </div>
    </section>
  );
}

interface Props {
  rows: AttentionRow[];
  onSignIn: (row: AttentionRow) => void;
  onLater: () => void;
}

export default function AccountAttentionModal({ rows, onSignIn, onLater }: Props) {
  const firstRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDismiss(onLater, { focusRef: firstRef });
  return (
    <div className="modal-backdrop" onClick={onLater} role="presentation">
      <div
        ref={dialogRef}
        className="modal reauth-ask"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="reauth-title"
        aria-describedby="reauth-lead"
      >
        <header className="modal-head">
          <div className="modal-title">
            <span id="reauth-title" className="modal-tool-name">{attentionTitle(rows.length)}</span>
          </div>
          <div className="modal-actions">
            <button type="button" className="glyph-btn" onClick={onLater}
              aria-label="Not now (Esc)" title="Not now (Esc)">×</button>
          </div>
        </header>
        <AttentionBody rows={rows} onSignIn={onSignIn} onLater={onLater} firstRef={firstRef} />
      </div>
    </div>
  );
}

/**
 * What DeckDialogs mounts: the sign-in for the account somebody chose, or the
 * prompt itself while there is anything to ask — see use-account-attention.ts.
 *
 * ONE AT A TIME. The prompt steps aside while its sign-in is open rather than
 * standing behind it, and comes back with whoever is still left when that
 * closes; a successful sign-in has already taken its own account off the list
 * by then, and an empty list is no dialog.
 */
export function AccountAttention({ rows, signingIn, signIn, signedIn, refresh, closeSignIn, later }: Attention) {
  if (signingIn) {
    return (
      <AddAccountDialog
        email={signingIn.email || null}
        onClose={closeSignIn}
        onChanged={refresh}
        onSignedIn={signedIn}
      />
    );
  }
  if (!rows.length) return null;
  // Keyed by its shape: a list that falls to one account becomes the sentence
  // that names it, and a fresh mount puts focus on that one's button rather
  // than leaving it on a row that is gone.
  return <AccountAttentionModal key={rows.length === 1 ? "one" : "many"} rows={rows} onSignIn={signIn} onLater={later} />;
}
