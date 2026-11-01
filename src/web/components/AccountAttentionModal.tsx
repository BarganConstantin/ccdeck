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
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";
import { modalStack } from "../modal-dismiss";
import {
  attentionLead, attentionTitle, laterExplainedText, loginExpiredText, promptShows, singleNoteText, type AttentionRow,
} from "../reauth-attention";
import { useT } from "../i18n";
import { tNodes } from "../accounts-rich";
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
  const t = useT();
  const single = rows.length === 1 ? rows[0] : null;
  return (
    <section className="modal-body">
      {single ? (
        <>
          <p id="reauth-lead" className="reauth-lead">
            {/* The sentence is the catalog's, with a non-breaking hyphen in
                "sign‑in": a line that ends on "sign-" reads as a word cut in
                half, in a sentence this short. */}
            {tNodes(t, "accounts.reauth.leadOne", {
              name: <><strong className="reauth-name">{single.name}</strong>
                {single.alias ? <span className="reauth-alias"> ({single.alias})</span> : null}</>,
            })}
          </p>
          <p className="reauth-note">{singleNoteText(t)}</p>
        </>
      ) : (
        <>
          <p id="reauth-lead" className="reauth-lead">{attentionLead(rows.length, t)}</p>
          <ul className="reauth-list">
            {rows.map((r, i) => (
              <li key={r.id} className="reauth-row">
                <span className="reauth-who" title={r.alias ? `${r.alias} — ${r.name}` : r.name}>
                  {r.name}
                  {r.alias ? <span className="reauth-alias"> {r.alias}</span> : null}
                </span>
                <span className="reauth-what">{loginExpiredText(t)}</span>
                <button type="button" className="btn" ref={i === 0 ? firstRef : undefined}
                  aria-label={t("accounts.reauth.againAs", { name: r.name })} onClick={() => onSignIn(r)}>
                  {t("accounts.reauth.again")}
                </button>
              </li>
            ))}
          </ul>
          <p className="reauth-note">{t("accounts.reauth.keeps")}</p>
        </>
      )}
      <div className="reauth-acts">
        <button type="button" className="btn" title={laterExplainedText(t)} onClick={onLater}>{t("accounts.reauth.later")}</button>
        {single && (
          <button type="button" className="btn primary" ref={firstRef} onClick={() => onSignIn(single)}>
            {t("accounts.reauth.again")}
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
  const t = useT();
  const firstRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDismiss(onLater, { focusRef: firstRef });
  const scrimPress = useScrimDismiss(onLater);
  return (
    <div className="modal-backdrop" {...scrimPress} role="presentation">
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
            <span id="reauth-title" className="modal-tool-name">{attentionTitle(rows.length, t)}</span>
          </div>
          <div className="modal-actions">
            <button type="button" className="glyph-btn" onClick={onLater}
              aria-label={t("accounts.reauth.laterEsc")} title={t("accounts.reauth.laterEsc")}>×</button>
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
 * by then, and an empty list is no dialog. And it waits for any other dialog to
 * close before it first appears — see promptShows. The stack is read on each
 * render, which the board's clock brings every quarter second.
 *
 * AND IT WAITS FOR A PAIRING REQUEST going up in the same render, which counts
 * as one more dialog (`pairing`). That request is not on the stack until after
 * the render that draws it, so when a dialog both were waiting on closed, they
 * came up together, this one over the request it is meant to follow.
 */
export function AccountAttention({ rows, signingIn, signIn, signedIn, refresh, closeSignIn, later, pairing = false }: Attention & {
  /** A pairing request is up, or goes up in this render — DeckDialogs. */
  pairing?: boolean;
}) {
  // Whether the prompt — or the sign-in it opened — was up last render.
  const oursRef = useRef(false);
  const dialogs = modalStack.dialogDepth() + (pairing ? 1 : 0);
  const shows = signingIn != null
    || promptShows({ rows: rows.length, ours: oursRef.current, dialogs });
  oursRef.current = shows;
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
  if (!shows) return null;
  // Keyed by its shape: a list that falls to one account becomes the sentence
  // that names it, and a fresh mount puts focus on that one's button rather
  // than leaving it on a row that is gone.
  return <AccountAttentionModal key={rows.length === 1 ? "one" : "many"} rows={rows} onSignIn={signIn} onLater={later} />;
}
