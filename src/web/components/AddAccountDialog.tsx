// Adding an account without a terminal.
//
// Two ways in, because they are genuinely different journeys. Signing in is a
// conversation with Anthropic — a link, then a code that comes back through the
// browser. Pasting a shared account is a one-shot transfer from another deck.
//
// The sign-in half has a shape worth stating: `claude auth login` prints a URL
// and then BLOCKS on stdin waiting for the code, so a process stays alive on
// the server between the two steps here. That is why this is a dialog with
// state rather than a single form — and why closing it has to cancel, not just
// disappear.
//
// It blocks on stdin AND on a loopback port at the same time, and which of the
// two ends the sign-in is not up to the CLI — it is up to whether the browser
// that opened can reach this machine. On the deck's own machine it can, so the
// CLI takes the code itself and step 2 below is never used; from another
// machine it cannot, the page shows a code, and step 2 is the only way through.
// The copy on step 2 says so rather than demanding a paste that most sign-ins
// never produce (#708).
//
// And nothing starts until asked. This used to launch the sign-in the moment
// the dialog opened, which threw a browser tab at anyone who came here to paste
// a share — an irreversible side effect as the greeting. Opening a dialog is
// not consent to open a browser.
import React, { useCallback, useEffect, useRef, useState } from "react";
import Confetti from "./Confetti";
import { isLoginOver, loginEndNotice, shouldPollLogin, type LoginServerState } from "../login-flow";
import { createLoginAnnouncer } from "../login-announce";
import { explainFailure } from "../admin-failure";
import { tabStripMove } from "../tablist-keys";
import { useModalDismiss } from "./use-modal-dismiss";
import { selfPressAccepted, selfPressProps } from "../panel-press";
import { type ImportResult, importSummary, outcomeWord } from "../share-bundle";

/** Server-side login progress, polled while the dialog is open. */
type LoginState = {
  state: LoginServerState;
  url: string | null;
  error: string | null;
  account: { num: string | null; email: string; added: boolean } | null;
  expiresAt: number | null;
};

type Props = {
  onClose: () => void;
  /** Reload the roster — a new account only appears once the panel re-reads. */
  onChanged: () => void;
};

const POLL_MS = 1500;

/** The two journeys, in the order the strip draws them — which is the order
 *  the arrow keys walk, so the array is the widget's model and not decoration.
 *  `panel` is the one <section> both tabs swap, named here rather than spelled
 *  three times: each tab's aria-controls points at it and it points back at
 *  whichever tab is selected, which is the clause of role="tab" that this
 *  dialog used to leave empty. */
const TABS = [
  { id: "login", label: "Sign in" },
  { id: "paste", label: "Paste a share" },
] as const;
type TabId = (typeof TABS)[number]["id"];
const PANEL_ID = "aa-panel";
const tabDomId = (id: TabId) => `aa-tab-${id}`;

async function admin(body: Record<string, unknown>) {
  const res = await fetch("/api/claude-accounts/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => null);
}

/** The check mark, drawn rather than shown. 340ms, ease-out, once. */
const SuccessMark = React.forwardRef<SVGSVGElement>((_props, ref) => {
  return (
    <svg className="aa-mark" viewBox="0 0 44 44" aria-hidden ref={ref}>
      <circle className="aa-mark-ring" cx="22" cy="22" r="20" />
      <path className="aa-mark-tick" d="M13.5 22.5 L19.5 28.5 L31 17" />
    </svg>
  );
});
SuccessMark.displayName = "SuccessMark";

export default function AddAccountDialog({ onClose, onChanged }: Props) {
  const [tab, setTab] = useState<TabId>("login");
  const [login, setLogin] = useState<LoginState | null>(null);
  const [code, setCode] = useState("");
  const [blob, setBlob] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the import did, account by account. A share of one is a bundle of one,
  // so there is one shape here and not a singular case beside a plural one.
  const [imported, setImported] = useState<ImportResult[] | null>(null);
  // Which row has an "update anyway" in flight, and what refused one.
  const [forcing, setForcing] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ key: string; text: string } | null>(null);
  // The pasted bundle, held only while its result list is on screen: "update
  // anyway" sends the same text back, narrowed by the server to the one account
  // named. A ref and not state because it is the credential itself — nothing
  // re-renders from it and nothing may draw it.
  const bundleRef = useRef("");
  const startedRef = useRef(false);
  // The same fact as `busy`, readable without waiting for a render. Continue
  // and Import stay enabled while their own request is out (#620), so a second
  // Enter reaches the handler and the handler is what refuses it. One ref for
  // both, because there is one `busy` and the two submits are on tabs that
  // cannot be pressed at the same time.
  const busyRef = useRef(false);
  const codeRef = useRef<HTMLInputElement | null>(null);
  const blobRef = useRef<HTMLInputElement | null>(null);
  // The branch this dialog always opens on, and the only one that used to focus
  // nothing: the code field and the share field each take focus from an effect
  // of their own, and the other three branches are the ones nobody arrives on.
  const primerRef = useRef<HTMLButtonElement | null>(null);
  // The burst needs a point on screen to come from, and the mark is it.
  const markRef = useRef<SVGSVGElement | null>(null);
  // The strip is one tab stop, so the arrow keys have to put focus on the tab
  // they selected themselves — the browser will not, because the tab focus
  // moved off is about to become tabIndex={-1}.
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Whether the switch that is about to render came from an arrow key. Read
  // once, by the effect below — see it for why a tab widget has to know.
  const arrowedRef = useRef(false);

  const close = useCallback(() => {
    // A live `claude auth login` on the server outlives this component, and an
    // abandoned one holds the next attempt hostage for five minutes. Cancelling
    // also puts the previous account back if the sign-in already completed.
    if (startedRef.current) admin({ action: "login-cancel" }).catch(() => {});
    onClose();
  }, [onClose]);

  // `close`, not `onClose`: Escape has to cancel the sign-in running on the
  // server, exactly as the × does.
  const dialogRef = useModalDismiss(close, { focusRef: primerRef });

  // Started by the button, never by arriving. `claude auth login` opens a
  // browser tab as its first act, and a dialog that does that before being
  // asked is a dialog nobody trusts to open again.
  const start = useCallback(async () => {
    if (!selfPressAccepted(busyRef.current)) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    startedRef.current = true;
    const out = await admin({ action: "login" }).catch(() => null);
    busyRef.current = false;
    setBusy(false);
    if (!out?.ok) { setError(explainFailure(out, "could not start the sign-in")); return; }
    setLogin(out as LoginState);
  }, []);

  // Poll only while something is actually moving on the server — see
  // login-flow.ts for why "idle" ends the loop rather than continuing it.
  useEffect(() => {
    if (!shouldPollLogin(login?.state)) return;
    const iv = window.setInterval(async () => {
      try {
        const res = await fetch("/api/claude-accounts/login");
        if (res.ok) setLogin(await res.json());
      } catch { /* the next tick tries again */ }
    }, POLL_MS);
    return () => window.clearInterval(iv);
  }, [login]);

  // Both of these are read by the effect below and neither may appear in its
  // dependency list: AccountsPanel hands this dialog a new `onChanged` on every
  // render, so depending on it made the roster reload a function of rendering
  // rather than of the sign-in, and the success card kept the dialog mounted
  // long enough for that to become a permanent request loop — see
  // login-announce.ts for what each turn of it cost.
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  // A `useState` initialiser rather than `useRef(createLoginAnnouncer())`:
  // `useRef` runs its argument on every render and keeps only the first
  // announcer, so the rest were allocated and dropped (#612).
  const announcer = useState(createLoginAnnouncer)[0];

  useEffect(() => {
    if (login?.state === "awaiting_code") codeRef.current?.focus();
    if (announcer.shouldAnnounce(login?.state)) onChangedRef.current();
  }, [login?.state, announcer]);

  // The share tab's field is the only thing on it; focusing it saves a click
  // and makes ⌘V the obvious next move.
  //
  // Not after an arrow key, though, and that exception is the whole of the tab
  // widget's keyboard model meeting the one it was written before. Arrowing to
  // a tab must leave focus ON that tab: it is what "selected, 2 of 2" means,
  // it is what makes the next Left go back, and a strip that throws focus into
  // the panel on the first arrow is a strip the arrows can only be used on
  // once. A click is the opposite — the pointer user is already past the
  // choosing and the field is where they were going — so the pointer keeps the
  // shortcut and the keyboard gets the widget.
  useEffect(() => {
    if (tab === "paste" && !arrowedRef.current) blobRef.current?.focus();
    arrowedRef.current = false;
  }, [tab]);

  const onTabKeys = useCallback((e: React.KeyboardEvent<HTMLSpanElement>) => {
    const move = tabStripMove(e, TABS.findIndex(t => t.id === tab), TABS.length);
    if (move.kind === "pass") return;
    // Only now: an unclaimed Tab still has to leave the strip, and an unclaimed
    // Escape still has to reach the window listener that closes the dialog.
    e.preventDefault();
    arrowedRef.current = true;
    setTab(TABS[move.index].id);
    tabRefs.current[move.index]?.focus();
  }, [tab]);

  const submitCode = useCallback(async () => {
    if (!selfPressAccepted(busyRef.current)) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const out = await admin({ action: "login-code", code }).catch(() => null);
    busyRef.current = false;
    setBusy(false);
    if (!out?.ok) {
      setError(explainFailure(out, "the code was not accepted"));
      // A rejected code does not end the sign-in — the CLI is still asking, so
      // the field stays open with the bad value selected for retyping.
      if (out?.state) setLogin(out as LoginState);
      codeRef.current?.select();
      return;
    }
    setCode("");
    setLogin(out as LoginState);
  }, [code, login]);

  const submitBlob = useCallback(async () => {
    if (!selfPressAccepted(busyRef.current)) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const out = await admin({ action: "import", blob }).catch(() => null);
    busyRef.current = false;
    setBusy(false);
    if (!out?.ok) { setError(explainFailure(out, "the import failed")); return; }
    // The field is cleared so the text is not left sitting on screen, but the
    // bundle is kept out of sight until this result list is dismissed — see
    // bundleRef, and the "update anyway" that needs it.
    bundleRef.current = blob;
    setBlob("");
    setRowError(null);
    setImported((out.results ?? []) as ImportResult[]);
    onChanged();
  }, [blob, onChanged]);

  /**
   * Overwrite one account that was already here, because the user said so.
   *
   * The default import never does this: claude-swap leaves a healthy account
   * alone and heals only a slot it has itself quarantined as dead. That covers
   * the case a person would ask for, and misses one — a token that died on a
   * deck which never tried to use it, so no strike was ever recorded and the
   * import reads it as healthy and skips it. This is the way out of that, and
   * it names the account it rewrites, one at a time, rather than being a flag
   * over the whole paste.
   */
  const forceOne = useCallback(async (row: ImportResult) => {
    const key = `${row.email}|${row.org ?? ""}`;
    if (busyRef.current || !bundleRef.current) return;
    busyRef.current = true;
    setForcing(key);
    setRowError(null);
    const out = await admin({
      action: "import",
      blob: bundleRef.current,
      force: true,
      only: { email: row.email, org: row.org ?? "" },
    }).catch(() => null);
    busyRef.current = false;
    setForcing(null);
    if (!out?.ok) {
      setRowError({ key, text: explainFailure(out, "that account could not be updated") });
      return;
    }
    const fresh = ((out.results ?? []) as ImportResult[])[0];
    if (fresh) setImported(rows => (rows ?? []).map(r => (`${r.email}|${r.org ?? ""}` === key ? fresh : r)));
    onChanged();
  }, [onChanged]);

  const done = login?.state === "done" ? login.account : null;
  // A sign-in that is over without having succeeded: the server's own "failed",
  // or the "idle" it reports once it no longer holds the flow at all. Both end
  // the same way — no spinner, no poll, and a sentence that says which of the
  // two happened.
  const ended = isLoginOver(login?.state) || Boolean(error && startedRef.current && !busy);
  const notice = loginEndNotice({ state: login?.state, serverError: login?.error, localError: error });

  return (
    <div className="modal-backdrop" onClick={close} role="presentation">
      <div ref={dialogRef} className="modal aa-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Add a Claude account">
        <header className="modal-head">
          <div className="modal-title">
            {/* A real tablist, finally (#581). It announced one and delivered
                none of the three things the role promises: both buttons were
                ordinary tab stops so Tab walked INTO the strip and through it,
                the arrow keys the role tells a screen reader to use were heard
                by nothing, and neither tab claimed a panel — the body below was
                an unroled <section>. UsageHistoryModal met the same three
                unkept clauses on its range strip and deleted the role, which
                was right there and is wrong here: that strip controls no panel
                at all, only the same chart over a different range, while these
                two swap two genuinely different journeys through this dialog.
                So this one keeps the role and pays for it. The arrow rule is in
                tablist-keys.ts, out where it can be read without a DOM. */}
            <span className="aa-tabs" role="tablist" aria-label="How to add the account" onKeyDown={onTabKeys}>
              {TABS.map((t, i) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={tabDomId(t.id)}
                  ref={el => { tabRefs.current[i] = el; }}
                  aria-selected={tab === t.id}
                  aria-controls={PANEL_ID}
                  // The roving tab stop. One stop for the whole strip is half
                  // of what role="tab" means, and the focus trap in
                  // modal-dismiss.ts already skips a negative tabIndex, so Tab
                  // inside the dialog goes strip → panel and back without ever
                  // stopping on the tab that is not selected.
                  tabIndex={tab === t.id ? 0 : -1}
                  className={`aa-tab${tab === t.id ? " on" : ""}`}
                  onClick={() => { arrowedRef.current = false; setTab(t.id); }}
                >{t.label}</button>
              ))}
            </span>
          </div>
          <div className="modal-actions">
            <button type="button" className="glyph-btn" onClick={close} aria-label="Close (Esc)" title="Close (Esc)">×</button>
          </div>
        </header>

        {/* The panel the two tabs control. One node rather than two, because
            the body is swapped and not shown-and-hidden, so both tabs name this
            id and it names the selected tab back — which is how a screen reader
            gets from "selected, 2 of 2" to the thing that was selected.
            No tabIndex of its own: every branch it renders holds a control
            except the one-sentence "asking the CLI…" that is on screen for a
            second, and a permanent extra stop in front of the panel is a worse
            trade than that second. */}
        <section className="modal-body aa-body" id={PANEL_ID} role="tabpanel" aria-labelledby={tabDomId(tab)}>
          {tab === "login" ? (
            done ? (
              <div className="aa-done">
                <SuccessMark ref={markRef} />
                <Confetti anchor={markRef} />
                <h4>{done.added ? `Account ${done.num} added` : "Credentials refreshed"}</h4>
                <p className="aa-note">
                  <strong>{done.email}</strong>
                  {done.added
                    ? " is in the rotation. The account you were using is still active."
                    : " was already managed, so its stored credentials were replaced."}
                </p>
                <button type="button" className="btn primary" onClick={onClose}>Done</button>
              </div>
            ) : login?.state === "awaiting_code" || login?.state === "registering" ? (
              <>
                <div className="aa-step">
                  <h4>1 · Approve in the browser</h4>
                  <p className="aa-note">A tab should have opened. If not, use this link:</p>
                  <a className="aa-link" href={login.url ?? "#"} target="_blank" rel="noreferrer noopener">{login.url}</a>
                </div>
                <div className="aa-step">
                  {/* #708: this said "Paste the code it gives you", and on most
                      machines the page gives you none. `claude auth login`
                      listens on a loopback port as well as on stdin, so when
                      the browser can reach this machine the CLI takes the code
                      itself and the page just says you are all set. The paste
                      is the OTHER route — a deck opened from a different
                      machine, where loopback cannot be reached and the page
                      shows the code instead. Both are live at once and the CLI
                      says so itself: "Paste code here IF PROMPTED". */}
                  <h4>2 · Paste a code, if the page shows one</h4>
                  <p className="aa-note">
                    It usually finishes on its own — if the page says you are all set, there is nothing to do here.
                  </p>
                  <div className="aa-field">
                    <input
                      ref={codeRef}
                      type="text"
                      value={code}
                      onChange={e => setCode(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter" && code.trim() && !busy) submitCode(); }}
                      placeholder="paste the code here"
                      spellCheck={false}
                      autoComplete="off"
                      aria-label="Sign-in code"
                      disabled={login.state === "registering"}
                    />
                    {/* #620: `busy` reached `disabled` here — submitCode sets
                        it before its first await — so the press disabled the
                        control it came from and Chrome dropped focus. The
                        modal's Tab trap does bring focus back into the dialog,
                        but at `stops[0]`, not where the reader was.
                        The other two halves stay `disabled`, because neither
                        is a press in flight: an empty field has nothing to
                        submit, and `registering` is the CLI having ACCEPTED
                        the code — this button's work is over, and the field is
                        cleared by then anyway. */}
                    <button type="button" className="btn primary"
                      {...selfPressProps(busy, !code.trim() || login.state === "registering")}
                      onClick={submitCode}>
                      {login.state === "registering" ? "registering…" : "Continue"}
                    </button>
                  </div>
                  {/* A rejected code leaves the flow in awaiting_code — which is
                      right, the CLI is still asking — but that branch is above
                      the failure branch, so without this the message had
                      nowhere to render and the user retyped blind. */}
                  {(error || login.error) && <p className="aa-err">{error ?? login.error}</p>}
                  <p className="aa-note">
                    The code goes straight to the claude CLI on this machine. It is never stored or sent anywhere else.
                  </p>
                </div>
              </>
            ) : ended ? (
              <div className="aa-step">
                <h4>{notice.title}</h4>
                <p className="aa-err">{notice.message}</p>
                <button type="button" className="btn" onClick={() => { startedRef.current = false; setLogin(null); setError(null); start(); }}>
                  Try again
                </button>
              </div>
            ) : busy || startedRef.current ? (
              <div className="aa-step"><p className="aa-note">Asking the claude CLI for a sign-in link…</p></div>
            ) : (
              // The primer. Says what the button will do before it does it —
              // this one opens a browser tab, which is not something to spring
              // on someone who wanted the other tab.
              <div className="aa-step aa-primer">
                <h4>Sign in to Anthropic</h4>
                <p className="aa-note">
                  Opens a browser tab where you approve the sign-in. It normally completes by itself; only if the
                  page hands you a code does it need pasting back here.
                  claude-swap records the account when it completes, and the account you are using now stays active.
                </p>
                <div className="aa-actions">
                  {/* No `disabled={busy}`: this branch renders only while
                      `!busy && !startedRef.current`, so that attribute could
                      never be true and was the tenth `disabled=` a busy flag
                      reached — dead, but indistinguishable from the nine to
                      anyone reading the file or to the sweep that guards them.
                      The press takes this control away rather than disabling
                      it, which is the half #518 answers with rescueSelectors
                      and not with a busy flag. */}
                  <button type="button" ref={primerRef} className="btn primary" onClick={start}>
                    Open the sign-in page
                  </button>
                </div>
              </div>
            )
          ) : imported ? (() => {
            const arrived = imported.filter(r => r.state === "imported").length;
            return (
            <div className="aa-done">
              <SuccessMark ref={markRef} />
              {/* Only when something actually arrived: celebrating a no-op is
                  how a celebration stops meaning anything. */}
              {arrived > 0 && <Confetti anchor={markRef} />}
              {/* The count, not a verdict. "Done" over a paste of five is what
                  makes somebody run it again and then wonder whether they
                  doubled something; this is the sentence they need before they
                  trust the deck and close the tab. */}
              <h4>{importSummary(imported)}</h4>
              {imported.length > 0 && (
                <ul className="aa-results">
                  {imported.map(r => {
                    const key = `${r.email}|${r.org ?? ""}`;
                    return (
                      <li key={key} className={`aa-result ${r.state}`}>
                        <span className="aa-result-who">{r.email || `slot ${r.num}`}</span>
                        <span className="aa-result-what">{outcomeWord(r.state)}</span>
                        {/* The way out of the one case the default import
                            cannot see: a token that died on a deck which never
                            used it, so nothing quarantined the slot and the
                            import reads it as healthy. One account, named, and
                            never a flag over the whole paste. */}
                        {r.state === "present" && (
                          <button type="button" className="aa-result-fix" aria-busy={forcing === key}
                            title={`Overwrite the stored login for ${r.email} with the one in this share. `
                                 + "Do this when that account has stopped working here; if it works, leave it."}
                            onClick={() => forceOne(r)}>
                            {forcing === key ? "updating…" : "update anyway"}
                          </button>
                        )}
                        {rowError?.key === key && <span className="aa-result-err">{rowError.text}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="aa-note">
                Nothing changed on the deck you copied this from, and no account already
                here was touched unless you asked for it above.
              </p>
              <div className="aa-actions">
                <button type="button" className="btn primary" onClick={onClose}>Done</button>
                <button type="button" className="btn"
                  onClick={() => { bundleRef.current = ""; setRowError(null); setImported(null); }}>
                  Import another
                </button>
              </div>
            </div>
            );
          })() : (
            <div className="aa-step">
              <h4>Paste an account shared from another deck</h4>
              <div className="aa-field">
                <input
                  ref={blobRef}
                  type="text"
                  value={blob}
                  onChange={e => setBlob(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && blob.trim() && !busy) submitBlob(); }}
                  placeholder="ccdeck1:…"
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="Shared account"
                />
                {/* #620, the same as Continue: `busy` disabled the control the
                    press came from. An empty field still disables it — that is
                    an unavailability and not a press in flight — and the label
                    goes on saying which state it is in. */}
                <button type="button" className="btn primary" {...selfPressProps(busy, !blob.trim())} onClick={submitBlob}>
                  {busy ? "importing…" : "Import"}
                </button>
              </div>
              {error && <p className="aa-err">{error}</p>}
              <p className="aa-note">
                Use <strong>share</strong> on one account in the other deck, or <strong>↗</strong> above
                its list to send several at once. A share carries a live login for every account in it and
                expires ten minutes after it is made.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
