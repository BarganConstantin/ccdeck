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
import { uiLabelOf } from "../account-ui-fields";
import { selfPressAccepted, selfPressProps } from "../panel-press";
import { accountActions, openableUrl, useAccountView } from "../use-account";
import AccountSyncPreview, { shownValue } from "./AccountSyncPreview";
import { SettingRow, SettingsGroup } from "./SettingsParts";
import { currentLanguage, t as say, useT, type MessageKey } from "../i18n";

/** The section's sentences, as keys read with `t` where each is drawn. */
export const ACCOUNT_MSGS: Record<"vetoed" | "loading" | "unreachable" | "explain" | "sent" | "nameNote" | "connecting" | "revoked" | "accountGone" | "disconnectNote" | "tokenMissing", MessageKey> = {
  vetoed: "settings.account.copy.vetoed",
  loading: "settings.account.copy.loading",
  unreachable: "settings.account.copy.unreachable",
  explain: "settings.account.copy.explain",
  sent: "settings.account.copy.sent",
  nameNote: "settings.account.copy.nameNote",
  connecting: "settings.account.copy.connecting",
  revoked: "settings.account.copy.revoked",
  accountGone: "settings.account.copy.accountGone",
  disconnectNote: "settings.account.copy.disconnectNote",
  tokenMissing: "settings.account.copy.tokenMissing",
};

/** What went wrong last time, by the deck's problem code, as a key. */
export const PROBLEM_MSGS: Record<string, MessageKey> = {
  "api-disabled": "settings.account.problem.apiDisabled",
  offline: "settings.account.problem.offline",
  "rate-limited": "settings.account.problem.rateLimited",
  "connect-denied": "settings.account.problem.connectDenied",
  "connect-expired": "settings.account.problem.connectExpired",
  "connect-failed": "settings.account.problem.connectFailed",
  "keychain-locked": "settings.account.problem.keychainLocked",
  "token-missing": ACCOUNT_MSGS.tokenMissing,
};

/** Where the sign-in is kept, by the deck's storage code, as a key. */
export const STORAGE_MSGS: Record<string, MessageKey> = {
  keychain: "settings.account.storage.keychain",
  dpapi: "settings.account.storage.dpapi",
  "secret-service": "settings.account.storage.secretService",
  file: "settings.account.storage.file",
};

/** The same, as the not-connected sentence "Its sign-in will be stored …". */
const SIGN_IN_MSGS: Record<string, MessageKey> = {
  keychain: "settings.account.signIn.keychain",
  dpapi: "settings.account.signIn.dpapi",
  "secret-service": "settings.account.signIn.secretService",
  file: "settings.account.signIn.file",
};

/** A time of day in the deck's chosen language. */
const time = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString(currentLanguage(), { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
};

/** The status line: when the last frame went, or that it is not getting through. */
export function statusLine(view: AccountView): string {
  const s = view.status;
  if (!s || !s.lastSentAt) return say("settings.account.status.notSent");
  if (s.lastResult === "offline") return say("settings.account.status.offline", { time: time(s.lastSentAt) });
  if (s.lastResult === "rejected") return say("settings.account.status.refused", { time: time(s.lastSentAt) });
  return say("settings.account.status.sent", { time: time(s.lastSentAt), seconds: s.everySec });
}

/** "Saved r14 · Applied r13", the console's own words for the two revisions. */
export function revisionsLine(view: AccountView): string {
  const sync = view.sync;
  if (!sync) return "";
  return sync.appliedRevision == null
    ? say("settings.account.revisionsNotYet", { saved: sync.savedRevision })
    : say("settings.account.revisions", { saved: sync.savedRevision, applied: sync.appliedRevision });
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
  const t = useT();
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
      <SettingsGroup id="settings-account-caption" title={t("settings.account.title")}>
        <SettingRow as="div" name={t("settings.section.account.label")} note={t(ACCOUNT_MSGS.vetoed)} />
      </SettingsGroup>
    );
  }
  if (!view) {
    return <p className="settings-row-note">{t(failed ? ACCOUNT_MSGS.unreachable : ACCOUNT_MSGS.loading)}</p>;
  }

  const problemMsg = view.problem ? PROBLEM_MSGS[view.problem] : undefined;
  const problem = problemMsg ? t(problemMsg) : null;
  const storageMsg = STORAGE_MSGS[view.tokenStorage ?? ""];
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
      <SettingsGroup id="settings-account-caption" title={t("settings.account.connecting")}>
        <SettingRow as="div" name={t("settings.account.code")} note={t(ACCOUNT_MSGS.connecting)}
          control={<span className="account-code">{c.userCode}</span>} />
        <SettingRow as="div" name={t("settings.account.waiting")} note={t("settings.account.expiresIn", { time: expiresIn(c.expiresAt, now) })}
          control={
            <span className="account-actions">
              {openableUrl(c.verificationUriComplete) && (
                <a className="settings-link" href={c.verificationUriComplete} target="_blank" rel="noopener noreferrer">{t("settings.account.openAgain")}</a>
              )}
              <button type="button" className="btn" {...selfPressProps(busy)} onClick={() => run(accountActions.cancel)}>{t("common.cancel")}</button>
            </span>
          } />
      </SettingsGroup>
    );
  }

  if (view.state === "connected" && view.device) {
    const sync = view.sync;
    const email = view.account?.email ?? t("settings.account.yourAccount");
    return (
      <>
        <SettingsGroup id="settings-account-caption" title={t("settings.account.title")}>
          <SettingRow as="div" name={email} note={statusLine(view)}
            control={view.device.consoleUrl && openableUrl(view.device.consoleUrl)
              ? <a className="settings-link" href={view.device.consoleUrl} target="_blank" rel="noopener noreferrer">{t("settings.account.openMachines")}</a>
              : undefined} />
          <SettingRow as="div" name={t("settings.account.thisDeck", { name: view.device.name })}
            note={problem ?? (storageMsg ? t(storageMsg) : "")} />
        </SettingsGroup>
        {sync && (
          <SettingsGroup id="settings-account-sync-caption" title={t("settings.account.syncTitle")}>
            <SettingRow as="div"
              name={t(sync.mode === "shared" ? "settings.account.sharedName" : "settings.account.deckOnlyName")}
              note={sync.mode === "shared"
                ? t("settings.account.sharedNote", { stays: sync.overrides.map(k => uiLabelOf(t, k)?.toLowerCase() ?? k).join(", ") || t("settings.account.nothing"), revisions: revisionsLine(view) })
                : t("settings.account.deckOnlyNote", { revisions: revisionsLine(view) })}
              control={sync.mode === "shared"
                ? <button type="button" className="btn" {...selfPressProps(busy)} onClick={() => run(() => accountActions.setMode({ mode: "independent" }))}>{t("settings.account.stopSharing")}</button>
                : <button type="button" className="btn" {...selfPressProps(busy, joining)} onClick={() => setJoining(true)}>{t("settings.account.shareSettings")}</button>} />
            {joining && (
              <SettingRow as="div" className="settings-row-wide" name={t("settings.account.joinName")}>
                <AccountSyncPreview onDone={() => setJoining(false)} />
              </SettingRow>
            )}
            {sync.pending && !sync.conflict && (
              <SettingRow as="div" name={t("settings.account.pending")}
                note={t("settings.account.pendingNote", {
                  keys: sync.pending.keys.map(k => uiLabelOf(t, k) ?? k).join(", "),
                  state: t(sync.saving === "offline" ? "settings.account.pendingOffline" : sync.saving === "refused" ? "settings.account.pendingRefused" : "settings.account.pendingSaving"),
                })} />
            )}
            {sync.conflict && (
              <SettingRow as="div" className={reviewing ? "settings-row-wide" : undefined}
                name={t("settings.account.changedElsewhere")}
                note={sync.conflict.latest.updatedBy?.name
                  ? t("settings.account.changedElsewhereBy", { revision: sync.conflict.latest.revision, name: sync.conflict.latest.updatedBy.name })
                  : t("settings.account.changedElsewhereNote", { revision: sync.conflict.latest.revision })}
                control={reviewing ? undefined : (
                  <span className="account-actions">
                    <button type="button" className="btn" {...selfPressProps(busy)} onClick={() => setReviewing(true)}>{t("settings.account.review")}</button>
                    <button type="button" className="btn primary" {...selfPressProps(busy)} onClick={() => run(() => accountActions.resolve("use-latest"))}>{t("settings.account.useLatest")}</button>
                  </span>
                )}>
                {reviewing && (
                  <div className="account-preview">
                    <table className="account-diff">
                      <thead><tr><th scope="col">{t("settings.account.colSetting")}</th><th scope="col">{t("settings.account.colYours")}</th><th scope="col">{`r${sync.conflict.latest.revision}`}</th></tr></thead>
                      <tbody>
                        {Object.keys(sync.conflict.mine).map(k => (
                          <tr key={k}>
                            <th scope="row">{uiLabelOf(t, k) ?? k}</th>
                            <td>{shownValue(t, k, sync.conflict!.mine[k])}</td>
                            <td>{shownValue(t, k, sync.conflict!.latest.values[k])}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="account-actions">
                      <button type="button" className="btn" {...selfPressProps(busy)} onClick={() => setReviewing(false)}>{t("settings.account.back")}</button>
                      <button type="button" className="btn" {...selfPressProps(busy)} onClick={() => run(() => accountActions.resolve("use-latest"))}>{t("settings.account.useLatest")}</button>
                      <button type="button" className="btn primary" {...selfPressProps(busy)}
                        onClick={() => run(async () => { await accountActions.resolve("reapply"); setReviewing(false); })}>{t("settings.account.saveMine", { revision: sync.conflict.latest.revision })}</button>
                    </div>
                  </div>
                )}
              </SettingRow>
            )}
            {sync.askUploadForNewAccount && (
              <SettingRow as="div" name={t("settings.account.notSavedName")}
                note={t("settings.account.notSavedNote", { email })}
                control={<button type="button" className="btn" {...selfPressProps(busy)} onClick={() => run(accountActions.upload)}>{t("settings.account.saveToAccount", { email })}</button>} />
            )}
            {sync.skipped?.theme && (
              <SettingRow as="div" name={t("settings.account.themeKept")}
                note={t("settings.account.themeKeptNote", { theme: sync.skipped.theme })} />
            )}
          </SettingsGroup>
        )}
        <SettingsGroup id="settings-account-leave-caption" title={t("settings.account.disconnectTitle")}>
          <SettingRow as="div" name={t("settings.account.disconnectName")} note={t(ACCOUNT_MSGS.disconnectNote)}
            control={confirming ? (
              <span className="account-actions">
                <button type="button" className="btn" {...selfPressProps(busy)} onClick={() => setConfirming(false)}>{t("common.cancel")}</button>
                <button type="button" className="btn danger" {...selfPressProps(busy)}
                  onClick={() => run(async () => { await accountActions.disconnect(); setConfirming(false); })}>{t("settings.account.disconnect")}</button>
              </span>
            ) : (
              <button type="button" className="btn" {...selfPressProps(busy)} onClick={() => setConfirming(true)}>{t("settings.account.disconnectAsk")}</button>
            )} />
        </SettingsGroup>
      </>
    );
  }

  // Not connected: never connected, disconnected, removed, or a sign-in lost.
  const removed = view.state === "revoked";
  const lead = removed
    ? (view.revokedReason === "account_gone" ? ACCOUNT_MSGS.accountGone : ACCOUNT_MSGS.revoked)
    : view.state === "error" ? ACCOUNT_MSGS.tokenMissing : ACCOUNT_MSGS.explain;
  const signInMsg = SIGN_IN_MSGS[view.tokenStorage ?? ""];
  return (
    <SettingsGroup id="settings-account-caption" title={t("settings.account.title")} note={t(lead)}>
      <SettingRow as="div" name={t("settings.account.whatIsSent")} note={t(ACCOUNT_MSGS.sent)} />
      <SettingRow name={t("settings.account.appearAs")} nameId="settings-account-name-label"
        note={t(ACCOUNT_MSGS.nameNote)} noteId="settings-account-name-note"
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
      <SettingRow as="div" name={t(removed ? "settings.account.connectAgain" : "settings.account.connect")}
        note={problem ?? (signInMsg ? t(signInMsg) : undefined)}
        control={<button type="button" className="btn primary" {...selfPressProps(busy)} onClick={connect}>{t(removed ? "settings.account.connectAgain" : "settings.account.connect")}</button>} />
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
