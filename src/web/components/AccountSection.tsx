// Settings › Account: this deck and the person's ccdeck account (design 4.7).
//
// HIDDEN. The section exists only on a deck whose /api/prefs says the account
// is on (or was asked for and vetoed at launch); SettingsModal loads this
// file with React.lazy for that case alone, so on every other deck the chunk
// is never fetched.
//
// ONE STATE AT A TIME, each with its own sentences:
//   not connected  what connecting does and what is sent, the name this deck
//                  will appear under (editable before anything is sent), Connect
//   connecting     the code to match in the browser, the page again, Cancel,
//                  and how long the code has left
//   connected      the account, this device and its page in Machines, the last
//                  status sent, where the token is kept, the settings sync, and
//                  Disconnect behind a confirmation
//   removed        it was removed at app.ccdeck.dev; Connect again
//   off            vetoed at launch, and by what
//
// NOT IN SETTINGS' SEARCH: the rows carry no setting ids, so the index
// (settings-search.ts), which is built from the released sections, has
// nothing to land on here and a search never finds the hidden section.
//
// THE WORDS NEVER PROMISE WHAT IS NOT TRUE: status and settings are readable
// by ccdeck's server (the owner's decision, 2026-10-14), so nothing here says
// "end-to-end" or "encrypted". The token itself is kept where the OS keeps
// secrets, and the line says where.
import { useEffect, useRef, useState } from "react";
import type { AccountView } from "../account-bridge";
import { UI_LABELS } from "../account-ui-fields";
import { selfPressAccepted, selfPressProps } from "../panel-press";
import { accountActions, openableUrl, useAccountView } from "../use-account";
import AccountSyncPreview, { shownValue } from "./AccountSyncPreview";
import { SettingRow, SettingsGroup } from "./SettingsParts";

export const ACCOUNT_COPY = {
  vetoed: "Off on this machine: the deck was started with AGENTS_DECK_NO_ACCOUNT=1 or AGENTS_DECK_NO_INSTALL=1, which keep it away from any account.",
  loading: "Reading this deck's account…",
  unreachable: "The deck did not answer. It may be restarting.",
  explain: "Connect this deck to your ccdeck account to see it in Machines at app.ccdeck.dev, and to keep the settings you choose in step with your other decks.",
  sent: "While connected it sends, every 15 seconds: its name, version and system, CPU and memory use, and how many sessions are running or waiting on you. Never what your sessions do, their names, your files or your Claude accounts. What it sends, and the settings you sync, are kept on ccdeck's server, which can read them.",
  nameNote: "How this deck is listed in your account. Change it before connecting if you would rather not use this computer's name.",
  connecting: "Approve this deck in the browser. Check that the code there matches this one.",
  revoked: "This deck was removed from your account at app.ccdeck.dev.",
  accountGone: "The ccdeck account this deck was connected to was deleted.",
  disconnectNote: "It stops sending status and syncing settings. Its settings stay as they are.",
  tokenMissing: "This deck's sign-in could not be found. Connect it again.",
};

export const PROBLEM_COPY: Record<string, string> = {
  "api-disabled": "Accounts are not open yet.",
  offline: "Could not reach ccdeck. Check the connection and try again.",
  "rate-limited": "Too many tries just now. Wait a minute and try again.",
  "connect-denied": "Cancelled in the browser.",
  "connect-expired": "The code expired before it was approved. Connect again.",
  "connect-failed": "Connecting did not work. Try again.",
  "keychain-locked": "The keychain is locked, so this deck cannot read its sign-in. Retrying every minute.",
  "token-missing": ACCOUNT_COPY.tokenMissing,
};

export const STORAGE_COPY: Record<string, string> = {
  keychain: "Stored in your keychain.",
  dpapi: "Stored encrypted for your Windows user.",
  "secret-service": "Stored in your keyring.",
  file: "Stored in a file only you can read.",
};

const time = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
};

/** The status line: when the last frame went, or that it is not getting through. */
export function statusLine(view: AccountView): string {
  const s = view.status;
  if (!s || !s.lastSentAt) return "Status: not sent yet.";
  if (s.lastResult === "offline") return `Offline, retrying. Last tried ${time(s.lastSentAt)}.`;
  if (s.lastResult === "rejected") return `Status: refused at ${time(s.lastSentAt)}, sending again.`;
  return `Status: sent ${time(s.lastSentAt)} · every ${s.everySec} s.`;
}

/** "Saved r14 · Applied r13", the console's own words for the two revisions. */
export function revisionsLine(view: AccountView): string {
  const sync = view.sync;
  if (!sync) return "";
  const applied = sync.appliedRevision == null ? "not yet" : `r${sync.appliedRevision}`;
  return `Saved r${sync.savedRevision} · Applied ${applied}`;
}

/** How long a code has left, as m:ss. */
export function expiresIn(expiresAt: string, now: number): string {
  const left = Math.max(0, Math.round((Date.parse(expiresAt) - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

export interface AccountPanelProps {
  view: AccountView | null;
  failed?: boolean;
  vetoed: boolean;
  now?: number;
}

/** The section as drawn for one answer of /api/account — pure, so each state's
 *  copy can be checked without a deck behind it. */
export function AccountPanel({ view, failed = false, vetoed, now = Date.now() }: AccountPanelProps) {
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // No control here disables itself while its press is out (#620): the
  // control keeps its focus, says it is busy, and a second press is refused
  // here, off a ref, since the state a handler closed over is a render old.
  const busyRef = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const [joining, setJoining] = useState(false);
  const [reviewing, setReviewing] = useState(false);

  if (vetoed) {
    return (
      <SettingsGroup id="settings-account-caption" title="ccdeck account">
        <SettingRow as="div" name="Account" note={ACCOUNT_COPY.vetoed} />
      </SettingsGroup>
    );
  }
  if (!view) {
    return <p className="settings-row-note">{failed ? ACCOUNT_COPY.unreachable : ACCOUNT_COPY.loading}</p>;
  }

  const problem = view.problem ? PROBLEM_COPY[view.problem] ?? null : null;
  const run = async (fn: () => Promise<unknown>) => {
    if (!selfPressAccepted(busyRef.current)) return;
    busyRef.current = true;
    setBusy(true);
    try { await fn(); } catch { /* the next answer says what happened */ } finally { busyRef.current = false; setBusy(false); }
  };

  const connect = () => run(async () => {
    const next = await accountActions.connect(name ?? view.suggestedName);
    const url = next?.connect?.verificationUriComplete;
    // Opened from the press, and only a URL that is https — or loopback for a
    // development API — so a deck cannot be made to open anything else.
    if (url && openableUrl(url)) window.open(url, "_blank", "noopener,noreferrer");
  });

  if (view.state === "connecting" && view.connect) {
    const c = view.connect;
    return (
      <SettingsGroup id="settings-account-caption" title="Connecting">
        <SettingRow as="div" name="Code" note={ACCOUNT_COPY.connecting}
          control={<span className="account-code">{c.userCode}</span>} />
        <SettingRow as="div" name="Waiting for approval…" note={`The code expires in ${expiresIn(c.expiresAt, now)}.`}
          control={
            <span className="account-actions">
              {openableUrl(c.verificationUriComplete) && (
                <a className="settings-link" href={c.verificationUriComplete} target="_blank" rel="noopener noreferrer">Open the page again</a>
              )}
              <button type="button" className="btn" {...selfPressProps(busy)} onClick={() => run(accountActions.cancel)}>Cancel</button>
            </span>
          } />
      </SettingsGroup>
    );
  }

  if (view.state === "connected" && view.device) {
    const sync = view.sync;
    const email = view.account?.email ?? "your account";
    return (
      <>
        <SettingsGroup id="settings-account-caption" title="ccdeck account">
          <SettingRow as="div" name={email} note={statusLine(view)}
            control={view.device.consoleUrl && openableUrl(view.device.consoleUrl)
              ? <a className="settings-link" href={view.device.consoleUrl} target="_blank" rel="noopener noreferrer">Open in Machines</a>
              : undefined} />
          <SettingRow as="div" name={`This deck: ${view.device.name}`}
            note={problem ?? STORAGE_COPY[view.tokenStorage ?? ""] ?? ""} />
        </SettingsGroup>
        {sync && (
          <SettingsGroup id="settings-account-sync-caption" title="Settings sync">
            <SettingRow as="div"
              name={sync.mode === "shared" ? "Shared with your other decks" : "This deck only"}
              note={sync.mode === "shared"
                ? `Theme, text, panels and the rest follow your account; ${sync.overrides.map(k => UI_LABELS[k]?.toLowerCase() ?? k).join(", ") || "nothing"} stays on this deck. ${revisionsLine(view)}`
                : `This deck keeps its own settings in your account. ${revisionsLine(view)}`}
              control={sync.mode === "shared"
                ? <button type="button" className="btn" {...selfPressProps(busy)} onClick={() => run(() => accountActions.setMode({ mode: "independent" }))}>Stop sharing</button>
                : <button type="button" className="btn" {...selfPressProps(busy, joining)} onClick={() => setJoining(true)}>Share settings…</button>} />
            {joining && (
              <SettingRow as="div" className="settings-row-wide" name="Share settings with your other decks">
                <AccountSyncPreview onDone={() => setJoining(false)} />
              </SettingRow>
            )}
            {sync.pending && !sync.conflict && (
              <SettingRow as="div" name="Pending"
                note={`${sync.pending.keys.map(k => UI_LABELS[k] ?? k).join(", ")}. ${sync.saving === "offline" ? "Will save when back online." : sync.saving === "refused" ? "The account refused part of it." : "Saving…"}`} />
            )}
            {sync.conflict && (
              <SettingRow as="div" className={reviewing ? "settings-row-wide" : undefined}
                name="Changed elsewhere"
                note={`Your account has r${sync.conflict.latest.revision}${sync.conflict.latest.updatedBy?.name ? ` from ${sync.conflict.latest.updatedBy.name}` : ""}; this deck has changes it has not saved.`}
                control={reviewing ? undefined : (
                  <span className="account-actions">
                    <button type="button" className="btn" {...selfPressProps(busy)} onClick={() => setReviewing(true)}>Review</button>
                    <button type="button" className="btn primary" {...selfPressProps(busy)} onClick={() => run(() => accountActions.resolve("use-latest"))}>Use latest</button>
                  </span>
                )}>
                {reviewing && (
                  <div className="account-preview">
                    <table className="account-diff">
                      <thead><tr><th scope="col">Setting</th><th scope="col">Yours</th><th scope="col">{`r${sync.conflict.latest.revision}`}</th></tr></thead>
                      <tbody>
                        {Object.keys(sync.conflict.mine).map(k => (
                          <tr key={k}>
                            <th scope="row">{UI_LABELS[k] ?? k}</th>
                            <td>{shownValue(k, sync.conflict!.mine[k])}</td>
                            <td>{shownValue(k, sync.conflict!.latest.values[k])}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="account-actions">
                      <button type="button" className="btn" {...selfPressProps(busy)} onClick={() => setReviewing(false)}>Back</button>
                      <button type="button" className="btn" {...selfPressProps(busy)} onClick={() => run(() => accountActions.resolve("use-latest"))}>Use latest</button>
                      <button type="button" className="btn primary" {...selfPressProps(busy)}
                        onClick={() => run(async () => { await accountActions.resolve("reapply"); setReviewing(false); })}>{`Save mine over r${sync.conflict.latest.revision}`}</button>
                    </div>
                  </div>
                )}
              </SettingRow>
            )}
            {sync.askUploadForNewAccount && (
              <SettingRow as="div" name="Not saved to this account yet"
                note={`This deck's settings are not in ${email}. Nothing is uploaded until you say so, or change a setting.`}
                control={<button type="button" className="btn" {...selfPressProps(busy)} onClick={() => run(accountActions.upload)}>{`Save this deck's settings to ${email}`}</button>} />
            )}
            {sync.skipped?.theme && (
              <SettingRow as="div" name="Theme kept"
                note={`The theme “${sync.skipped.theme}” is not in this version of ccdeck, so this deck kept its own.`} />
            )}
          </SettingsGroup>
        )}
        <SettingsGroup id="settings-account-leave-caption" title="Disconnect">
          <SettingRow as="div" name="Disconnect this deck" note={ACCOUNT_COPY.disconnectNote}
            control={confirming ? (
              <span className="account-actions">
                <button type="button" className="btn" {...selfPressProps(busy)} onClick={() => setConfirming(false)}>Cancel</button>
                <button type="button" className="btn danger" {...selfPressProps(busy)}
                  onClick={() => run(async () => { await accountActions.disconnect(); setConfirming(false); })}>Disconnect</button>
              </span>
            ) : (
              <button type="button" className="btn" {...selfPressProps(busy)} onClick={() => setConfirming(true)}>Disconnect…</button>
            )} />
        </SettingsGroup>
      </>
    );
  }

  // Not connected: never connected, disconnected, removed, or a sign-in lost.
  const removed = view.state === "revoked";
  const lead = removed
    ? (view.revokedReason === "account_gone" ? ACCOUNT_COPY.accountGone : ACCOUNT_COPY.revoked)
    : view.state === "error" ? ACCOUNT_COPY.tokenMissing : ACCOUNT_COPY.explain;
  return (
    <SettingsGroup id="settings-account-caption" title="ccdeck account" note={lead}>
      <SettingRow as="div" name="What is sent" note={ACCOUNT_COPY.sent} />
      <SettingRow name="This deck will appear as" nameId="settings-account-name-label"
        note={ACCOUNT_COPY.nameNote} noteId="settings-account-name-note"
        control={
          <input
            className="ap-manage-input account-name"
            type="text"
            value={name ?? view.suggestedName}
            maxLength={48}
            spellCheck={false}
            autoComplete="off"
            aria-labelledby="settings-account-name-label"
            aria-describedby="settings-account-name-note"
            onChange={e => setName(e.target.value)}
          />
        } />
      <SettingRow as="div" name={removed ? "Connect again" : "Connect account"}
        note={problem ?? (STORAGE_COPY[view.tokenStorage ?? ""] ? `Its sign-in will be ${STORAGE_COPY[view.tokenStorage ?? ""].replace(/^Stored/, "stored")}` : undefined)}
        control={<button type="button" className="btn primary" {...selfPressProps(busy)} onClick={connect}>{removed ? "Connect again" : "Connect account"}</button>} />
    </SettingsGroup>
  );
}

/** The section, on the deck's own answer. A second's tick while a code is up,
 *  for its countdown, and none otherwise. */
export default function AccountSection({ vetoed }: { vetoed: boolean }) {
  // A vetoed deck has no /api/account to ask (every route is the 404 there),
  // so it is not asked.
  if (vetoed) return <AccountPanel view={null} vetoed />;
  return <LiveAccountSection />;
}

function LiveAccountSection() {
  const { view, failed } = useAccountView();
  const [now, setNow] = useState(() => Date.now());
  const connecting = view?.state === "connecting";
  useEffect(() => {
    if (!connecting) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [connecting]);
  useEffect(() => { void accountActions.refresh(); }, []);
  return <AccountPanel view={view} failed={failed} vetoed={false} now={now} />;
}
