// Adding a Codex account, or signing one in again, without a terminal.
//
// The same journey as Claude's Add account dialog, shorter because Codex has
// one way in: "Sign in with ChatGPT", which has the deck start
// `codex login --device-auth` for that account's own home (codex-login.mjs).
// Codex prints a link and a one-time code; the dialog shows both and watches
// until the sign-in lands. The deck never sees the login.
//
// OpenAI's page takes whichever account the browser is already signed in to, so
// the easiest way to fail at adding a second account is to add the first one
// again. That is checked when the sign-in lands: Claude's dialog replaces the
// stored login of an account it already holds, and this one drops the repeat, so
// either way there is one row per account, and it says what happened and why.
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
import SuccessMark from "./SuccessMark";
import { copyText } from "../copy-text";
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";

type Stage = "ready" | "starting" | "waiting" | "checking" | "done" | "repeat" | "failed";

interface LoginAnswer {
  ok: boolean;
  state?: "idle" | "starting" | "waiting" | "done" | "failed" | "cancelled" | "expired";
  url?: string | null;
  code?: string | null;
  expiresAt?: number | null;
  reason?: string | null;
}

interface Props {
  /** Signing an account that exists in again; absent, a new one is made first. */
  profile?: { id: string; label: string };
  /** Make an account. Resolves its id, or null when it was refused. */
  onCreate: () => Promise<string | null>;
  /** Copy the terminal command for an account, for a machine without Codex here. */
  onCopyCommand: (id: string) => void;
  /** A sign-in landed: the roster and the numbers are read again. Resolves the
   *  name of the account this one turned out to repeat, or null. */
  onSignedIn: (id: string) => Promise<string | null>;
  /** Take back an account made here that repeats one already listed. */
  onDiscard: (id: string) => Promise<boolean>;
  onClose: () => void;
}

const POLL_MS = 1500;

function reasonText(reason: string | null | undefined): string {
  if (reason === "codex_missing") return "Codex is not installed on this machine, or the deck cannot find it.";
  if (reason === "code_expired") return "The code expired before it was used.";
  if (reason === "no_code") return "Codex did not give a sign-in code.";
  return "The sign-in did not finish.";
}

export default function AddCodexAccountDialog({ profile, onCreate, onCopyCommand, onSignedIn, onDiscard, onClose }: Props) {
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
  /** The account the sign-in landed on already had a row: this one's name. */
  const [repeats, setRepeats] = useState<string | null>(null);
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
    const same = await onSignedIn(target).catch(() => null);
    setRepeats(same);
    // A row asked to sign in again stays: it is the person's own row, and the
    // done step says what it now repeats. One made just now goes.
    if (same && !profile) {
      await onDiscard(target).catch(() => false);
      setId(null);
      setStage("repeat");
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
        if (!target) { setError("Could not add the account. Try again."); return; }
        setId(target);
      }
      await begin(target);
    } finally { setBusy(false); }
  }

  const minutesLeft = login?.expiresAt ? Math.max(0, Math.ceil((login.expiresAt - clock) / 60_000)) : null;
  const title = profile ? `Sign in ${profile.label}` : "Add a Codex account";

  return createPortal(
    <div className="modal-backdrop" {...scrimPress} role="presentation">
      <div ref={dialogRef} className="modal aa-modal" onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="aa-codex-title">
        <header className="modal-head">
          <div className="modal-title"><span id="aa-codex-title">{title}</span></div>
          <div className="modal-actions">
            <button type="button" className="glyph-btn" onClick={close} aria-label="Close (Esc)" title="Close (Esc)">×</button>
          </div>
        </header>
        <section className="modal-body aa-body">
          {stage === "ready" && (
            <div className="aa-step aa-primer">
              <p className="aa-note">
                Sign in to ChatGPT with a link and a one-time code. {profile
                  ? "The login is saved for this account only."
                  : "The account is named after its email, and keeps its own login, settings and history, apart from your other Codex accounts."}
              </p>
              {!profile && (
                <p className="aa-note">The page uses the account your browser is signed in to, so sign out of ChatGPT there first to add a different one.</p>
              )}
              {error && <p className="aa-err" role="alert">{error}</p>}
              <div className="aa-actions">
                <button ref={primaryRef} type="button" className="btn primary" aria-busy={busy}
                  onClick={() => void submit()}>Sign in with ChatGPT</button>
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
                <span>Starting the sign-in…</span>
              </p>
            </div>
          )}

          {stage === "waiting" && login && (
            <div className="aa-step">
              <p className="aa-note">
                <strong>1.</strong> {opened
                  ? "The sign-in page opened in a new tab. Sign in to your ChatGPT account there."
                  : "Open the sign-in page and sign in to your ChatGPT account."}
              </p>
              <a className="aa-link" href={login.url ?? "#"} target="_blank" rel="noreferrer noopener">
                <span>{opened ? "Open it again" : "Open the sign-in page"}</span>
                <span className="aa-link-host">
                  auth.openai.com
                  <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor"
                    strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M3 7 7 3M3.6 3H7v3.4" />
                  </svg>
                </span>
              </a>
              <p className="aa-note"><strong>2.</strong> Enter this one-time code.</p>
              <div className="aa-field">
                <code className="aa-device-code">{login.code}</code>
                <button type="button" className="btn" onClick={async () => { if (login.code && await copyText(login.code)) setCopied(true); }}>
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="aa-live-line" role="status">
                <svg className="aa-spin" viewBox="0 0 16 16" aria-hidden>
                  <circle className="aa-spin-track" cx="8" cy="8" r="6" />
                  <circle className="aa-spin-arc" cx="8" cy="8" r="6" />
                </svg>
                <span>Waiting for you to approve it{minutesLeft !== null ? ` — the code lasts ${minutesLeft} more minute${minutesLeft === 1 ? "" : "s"}` : ""}.</span>
              </p>
              <p className="aa-note">Only enter this code if you started this sign-in yourself.</p>
            </div>
          )}

          {stage === "checking" && (
            <div className="aa-step">
              <p className="aa-live-line" role="status">
                <svg className="aa-spin" viewBox="0 0 16 16" aria-hidden>
                  <circle className="aa-spin-track" cx="8" cy="8" r="6" />
                  <circle className="aa-spin-arc" cx="8" cy="8" r="6" />
                </svg>
                <span>Signed in. Reading the account…</span>
              </p>
            </div>
          )}

          {stage === "done" && (
            <div className="aa-done">
              <SuccessMark />
              <h4>Signed in</h4>
              <p className="aa-note">{repeats
                ? `This is the same ChatGPT account as ${repeats}, so the two share one quota.`
                : "The account is ready. New Codex sessions can use it once you make it the default."}</p>
              <div className="aa-actions"><button ref={primaryRef} type="button" className="btn primary" onClick={close}>Done</button></div>
            </div>
          )}

          {stage === "repeat" && (
            <div className="aa-step">
              <h4 className="aa-repeat-title">Already in your accounts</h4>
              <p className="aa-note"><strong>{repeats}</strong> is already here, so nothing was added.</p>
              <p className="aa-note">The sign-in page uses the ChatGPT account your browser is signed in to. To add a different one, sign out of ChatGPT in the browser first, or open the page in a private window.</p>
              <div className="aa-actions">
                <button ref={primaryRef} type="button" className="btn primary" onClick={() => { setLogin(null); setOpened(false); setStage("ready"); }}>Try another account</button>
                <button type="button" className="btn" onClick={close}>Done</button>
              </div>
            </div>
          )}

          {stage === "failed" && (
            <div className="aa-step">
              <p className="aa-err" role="alert">{reasonText(login?.reason)}</p>
              {login?.reason === "codex_missing" && id && (
                <p className="aa-note">Run the sign-in in a terminal instead, with the command below.</p>
              )}
              <div className="aa-actions">
                {id && <button type="button" className="btn primary" onClick={() => { openTab(); void begin(id); }}>Try again</button>}
                {id && <button type="button" className="btn" onClick={() => onCopyCommand(id)}>Copy the terminal command</button>}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>,
    document.body,
  );
}
