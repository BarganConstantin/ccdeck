// Adding a Codex account, or signing one in again, without a terminal.
//
// The same journey as Claude's Add account dialog, shorter because Codex has
// one way in: "Sign in with ChatGPT", which has the deck start
// `codex login --device-auth` for that account's own home (codex-login.mjs).
// Codex prints a link and a one-time code; the dialog shows both and watches
// until the sign-in lands. The deck never sees the login.
//
// OpenAI's page takes whichever account the browser is already signed in to, so
// the easiest way to add a second account is to add the first one again. As in
// Claude's dialog that is no failure: the sign-in is the account signing in again,
// so its stored login is replaced with this one, the row keeps its place, its name
// and its history, and the card says so. Who it landed on is only known once it
// has, so the sign-in runs in a home of its own and the server moves the login
// across. When it cannot (a login kept in the OS keyring, another disk) the row
// keeps the login it had and the dialog says nothing was added.
//
// Nothing starts until asked, and closing the dialog cancels a sign-in that is
// still waiting, so no process is left behind.
//
// The sign-in page opens by itself, as Claude's does (there `claude auth login`
// opens the browser; `codex login --device-auth` does not, and the browser that
// matters is this one, which may be on another machine). A browser allows a new
// tab only inside the press that asked for it, and the link arrives after a
// request, so the press opens an empty tab at once and the dialog sends it to
// the link when the link is known. A blocked tab leaves the button below it.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Confetti from "./Confetti";
import SuccessMark from "./SuccessMark";
import { copyText } from "../copy-text";
import { useT, type TFunction } from "../i18n";
import { celebrates, doneTitle } from "../signin-stages";
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";
import { prefersReducedMotion } from "../viewport-motion";

type Stage = "ready" | "starting" | "waiting" | "checking" | "done" | "repeat" | "failed";

interface LoginAnswer {
  ok: boolean;
  state?: "idle" | "starting" | "waiting" | "done" | "failed" | "cancelled" | "expired";
  url?: string | null;
  code?: string | null;
  expiresAt?: number | null;
  reason?: string | null;
}

/** Who a sign-in landed on, read off the roster after it landed. */
export interface SignedIn {
  account: string | null;
  /** The row already holding this account, when there is one. */
  repeats: { id: string; name: string } | null;
}

interface Props {
  /** Signing an account that exists in again; absent, a new one is made first. */
  profile?: { id: string; label: string; account?: string | null };
  /** Make an account. Resolves its id, or null when it was refused. */
  onCreate: () => Promise<string | null>;
  /** Copy the terminal command for an account, for a machine without Codex here. */
  onCopyCommand: (id: string) => void;
  /** A sign-in landed: the roster and the numbers are read again. */
  onSignedIn: (id: string) => Promise<SignedIn>;
  /** Give a row the login of the account made here, and take that one back.
   *  False when the login could not move: the row keeps the one it had. */
  onReplace: (id: string, into: string) => Promise<boolean>;
  /** Take back an account made here that repeats one already listed. */
  onDiscard: (id: string) => Promise<boolean>;
  onClose: () => void;
}

const POLL_MS = 1500;

/** A sentence with the account's name in bold, wherever its language puts it. */
function withName(template: string, name: string) {
  const [before, after = ""] = template.split("{name}");
  return <>{before}<strong>{name}</strong>{after}</>;
}

function reasonText(reason: string | null | undefined, t: TFunction): string {
  if (reason === "codex_missing") return t("codex.add.reason.missing");
  if (reason === "code_expired") return t("codex.add.reason.expired");
  if (reason === "no_code") return t("codex.add.reason.noCode");
  return t("codex.add.reason.other");
}

export default function AddCodexAccountDialog({ profile, onCreate, onCopyCommand, onSignedIn, onReplace, onDiscard, onClose }: Props) {
  const t = useT();
  const [stage, setStage] = useState<Stage>("ready");
  const [id, setId] = useState<string | null>(profile?.id ?? null);
  const [login, setLogin] = useState<LoginAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [clock, setClock] = useState(Date.now);
  const polling = useRef<ReturnType<typeof setInterval> | null>(null);
  /** The tab opened inside the press, until the sign-in link is known. */
  const tabRef = useRef<Window | null>(null);
  /** The sign-in page is open in a tab the dialog opened. */
  const [opened, setOpened] = useState(false);
  /** Who the sign-in landed on. */
  const [landed, setLanded] = useState<string | null>(null);
  /** The account the sign-in landed on already had a row: this one's name. */
  const [repeats, setRepeats] = useState<string | null>(null);
  /** It was an account here signing in again, so its stored login was replaced. */
  const [refreshed, setRefreshed] = useState(false);
  const markRef = useRef<SVGSVGElement | null>(null);
  const reduced = useState(prefersReducedMotion)[0];
  /** The poll can answer "done" again while the roster is being read. */
  const settling = useRef(false);
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const idRef = useRef(id);
  idRef.current = id;
  const primaryRef = useRef<HTMLButtonElement>(null);

  const stopPolling = useCallback(() => {
    if (polling.current) { clearInterval(polling.current); polling.current = null; }
  }, []);

  const close = useCallback(() => {
    stopPolling();
    try { if (tabRef.current && !tabRef.current.closed) tabRef.current.close(); } catch { /* gone */ }
    tabRef.current = null;
    // A sign-in still waiting is stopped, so closing leaves no process behind.
    if (["starting", "waiting"].includes(stageRef.current) && idRef.current) {
      void fetch("/api/codex-profile-login-cancel", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: idRef.current }),
      }).catch(() => {});
    }
    onClose();
  }, [onClose, stopPolling]);

  const dialogRef = useModalDismiss(close, { focusRef: primaryRef });
  const scrimPress = useScrimDismiss(close);

  useEffect(() => stopPolling, [stopPolling]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  // The step that held focus has gone, so it lands on what ends the dialog.
  useEffect(() => { if (stage === "done" || stage === "repeat") primaryRef.current?.focus(); }, [stage]);

  /** Open the tab inside the press. Returns nothing: a blocked tab is not an error. */
  function openTab() {
    closeTab();
    try {
      const tab = window.open("about:blank", "_blank");
      if (tab) { tab.opener = null; tabRef.current = tab; }
    } catch { /* blocked: the button still opens the page */ }
  }
  /** Drop the empty tab, when the sign-in never got as far as a link. */
  function closeTab() {
    try { if (tabRef.current && !tabRef.current.closed) tabRef.current.close(); } catch { /* gone */ }
    tabRef.current = null;
  }
  /** Send the tab to the link. The link is only ever an OpenAI page: the server
   *  returns nothing else (codex-login.mjs parseDeviceLogin). */
  function sendTab(url: string | null | undefined) {
    const tab = tabRef.current;
    tabRef.current = null;
    if (!tab || tab.closed || !url) { if (tab && !tab.closed) tab.close(); return; }
    try { tab.location.href = url; setOpened(true); } catch { /* the button still opens it */ }
  }

  function apply(answer: LoginAnswer) {
    setLogin(answer);
    if (answer.state === "waiting") sendTab(answer.url);
    else if (["failed", "expired", "cancelled", "done"].includes(answer.state ?? "")) closeTab();
    if (answer.state === "done") { stopPolling(); void settle(); }
    else if (["failed", "expired", "cancelled"].includes(answer.state ?? "")) { stopPolling(); setStage("failed"); }
    else if (answer.state === "waiting") setStage("waiting");
    else setStage("starting");
  }

  /** The sign-in landed: see who it landed on before calling it a new account. */
  async function settle() {
    const target = idRef.current;
    if (settling.current || !target) return;
    settling.current = true;
    setStage("checking");
    const signedIn = await onSignedIn(target).catch(() => null);
    const same = signedIn?.repeats ?? null;
    setLanded(same?.name ?? signedIn?.account ?? null);
    setRepeats(same?.name ?? null);
    if (profile) {
      // A row asked to sign in again stays: it is the person's own row, and the
      // done step says what it now repeats, or that it is the same account again.
      setRefreshed(!same && !!profile.account && signedIn?.account === profile.account);
      setStage("done");
    } else if (same) {
      const moved = await onReplace(target, same.id).catch(() => false);
      if (!moved) await onDiscard(target).catch(() => false);
      setId(null);
      setRefreshed(moved);
      setStage(moved ? "done" : "repeat");
    } else setStage("done");
    settling.current = false;
  }

  async function begin(profileId: string) {
    setError(null);
    setStage("starting");
    try {
      const response = await fetch("/api/codex-profile-login-start", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: profileId }),
      });
      const answer = await response.json() as LoginAnswer;
      if (!response.ok || !answer.ok) throw new Error(answer.reason ?? "login_failed");
      apply(answer);
    } catch (problem) {
      setLogin({ ok: false, state: "failed", reason: problem instanceof Error ? problem.message : "login_failed" });
      setStage("failed");
      return;
    }
    stopPolling();
    polling.current = setInterval(async () => {
      try {
        const response = await fetch(`/api/codex-profile-login-state?id=${encodeURIComponent(profileId)}`);
        if (response.ok) apply(await response.json() as LoginAnswer);
      } catch { /* the next tick asks again */ }
    }, POLL_MS);
  }

  async function submit() {
    if (busy) return;
    openTab();
    setBusy(true);
    setError(null);
    try {
      let target = id;
      if (!target) {
        target = await onCreate();
        if (!target) { setError(t("codex.add.createFailed")); return; }
        setId(target);
      }
      await begin(target);
    } finally { setBusy(false); }
  }

  const minutesLeft = login?.expiresAt ? Math.max(0, Math.ceil((login.expiresAt - clock) / 60_000)) : null;
  const title = profile ? t("codex.add.titleSignIn", { label: profile.label }) : t("codex.add.titleNew");

  return createPortal(
    <div className="modal-backdrop" {...scrimPress} role="presentation">
      <div ref={dialogRef} className="modal aa-modal" onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="aa-codex-title">
        <header className="modal-head">
          <div className="modal-title"><span id="aa-codex-title">{title}</span></div>
          <div className="modal-actions">
            <button type="button" className="glyph-btn" onClick={close} aria-label={t("codex.add.close")} title={t("codex.add.close")}>×</button>
          </div>
        </header>
        <section className="modal-body aa-body">
          {stage === "ready" && (
            <div className="aa-step aa-primer">
              <p className="aa-note">
                {profile ? t("codex.add.introExisting") : t("codex.add.introNew")}
              </p>
              {!profile && (
                <p className="aa-note">{t("codex.add.signOutFirst")}</p>
              )}
              {error && <p className="aa-err" role="alert">{error}</p>}
              <div className="aa-actions">
                <button ref={primaryRef} type="button" className="btn primary" aria-busy={busy}
                  onClick={() => void submit()}>{t("codex.add.signInButton")}</button>
              </div>
            </div>
          )}

          {stage === "starting" && (
            <div className="aa-step">
              <p className="aa-live-line" role="status">
                <svg className="aa-spin" viewBox="0 0 16 16" aria-hidden>
                  <circle className="aa-spin-track" cx="8" cy="8" r="6" />
                  <circle className="aa-spin-arc" cx="8" cy="8" r="6" />
                </svg>
                <span>{t("codex.add.starting")}</span>
              </p>
            </div>
          )}

          {stage === "waiting" && login && (
            <div className="aa-step">
              <p className="aa-note">
                <strong>1.</strong> {opened ? t("codex.add.step1Opened") : t("codex.add.step1")}
              </p>
              <a className="aa-link" href={login.url ?? "#"} target="_blank" rel="noreferrer noopener">
                <span>{opened ? t("codex.add.openAgain") : t("codex.add.openPage")}</span>
                <span className="aa-link-host">
                  auth.openai.com
                  <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor"
                    strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M3 7 7 3M3.6 3H7v3.4" />
                  </svg>
                </span>
              </a>
              <p className="aa-note"><strong>2.</strong> {t("codex.add.step2")}</p>
              <div className="aa-field">
                <code className="aa-device-code">{login.code}</code>
                <button type="button" className="btn" onClick={async () => { if (login.code && await copyText(login.code)) setCopied(true); }}>
                  {copied ? t("codex.add.copied") : t("codex.add.copy")}
                </button>
              </div>
              <p className="aa-live-line" role="status">
                <svg className="aa-spin" viewBox="0 0 16 16" aria-hidden>
                  <circle className="aa-spin-track" cx="8" cy="8" r="6" />
                  <circle className="aa-spin-arc" cx="8" cy="8" r="6" />
                </svg>
                <span>{minutesLeft !== null ? t("codex.add.waitingMinutes", { count: minutesLeft }) : t("codex.add.waiting")}</span>
              </p>
              <p className="aa-note">{t("codex.add.onlyIfYou")}</p>
            </div>
          )}

          {stage === "checking" && (
            <div className="aa-step">
              <p className="aa-live-line" role="status">
                <svg className="aa-spin" viewBox="0 0 16 16" aria-hidden>
                  <circle className="aa-spin-track" cx="8" cy="8" r="6" />
                  <circle className="aa-spin-arc" cx="8" cy="8" r="6" />
                </svg>
                <span>{t("codex.add.checking")}</span>
              </p>
            </div>
          )}

          {stage === "done" && (
            <div className="aa-done">
              <SuccessMark ref={markRef} />
              {celebrates({ added: !profile && !refreshed, reducedMotion: reduced }) && <Confetti anchor={markRef} />}
              <h4 role="status">{profile && !refreshed ? t("codex.add.signedIn") : doneTitle({ num: null, added: !refreshed }, t)}</h4>
              <p className="aa-note">
                {refreshed ? (
                  withName(t("codex.add.doneRefreshed"), landed ?? "")
                ) : profile ? (repeats
                  ? t("codex.add.doneSameAs", { name: repeats })
                  : t("codex.add.doneReady"))
                : (
                  withName(t("codex.add.doneNew"), landed ?? t("codex.add.theAccount"))
                )}
              </p>
              <div className="aa-actions"><button ref={primaryRef} type="button" className="btn primary" onClick={close}>{t("codex.add.done")}</button></div>
            </div>
          )}

          {stage === "repeat" && (
            <div className="aa-step">
              <h4 className="aa-repeat-title">{t("codex.add.repeatTitle")}</h4>
              <p className="aa-note">{withName(t("codex.add.repeatNote"), repeats ?? "")}</p>
              <p className="aa-note">{t("codex.add.repeatHelp")}</p>
              <div className="aa-actions">
                <button ref={primaryRef} type="button" className="btn primary" onClick={() => { setLogin(null); setOpened(false); setStage("ready"); }}>{t("codex.add.tryAnother")}</button>
                <button type="button" className="btn" onClick={close}>{t("codex.add.done")}</button>
              </div>
            </div>
          )}

          {stage === "failed" && (
            <div className="aa-step">
              <p className="aa-err" role="alert">{reasonText(login?.reason, t)}</p>
              {login?.reason === "codex_missing" && id && (
                <p className="aa-note">{t("codex.add.useTerminal")}</p>
              )}
              <div className="aa-actions">
                {id && <button type="button" className="btn primary" onClick={() => { openTab(); void begin(id); }}>{t("codex.add.tryAgain")}</button>}
                {id && <button type="button" className="btn" onClick={() => onCopyCommand(id)}>{t("codex.add.copyCommand")}</button>}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>,
    document.body,
  );
}
