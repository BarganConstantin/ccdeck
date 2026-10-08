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
import { createPortal } from "react-dom";
import Confetti from "./Confetti";
import SuccessMark from "./SuccessMark";
import SignInProgress, { type ProgressPhase } from "./SignInProgress";
import { exitRequest, loginEndNotice, loginTabView, restoreWarning, shouldPollLogin, type ActiveAccount, type LoginServerState } from "../login-flow";
import {
  approveHint, asSentence, celebrates, doneTitle, failedStage, handoffHold, HANDOFF_MS, importHint, liveStage,
  loginPollMs, stageAnnouncement, stageDetail, stageFailureTitle, stageRows, type SignInStage,
} from "../signin-stages";
import { prefersReducedMotion } from "../viewport-motion";
import { createLoginAnnouncer } from "../login-announce";
import { arrivalCheck, explainFailure } from "../admin-failure";
import { tabStripMove } from "../tablist-keys";
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";
import { selfPressAccepted, selfPressProps } from "../panel-press";
import { type ImportResult, importRowKey, importSummary, outcomeWord, replaceImportRow } from "../share-bundle";
import { useFeatureUse } from "../feature-use";

/** Server-side login progress, polled while the dialog is open. */
type LoginState = {
  state: LoginServerState;
  /** Where inside `registering` the server is: confirm, save or restore. */
  step?: string | null;
  url: string | null;
  error: string | null;
  account: { num: string | null; email: string; added: boolean } | null;
  expiresAt: number | null;
  /** Whether the account the user was working in went back in front after the
   *  sign-in moved the machine onto the new one, and — when it did not — which
   *  account the machine is actually signed in as. See restoreWarning (#951). */
  restored?: boolean;
  activeAccount?: ActiveAccount | null;
};

type Props = {
  onClose: () => void;
  /** Reload the roster — a new account only appears once the panel re-reads. */
  onChanged: () => void;
  /** Sign in again as this account (#1893): the address goes to `claude auth
   *  login --email`, which fills it in on the sign-in page. Absent, the dialog
   *  is the panel's ordinary + → Add. */
  email?: string | null;
  /** The sign-in finished and claude-swap recorded this account. Once per
   *  sign-in, on the success screen's arrival — not on Done. */
  onSignedIn?: (account: { num: string | null; email: string; added: boolean }) => void;
};

/** The sign-in page's host, for the link that reopens it: the reader sees
 *  where it goes without a 400-character address taking the dialog's width. */
function hostOf(url: string | null): string {
  try { return url ? new URL(url).host : ""; } catch { return ""; }
}

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

export default function AddAccountDialog({ onClose, onChanged, email = null, onSignedIn }: Props) {
  // Opened: one of the features the usage reports name (feature-use.ts).
  useFeatureUse("add-account");
  const [tab, setTab] = useState<TabId>("login");
  const [login, setLogin] = useState<LoginState | null>(null);
  const [code, setCode] = useState("");
  const [blob, setBlob] = useState("");
  // One error and one request in flight per journey (#1795). The two tabs
  // shared one of each, so a sign-in that failed to start printed its reason
  // under the paste field, and an import that cleared it left the Sign in tab
  // on "Asking the claude CLI…" with nothing polling to move it on. Each tab
  // shows only its own now; one request at a time is still the rule, and
  // busyRef below is its lock.
  const [loginBusy, setLoginBusy] = useState(false);
  const [pasteBusy, setPasteBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [pasteError, setPasteError] = useState<string | null>(null);
  // The lock's drawn half: a request is out, so a press on either submit is
  // refused and says aria-busy (#620), whichever tab it is on.
  const busy = loginBusy || pasteBusy;
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
  // both journeys, because one request is out at a time.
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
  // Which sign-in request is the current one. Cancel moves it on, so the answer
  // to a start or a code that was already out when Cancel was pressed lands on
  // nothing instead of dragging the dialog back into the sign-in it left.
  const attemptRef = useRef(0);
  // The stage the sign-in was last seen at while it was moving. The server
  // forgets a flow it lost ("idle") along with everything it knew about it, so
  // this is the only record of where the list should mark it as stopped.
  const lastLiveRef = useRef<SignInStage | null>(null);
  // Which face the Sign in tab last drew. The success card plays the handoff —
  // the ring closing into its tick — only after the list was on screen.
  const faceRef = useRef<"primer" | "progress" | "done">("primer");
  // Focus targets for the moments the control the reader was on goes away.
  const linkRef = useRef<HTMLAnchorElement | null>(null);
  const doneRef = useRef<HTMLButtonElement | null>(null);
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const refocusPrimerRef = useRef(false);
  // Read once: the dialog is open for a minute, and a preference flipped in
  // the middle of a sign-in is not worth a listener.
  const reduced = useState(prefersReducedMotion)[0];
  // The success the handoff has finished playing for, by the account it names.
  const [settledKey, setSettledKey] = useState<string | null>(null);
  // Whether the "Paste a code" disclosure is open. Closed to start with: on
  // the deck's own machine the CLI takes the code itself and the field is
  // noise; from another machine the page shows a code and this is one press.
  const [codeOpen, setCodeOpen] = useState(false);
  // A clock for the two hints that depend on how long something has taken,
  // running only while one of them could appear.
  const [now, setNow] = useState(() => Date.now());
  const [approveSince, setApproveSince] = useState<number | null>(null);
  const [importSince, setImportSince] = useState<number | null>(null);
  // What a Cancel found when it put the previous account back — only ever set
  // when it could not (restoreWarning), which a race with a sign-in finishing
  // in the browser at the same moment can produce.
  const [cancelNote, setCancelNote] = useState<string | null>(null);

  const close = useCallback(() => {
    // A live `claude auth login` on the server outlives this component, and an
    // abandoned one holds the next attempt hostage for five minutes. Cancelling
    // also puts the previous account back if the sign-in already completed.
    // Which exits send it is login-flow.ts's rule, so it can be driven and so
    // that every exit takes the same one — × and Done used to disagree on the
    // success screen (#1175).
    const req = exitRequest({ started: startedRef.current, state: login?.state });
    if (req) admin(req).catch(() => {});
    onClose();
  }, [onClose, login?.state]);

  // `close`, not `onClose`: Escape has to cancel the sign-in running on the
  // server, exactly as the × does.
  const dialogRef = useModalDismiss(close, { focusRef: primerRef });
  const scrimPress = useScrimDismiss(close);

  // Started by the button, never by arriving. `claude auth login` opens a
  // browser tab as its first act, and a dialog that does that before being
  // asked is a dialog nobody trusts to open again.
  const start = useCallback(async () => {
    if (!selfPressAccepted(busyRef.current)) return;
    const attempt = ++attemptRef.current;
    busyRef.current = true;
    setLoginBusy(true);
    setLoginError(null);
    setCancelNote(null);
    startedRef.current = true;
    // The address only when there is one: a bare `{action:"login"}` is still
    // the ordinary sign-in, with no flag appended (loginEmailArg).
    let out = await admin(email ? { action: "login", email } : { action: "login" }).catch(() => null);
    // An address the server will not put on a command line (loginEmailArg)
    // only loses the pre-filled field — the sign-in itself is still the one
    // asked for, so it starts without it rather than ending here.
    if (email && out?.reason === "bad_email" && attempt === attemptRef.current) {
      out = await admin({ action: "login" }).catch(() => null);
    }
    // Cancelled while the link was being asked for: Cancel already put the
    // dialog back and released the lock, and this answer is about a sign-in
    // the server has been told to drop.
    if (attempt !== attemptRef.current) return;
    busyRef.current = false;
    setLoginBusy(false);
    if (!out?.ok) { setLoginError(explainFailure(out, "could not start the sign-in")); return; }
    setLogin(out as LoginState);
  }, [email]);

  // Poll only while something is actually moving on the server — see
  // login-flow.ts for why "idle" ends the loop rather than continuing it, and
  // signin-stages.ts for why registering is asked about more often.
  useEffect(() => {
    if (!shouldPollLogin(login?.state)) return;
    const iv = window.setInterval(async () => {
      try {
        const res = await fetch("/api/claude-accounts/login");
        if (res.ok) setLogin(await res.json());
      } catch { /* the next tick tries again */ }
    }, loginPollMs(login?.state));
    return () => window.clearInterval(iv);
  }, [login]);

  /**
   * Stop the sign-in from inside the dialog and go back to the start of it.
   *
   * The same request every exit sends, asked of the same rule — exitRequest —
   * so this is not a second spelling of when a sign-in is cancelled. Offered
   * only while the sign-in is still waiting on the CLI or the browser: once
   * the browser has said yes, the account is being recorded, and a cancel then
   * would put the previous account back without unrecording this one.
   */
  const cancel = useCallback(async () => {
    const req = exitRequest({ started: startedRef.current, state: login?.state });
    attemptRef.current += 1;
    startedRef.current = false;
    busyRef.current = false;
    setLoginBusy(false);
    setLoginError(null);
    setLogin(null);
    setCode("");
    setCodeOpen(false);
    refocusPrimerRef.current = true;
    if (!req) return;
    const out = await admin(req).catch(() => null);
    setCancelNote(restoreWarning({ restored: out?.restored, activeAccount: out?.activeAccount }));
  }, [login?.state]);

  const retry = useCallback(() => {
    startedRef.current = false;
    setLogin(null);
    setLoginError(null);
    setCode("");
    setCodeOpen(false);
    start();
  }, [start]);

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
    if (announcer.shouldAnnounce(login?.state)) onChangedRef.current();
  }, [login?.state, announcer]);

  // The field takes focus when the disclosure that holds it opens, which is
  // the press that says a code is on its way.
  useEffect(() => {
    if (codeOpen) codeRef.current?.focus();
  }, [codeOpen]);

  // Who was signed in, told once per sign-in (#1893) — the prompt that opened
  // this dialog takes the account off its list the moment it arrives, rather
  // than a roster read later. A ref for the caller's function, for the reason
  // onChangedRef is one, and the account already told about by what it says
  // rather than by object, so a poll that lands on `done` again — a new object
  // for the same sign-in — does not tell twice.
  const onSignedInRef = useRef(onSignedIn);
  onSignedInRef.current = onSignedIn;
  const toldRef = useRef<string | null>(null);
  useEffect(() => {
    const account = login?.state === "done" ? login.account : null;
    const said = account ? `${account.num ?? ""}|${account.email}` : null;
    if (!account || toldRef.current === said) return;
    toldRef.current = said;
    onSignedInRef.current?.(account);
  }, [login]);

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
    const attempt = attemptRef.current;
    busyRef.current = true;
    setLoginBusy(true);
    setLoginError(null);
    const out = await admin({ action: "login-code", code }).catch(() => null);
    if (attempt !== attemptRef.current) return;
    busyRef.current = false;
    setLoginBusy(false);
    if (!out?.ok) {
      setLoginError(explainFailure(out, "the code was not accepted"));
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
    setPasteBusy(true);
    setPasteError(null);
    const out = await admin({ action: "import", blob }).catch(() => null);
    busyRef.current = false;
    setPasteBusy(false);
    if (!out?.ok) { setPasteError(explainFailure(out, "the import failed")); return; }
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
    const key = importRowKey(row);
    // The same guard the two submits above take, from the same helper: this
    // button is never disabled either, so a second press reaches the handler.
    if (!selfPressAccepted(busyRef.current)) return;
    // The bundle is gone once the result list is dismissed, and there is
    // nothing to narrow without it.
    if (!bundleRef.current) return;
    busyRef.current = true;
    // `pasteBusy` as well as the ref, so the rest of the dialog knows a request
    // is out. Without it, pressing "Import another" mid-update put the paste
    // form back with an Import button that looked idle, was not disabled, and
    // refused every press in silence because the ref said otherwise.
    setPasteBusy(true);
    setForcing(key);
    setRowError(null);
    const out = await admin({
      action: "import",
      blob: bundleRef.current,
      force: true,
      only: { email: row.email, org: row.org ?? "" },
    }).catch(() => null);
    busyRef.current = false;
    setPasteBusy(false);
    setForcing(null);
    if (!out?.ok) {
      setRowError({ key, text: explainFailure(out, "that account could not be updated") });
      return;
    }
    const fresh = ((out.results ?? []) as ImportResult[])[0];
    // Only into a list that is still on screen — see replaceImportRow.
    if (fresh) setImported(rows => replaceImportRow(rows, key, fresh));
    onChanged();
  }, [onChanged]);

  const done = login?.state === "done" ? login.account : null;
  // The success screen's qualification: the account was added, and the machine
  // did not go back to the one it was on. Null on every ordinary sign-in.
  const restoreNote = restoreWarning({ restored: login?.restored, activeAccount: login?.activeAccount });
  // Which branch the Sign in tab draws, from the sign-in's own state and never
  // the paste tab's — see loginTabView (#1795). "ended" is a sign-in over
  // without having succeeded: the server's own "failed", the "idle" it reports
  // once it no longer holds the flow at all, or a request of ours it refused.
  // All end the same way — no spinner, no poll, and a sentence that says which
  // happened.
  const view = loginTabView({ login, started: startedRef.current, loginError, loginBusy });
  const notice = loginEndNotice({ state: login?.state, serverError: login?.error, localError: loginError });

  // ── the stage list (signin-stages.ts) ─────────────────────────────────────
  // Where a sign-in that is still moving is, and where an ended one stopped.
  const live = view === "asking" || view === "code"
    ? liveStage({ state: login?.state, step: login?.step, starting: view === "asking" }) ?? "link"
    : null;
  const stoppedAt = view === "ended"
    ? failedStage({ state: login?.state, step: login?.step, url: login?.url, lastLive: lastLiveRef.current })
    : null;
  // The success arrives while the list is up: the list stays for HANDOFF_MS,
  // every row ticked, while the ring closes — then the card. Keyed by the
  // account so it plays once per sign-in, and skipped under reduced motion or
  // when the list was not what the reader was looking at.
  const doneKey = done ? `${done.num ?? ""}|${done.email}` : null;
  const holding = view === "done" && doneKey !== settledKey
    && handoffHold({ fromStages: faceRef.current === "progress", reducedMotion: reduced }) > 0;
  const face: "primer" | "progress" | "done" =
    view === "primer" ? "primer" : view === "done" && done && !holding ? "done" : "progress";
  const phase: ProgressPhase = stoppedAt ? "failed" : holding ? "resolving" : "live";
  const rows = stageRows(holding ? { done: true } : stoppedAt ? { failed: stoppedAt, state: login?.state } : { live });
  const failTitle = stoppedAt ? stageFailureTitle(stoppedAt, login?.state) : "";
  const failText = asSentence(notice.message);
  const hint = live === "approve" ? approveHint({ since: approveSince, now, expiresAt: login?.expiresAt }) : null;
  const slowImport = pasteBusy ? importHint({ since: importSince, now }) : null;

  // What a screen reader hears, said politely and only when it changes: once
  // per stage, once for the verdict, once for an import starting and ending.
  // Derived rather than pushed, so a poll that changed nothing says nothing.
  const said = tab === "login"
    ? face === "done" && done ? `${doneTitle(done)}.`
      : phase === "failed" ? `${failTitle}. ${failText}`
      : face === "progress" && !holding ? stageAnnouncement(live) ?? ""
      : ""
    : pasteBusy ? "Importing the share."
      : pasteError ? asSentence(pasteError)
      : imported ? asSentence(importSummary(imported))
      : "";

  useEffect(() => { if (live) lastLiveRef.current = live; }, [live]);
  useEffect(() => { faceRef.current = face; }, [face]);

  useEffect(() => {
    if (!holding || !doneKey) return;
    const t = window.setTimeout(() => setSettledKey(doneKey), HANDOFF_MS);
    return () => window.clearTimeout(t);
  }, [holding, doneKey]);

  // The clock behind the two "still going" hints. Started when one of them
  // could appear and stopped when neither can — nothing ticks while the dialog
  // is only waiting to be closed.
  const approving = live === "approve";
  useEffect(() => { setApproveSince(approving ? Date.now() : null); }, [approving]);
  useEffect(() => { setImportSince(pasteBusy ? Date.now() : null); }, [pasteBusy]);
  const ticking = approving || pasteBusy;
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const iv = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(iv);
  }, [ticking]);

  // Focus follows the verdict: Done when it worked, Try again when it did not,
  // the primer's button after Cancel. While the list is moving, focus is left
  // wherever the reader put it, with one exception: the primer's button goes
  // the moment it is pressed, and once the browser is up the link to the
  // sign-in page is the one thing on screen worth being on — pressing it again
  // opens the page again, which is harmless, where a Cancel there would turn a
  // second Enter into the end of the sign-in.
  useEffect(() => {
    if (tab !== "login") return;
    if (face === "done") { doneRef.current?.focus(); return; }
    if (face === "primer") {
      if (refocusPrimerRef.current) primerRef.current?.focus();
      refocusPrimerRef.current = false;
      return;
    }
    if (phase === "failed") { retryRef.current?.focus(); return; }
    const at = document.activeElement;
    if (live === "approve" && (!at || at === document.body)) linkRef.current?.focus();
  }, [tab, face, phase, live]);

  // Through a portal, like SectionHistoryModal, but for a different rule of the
  // panel it opens from. The accounts panel wipes open by animating its width,
  // and to keep its text still while it does, every direct child gets a fixed
  // 288px measure (`.accounts-panel > *`). This backdrop was a direct child, so
  // a `position: fixed; inset: 0` box came out 288px wide: a scrim over the
  // panel alone, and the dialog squeezed into it at the left edge instead of
  // centred on the screen. At <body>, no panel rule can reach it.
  return createPortal(
    <div className="modal-backdrop" {...scrimPress} role="presentation">
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
            // `&& done` and `&& login` only narrow the types: the face says
            // "done" exactly when they hold.
            face === "done" && done ? (
              // `from-orbit` when the list's ring closed into this mark: the
              // ring is already drawn, so only the tick draws (signin-stages.ts).
              <div className={`aa-done${settledKey === doneKey ? " from-orbit" : ""}`}>
                <SuccessMark ref={markRef} />
                {celebrates({ added: done.added, reducedMotion: reduced }) && <Confetti anchor={markRef} />}
                <h4>{doneTitle(done)}</h4>
                <p className="aa-note">
                  <strong>{done.email}</strong>
                  {done.added
                    // The second half of this sentence is a CLAIM about the
                    // machine, and it is only the deck's to make when the
                    // server says the switch back actually took (#951).
                    ? (restoreNote ? " is in the rotation." : " is in the rotation. The account you were using is still active.")
                    : " was already in the rotation, so its stored login was replaced with this one."}
                </p>
                {restoreNote ? <p className="aa-note aa-warn" role="status">{restoreNote}</p> : null}
                <button type="button" ref={doneRef} className="btn primary" onClick={close}>Done</button>
              </div>
            ) : face === "progress" ? (
              <SignInProgress
                rows={rows}
                phase={phase}
                detail={phase === "failed" ? (
                  <>
                    <p className="aa-note aa-reason">{failText}</p>
                    {/* Past the first stage a retry is the whole sign-in again,
                        browser and all, and the button says so. */}
                    <div className="aa-actions">
                      <button type="button" ref={retryRef} className="btn primary" onClick={retry}>
                        {stoppedAt === "link" ? "Try again" : "Start over"}
                      </button>
                    </div>
                  </>
                ) : live === "approve" && login ? (
                  <>
                    <p className="aa-note">
                      Approve the sign-in in the tab that opened{email ? <>, with <strong>{email}</strong> filled in</> : null}.
                      This moves on by itself.
                    </p>
                    {/* The page the CLI printed, in THIS browser — which is
                        the only way to reach it from a deck opened on another
                        machine, where the tab the CLI opened is on that
                        machine's screen. Named for that, and not "Open the
                        sign-in page" again one line under "Sign-in page
                        opened". */}
                    <a ref={linkRef} className="aa-link" href={login.url ?? "#"} target="_blank" rel="noreferrer noopener">
                      <span>Open it in this browser</span>
                      <span className="aa-link-host">
                        {hostOf(login.url)}
                        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor"
                          strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M3 7 7 3M3.6 3H7v3.4" />
                        </svg>
                      </span>
                    </a>
                    {hint ? <p className="aa-note aa-arrive">{hint}</p> : null}
                    {/* #708: this said "Paste the code it gives you", and on most
                        machines the page gives you none. `claude auth login`
                        listens on a loopback port as well as on stdin, so when
                        the browser can reach this machine the CLI takes the code
                        itself and the page just says you are all set. The paste
                        is the OTHER route — a deck opened from a different
                        machine, where loopback cannot be reached and the page
                        shows the code instead. Both are live at once and the CLI
                        says so itself: "Paste code here IF PROMPTED". So the
                        field waits behind a disclosure that names the case. */}
                    <details className="aa-code" open={codeOpen} onToggle={e => setCodeOpen(e.currentTarget.open)}>
                      <summary>
                        <svg className="aa-code-chev" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor"
                          strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M3.6 2.2 6.4 5 3.6 7.8" />
                        </svg>
                        Paste a code, if the page shows one
                      </summary>
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
                            other two halves stay `disabled`, because neither is a
                            press in flight: an empty field has nothing to submit,
                            and `registering` is the CLI having ACCEPTED the code. */}
                        <button type="button" className="btn primary"
                          {...selfPressProps(busy, !code.trim() || login.state === "registering")}
                          onClick={submitCode}>
                          Continue
                        </button>
                      </div>
                      {/* A rejected code leaves the flow in awaiting_code — which
                          is right, the CLI is still asking — so the reason is
                          printed here, under the field it is about. */}
                      {(loginError || login.error) && <p className="aa-err">{loginError ?? login.error}</p>}
                      <p className="aa-note">
                        The code goes straight to the claude CLI on this machine. It is never stored or sent anywhere else.
                      </p>
                    </details>
                  </>
                ) : live ? (
                  <p className="aa-note">{stageDetail(live, login?.step)}</p>
                ) : null}
                // Only while the sign-in is still waiting on the CLI or the
                // browser — see `cancel` for why not after.
                actions={live === "link" || live === "approve"
                  ? <button type="button" className="btn" onClick={cancel}>Cancel</button>
                  : null}
              />
            ) : (
              // The primer. Says what the button will do before it does it —
              // this one opens a browser tab, which is not something to spring
              // on someone who wanted the other tab.
              <div className="aa-step aa-primer">
                {cancelNote ? <p className="aa-note aa-warn" role="status">{cancelNote}</p> : null}
                <h4>{email ? <>Sign in again as <strong>{email}</strong></> : "Sign in to Anthropic"}</h4>
                <p className="aa-note">
                  Opens a browser tab where you approve the sign-in{email ? ", with this address already filled in" : ""}.
                  It normally completes by itself; only if the page hands you a code does it need pasting back here.
                  {email
                    ? " claude-swap replaces the expired login in place — the account keeps its slot, its alias and its history — and the account you are using now stays active."
                    : " claude-swap records the account when it completes, and the account you are using now stays active."}
                </p>
                <div className="aa-actions">
                  {/* No `disabled={busy}`: the press takes this control away
                      rather than disabling it, which is the half #518 answers
                      with rescueSelectors and not with a busy flag. No sign-in
                      request is out while this branch renders, but an import
                      from the other tab can be (#1795), and the lock refuses a
                      press until it is back — so it says aria-busy then, as
                      Continue and Import do (#620). */}
                  <button type="button" ref={primerRef} className="btn primary" {...selfPressProps(busy)} onClick={start}>
                    Open the sign-in page
                  </button>
                </div>
              </div>
            )
          ) : imported ? (() => {
            const arrived = imported.filter(r => r.state === "imported").length;
            const needsAttention = imported.some(r => arrivalCheck(r.check));
            return (
            <div className="aa-done">
              {!needsAttention && <SuccessMark ref={markRef} />}
              {/* Only when something actually arrived: celebrating a no-op is
                  how a celebration stops meaning anything. */}
              {arrived > 0 && !needsAttention && <Confetti anchor={markRef} />}
              {/* The count, not a verdict. "Done" over a paste of five is what
                  makes somebody run it again and then wonder whether they
                  doubled something; this is the sentence they need before they
                  trust the deck and close the tab. */}
              <h4>{importSummary(imported)}</h4>
              {imported.length > 0 && (
                <ul className="aa-results">
                  {imported.map(r => {
                    const key = importRowKey(r);
                    const check = arrivalCheck(r.check);
                    return (
                      <li key={key} className={`aa-result ${r.state}`}>
                        <span className="aa-result-who">{r.email || (r.num ? `slot ${r.num}` : "an account")}</span>
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
                        {/* It landed, and this Mac cannot use it yet — the
                            one thing "imported" alone would hide (#1244). */}
                        {check && <span className="aa-result-err">{check.long}</span>}
                        {rowError?.key === key && <span className="aa-result-err">{rowError.text}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
              {/* This used to end "no account already here was touched unless
                  you asked for it above", which the healed row on the same
                  screen contradicts: claude-swap replaces a slot it has itself
                  quarantined without being asked, and that is the point of it.
                  A reassurance a reader can see is false costs more than it
                  buys. */}
              <p className="aa-note">
                Nothing changed on the deck you copied this from. An account already here
                is left as it is, unless its stored login was dead or you pressed
                <strong> update anyway</strong>.
              </p>
              <div className="aa-actions">
                <button type="button" className="btn primary" onClick={close}>Done</button>
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
                  placeholder="ccdeck2:…"
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="Shared account"
                />
                {/* #620, the same as Continue: `busy` disabled the control the
                    press came from. An empty field still disables it — that is
                    an unavailability and not a press in flight — and the label
                    goes on saying which state it is in. */}
                <button type="button" className="btn primary" {...selfPressProps(busy, !blob.trim())} onClick={submitBlob}>
                  {pasteBusy ? "importing…" : "Import"}
                </button>
              </div>
              {pasteError && <p className="aa-err">{pasteError}</p>}
              {/* The import is one request and the server reports nothing
                  inside it, so this does not pretend to stages: one line that
                  turns while it is out, says who is doing the work, and after
                  ten seconds says how long it can take. */}
              {pasteBusy ? (
                <p className="aa-live-line">
                  <svg className="aa-spin" viewBox="0 0 16 16" aria-hidden>
                    <circle className="aa-spin-track" cx="8" cy="8" r="6" />
                    <circle className="aa-spin-arc" cx="8" cy="8" r="6" />
                  </svg>
                  <span>{slowImport ?? "claude-swap is adding the accounts in this share. Any already here are left as they are."}</span>
                </p>
              ) : null}
              <p className="aa-note">
                Use <strong>share</strong> on one account in the other deck, or <strong>↗</strong> above
                its list to send several at once. A share carries a live login for every account in it and
                expires ten minutes after it is made.
              </p>
            </div>
          )}
          {/* One polite voice for the whole panel, mounted for as long as the
              dialog is, because a live region that arrives with its own text is
              one most screen readers never read. */}
          <p className="vis-hidden" role="status" aria-live="polite">{said}</p>
        </section>
      </div>
    </div>,
    document.body,
  );
}
