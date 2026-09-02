// Move a set of accounts to another deck in one copy.
//
// The single-account `share` on a row is a different job and stays where it is:
// sending one account to a colleague. This is the other one — you are at work,
// your five accounts are at home, and you want one paste and a deck that has
// what the other one had. Doing that a row at a time is six steps of which step
// four is where somebody stops, leaving a half-configured deck that nothing on
// screen admits to.
//
// The picker opens with everything ticked, because moving the whole set is the
// case this exists for. What stops an accidental overshare is therefore not the
// effort of ticking but the count, which is stated in tokens and updates as you
// untick — see shareCountLine. The envelope holds each account's OAuth login in
// the clear, so five boxes is five live logins on the clipboard, and that is a
// fact the user should meet before the copy rather than after it.
import { useCallback, useEffect, useRef, useState } from "react";
import { explainFailure } from "../admin-failure";
import { PRODUCT } from "../brand";
import { useModalDismiss } from "./use-modal-dismiss";
import { type NamedAccount, pickerRows, shareCountLine, shareExpiry } from "../share-bundle";

/** One account the bundle could not carry, and why. */
interface Refused { num: string; email: string; detail?: string }

interface Bundle {
  blob: string;
  expiresAt: number;
  shared: { num: string; email: string }[];
  failed: Refused[];
}

type Props = {
  accounts: NamedAccount[];
  onClose: () => void;
  /** Put text on the clipboard. Passed in rather than reached for, because the
   *  panel already owns the fallback for browsers without the async API. */
  copyText: (text: string) => Promise<boolean>;
};

async function admin(body: Record<string, unknown>) {
  const res = await fetch("/api/claude-accounts/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => null);
}

const COPIED_MS = 1800;

export default function ShareAccountsDialog({ accounts, onClose, copyText }: Props) {
  const [picked, setPicked] = useState<number[]>(() => accounts.map(a => a.num));
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const busyRef = useRef(false);

  const dialogRef = useModalDismiss(onClose, { focusRef: primaryRef });

  // A second a tick, and only while a bundle is on screen. The countdown is the
  // focal point of that view — it is the difference between a paste that works
  // on the other machine and one that is refused — so it is not a number that
  // may sit half a minute out of date the way the panel's row can.
  useEffect(() => {
    if (!bundle) return;
    const t = window.setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(t);
  }, [bundle]);

  const rows = pickerRows(accounts);
  const toggle = (num: number) =>
    setPicked(p => (p.includes(num) ? p.filter(n => n !== num) : [...p, num]));

  const make = useCallback(async () => {
    if (busyRef.current || !picked.length) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setCopied(false);
    // Ask in the order the panel draws them, so the bundle's own list reads the
    // way the picker did.
    const order = accounts.map(a => a.num).filter(n => picked.includes(n));
    const out = await admin({ action: "share", accounts: order }).catch(() => null);
    busyRef.current = false;
    setBusy(false);
    if (!out?.ok) { setError(explainFailure(out, "the share could not be made")); return; }
    setBundle({
      blob: out.blob,
      expiresAt: out.expiresAt,
      shared: out.shared ?? [],
      failed: out.failed ?? [],
    });
  }, [accounts, picked]);

  const exp = bundle ? shareExpiry(bundle.expiresAt, nowSec) : null;
  const dead = exp?.tone === "gone";
  // What the bundle CARRIES, which is not what was ticked when an export
  // failed. Every count on this view reads off this number, so a bundle that
  // came up short can never present itself as the full set.
  const carried = bundle?.shared.length ?? 0;

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div ref={dialogRef} className="modal sa-modal" onClick={e => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label="Share accounts with another deck">
        <header className="modal-head">
          <div className="modal-title"><h3>Share accounts</h3></div>
          <div className="modal-actions">
            <button type="button" className="glyph-btn" onClick={onClose}
              aria-label="Close (Esc)" title="Close (Esc)">×</button>
          </div>
        </header>

        <section className="modal-body sa-body">
          {bundle ? (
            <div className="sa-step">
              {/* Once the countdown is out, "ready to paste" is the one thing
                  this text is not: the other deck refuses it. The heading is
                  the first thing read, so it is the first thing to stop
                  saying so. */}
              <h4>{dead
                ? "This share has expired"
                : carried === 1 ? "1 account, ready to paste" : `${carried} accounts, ready to paste`}</h4>
              <code className={`ap-share-blob${dead ? " sa-dead" : ""}`}>{bundle.blob}</code>
              <div className="ap-share-foot">
                {/* Past the expiry the import dialog on the other deck refuses
                    this text, so offering to copy it is offering a dead end.
                    That is the only thing the expiry does — see shareExpiry —
                    and it is a statement about the dialog, not about the copy. */}
                {/* #620: never `disabled={busy}`. A control that disables
                    itself on its own press drops focus to the document
                    body; nothing is in flight on this branch anyway. */}
                <button type="button" className="ap-manage-btn" ref={primaryRef}
                  onClick={async () => {
                    // "Make a new share" makes one, out of the same selection
                    // the user already made. Dropping them back on the picker
                    // would be a button that names an outcome and delivers a
                    // step towards it.
                    if (dead) { setBundle(null); void make(); return; }
                    if (await copyText(bundle.blob)) {
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), COPIED_MS);
                    }
                  }}>
                  {dead ? "make a new share" : copied ? "copied" : `copy ${carried === 1 ? "the share" : "all " + carried}`}
                </button>
                <span className="ap-manage-hint"
                  title={"This text is the sign-in for every account in it. It is base64 of plain JSON — the expiry inside it is not signed, so anyone holding a copy can change it, "
                       + "and the logins themselves are in there in the clear either way. The countdown only says how long another deck's import dialog will still accept it. "
                       + "If a copy escapes, sign those accounts out and back in."}>
                  <span className="ap-share-warn">
                    {carried === 1 ? "this is the password" : `this is ${carried} passwords`}
                  </span>
                  {" · "}
                  <span className={`ap-share-expiry ${exp?.tone}`}>{exp?.text}</span>
                </span>
              </div>

              {/* A bundle that came up short says so here, by name. Silently
                  handing over four accounts when five were ticked is the one
                  outcome this feature must not have: the user pastes, sees four
                  arrive, and has no way to know whether the fifth failed here
                  or over there. */}
              {bundle.failed.length > 0 && (
                <div className="sa-failed" role="alert">
                  <p className="sa-failed-head">
                    {bundle.failed.length === 1
                      ? "One account is not in this bundle:"
                      : `${bundle.failed.length} accounts are not in this bundle:`}
                  </p>
                  <ul className="sa-list">
                    {bundle.failed.map(f => {
                      // claude-swap's own reasons already name the account -
                      // "no backup credentials found for account 3
                      // (claude2@sapec.md)" - so printing the address above it
                      // says the same thing twice in three lines. The name line
                      // is for the reasons that do not carry one.
                      const named = Boolean(f.email && f.detail?.includes(f.email));
                      return (
                        <li key={`${f.num}-${f.email}`}>
                          {!named && <span className="sa-who">{f.email || `account ${f.num}`}</span>}
                          <span className="sa-why">{f.detail || "could not be exported"}</span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              <p className="sa-note">
                {dead ? (
                  <>
                    Another deck will refuse this text now. Make a new one — the same accounts
                    are still picked.
                  </>
                ) : (
                  <>
                    Paste it into the other deck with <strong>+</strong> → <strong>Paste a share</strong>.
                    Accounts it already holds are left exactly as they are.
                  </>
                )}
              </p>
              <div className="sa-actions">
                <button type="button" className="btn" onClick={() => { setBundle(null); setCopied(false); }}>
                  Pick again
                </button>
                <button type="button" className="btn primary" onClick={onClose}>Done</button>
              </div>
            </div>
          ) : (
            <div className="sa-step">
              <h4>Which accounts go to the other {PRODUCT}?</h4>
              <p className={`sa-count${picked.length ? "" : " empty"}`}>{shareCountLine(picked.length)}</p>
              <ul className="sa-list sa-pick">
                {rows.map(r => (
                  <li key={r.num}>
                    <label className="sa-row">
                      <input
                        type="checkbox"
                        checked={picked.includes(r.num)}
                        onChange={() => toggle(r.num)}
                      />
                      <span className="sa-who">{r.label}</span>
                      {r.sub && <span className="sa-sub">{r.sub}</span>}
                    </label>
                  </li>
                ))}
              </ul>
              {error && <p className="aa-err">{error}</p>}
              <div className="sa-actions">
                <button type="button" className="btn"
                  onClick={() => setPicked(picked.length === accounts.length ? [] : accounts.map(a => a.num))}>
                  {picked.length === accounts.length ? "Clear all" : "Select all"}
                </button>
                {/* Enabled while its own request is out, disabled only when
                    there is nothing to send — the same split every control in
                    the accounts surface makes between "somebody is working" and
                    "this is unavailable". */}
                <button type="button" className="btn primary" ref={primaryRef}
                  disabled={!picked.length} aria-busy={busy} onClick={make}>
                  {busy ? "making the share…" : picked.length === 1 ? "Share 1 account" : `Share ${picked.length} accounts`}
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
