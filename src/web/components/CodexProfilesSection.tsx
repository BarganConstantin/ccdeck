// Codex's accounts, drawn the way Claude's are: the default account open with
// its 5-hour and weekly bars and when it was read, the other accounts behind one
// "Other accounts" row, each with a Switch, and a ⋯ menu for the rest. The two
// columns stay separate (CodexAccountsPanel.tsx) but read alike.
import { useEffect, useRef, useState } from "react";
import { copyText } from "../copy-text";
import AnchoredPopover from "./AnchoredPopover";
import AddCodexAccountDialog from "./AddCodexAccountDialog";
import { LaneBar } from "./AccountRow";
import { ago } from "../account-freshness";
import { type Lane } from "../claude-accounts";
import { lapsed } from "../lane-view";

interface CodexProfile {
  id: string;
  label: string;
  identityVersion: string;
  active: boolean;
  signedInFilePresent: boolean;
  signedIn?: boolean;
  authSource?: string;
  metadataUnavailable?: boolean;
  metadataReason?: string;
  available?: boolean;
  /** Present on an account this deck made, which is the only kind it removes. */
  managedLabel?: string;
}

interface ProfileQuota {
  ok: boolean;
  identityVersion?: string;
  reason?: string;
  stale?: boolean;
  partial?: boolean;
  lastGood?: ProfileQuota;
  fetchedAt?: number;
  plan?: string | null;
  windows?: { usedPercent: number; seconds: number | null; resetAt: number | null }[];
}

/** How often the default account's numbers are read again. The server keeps its
 *  own 60-second answer per profile, so this never costs a second request. */
const QUOTA_POLL_MS = 60_000;

/** A window's name the way the Claude column says it: 5h, 7d. */
function windowName(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "limit";
  return seconds <= 6 * 3600 ? `${Math.round(seconds / 3600)}h` : `${Math.round(seconds / 86400)}d`;
}

function lanesOf(quota: ProfileQuota | undefined): Lane[] {
  return (quota?.windows ?? []).map((w, index) => ({
    id: `w${index}`, label: windowName(w.seconds), pct: w.usedPercent, resetAt: w.resetAt,
  }));
}

/** What a reading says about one profile, or null before there is one. A reading
 *  taken for a login that has since changed is never shown as this profile's. */
function readingFor(profile: CodexProfile, quota: ProfileQuota | null | undefined): ProfileQuota | null {
  if (!quota) return null;
  const version = quota.identityVersion ?? quota.lastGood?.identityVersion;
  return (quota.ok || quota.stale) && version !== profile.identityVersion ? { ok: false, reason: "profile_changed" } : quota;
}

function accountState(profile: CodexProfile): string {
  return profile.available === false ? "Profile unavailable"
    : profile.metadataUnavailable ? `Login inspection unavailable: ${profile.metadataReason?.replaceAll("_", " ") ?? "unknown"}`
    : profile.signedIn ? "Codex login found"
    : profile.authSource === "native" ? "Not signed in to Codex"
    : profile.signedInFilePresent ? "Login file found" : "No login file";
}

function signInWord(profile: CodexProfile): string {
  return !profile.metadataUnavailable && (profile.authSource === "native" ? profile.signedIn : profile.signedInFilePresent)
    ? "Sign in again" : "Sign in";
}

const ready = (profile: CodexProfile) => profile.available !== false && (profile.signedIn || profile.signedInFilePresent);

export default function CodexProfilesSection({ onClose }: { onClose?: () => void } = {}) {
  const [profiles, setProfiles] = useState<CodexProfile[] | null>(null);
  const profileRequest = useRef(0);
  const profileRefreshes = useRef(0);
  const profileController = useRef<AbortController | null>(null);
  const quotaRequests = useRef(new Set<string>());
  const readFor = useRef(new Set<string>());
  const [error, setError] = useState(false);
  const [quotas, setQuotas] = useState<Record<string, ProfileQuota | null>>({});
  const [launch, setLaunch] = useState<Record<string, string>>({});
  const [revision, setRevision] = useState(0);
  const [action, setAction] = useState<string | null>(null);
  const actionRequest = useRef(false);
  const [message, setMessage] = useState("");
  const [clock, setClock] = useState(Date.now);
  /** Which profile's ⋯ menu is open. */
  const [menu, setMenu] = useState<string | null>(null);
  /** The Add / Sign in dialog: a new account, or one signed in again. */
  const [dialog, setDialog] = useState<null | { id?: string; label?: string }>(null);
  /** The account whose Remove has been pressed once and is waiting for the second. */
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  /** The "Other accounts" row, folded the way Claude's is until asked. */
  const [restOpen, setRestOpen] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  async function mutate(action: 'select' | 'remove', id: string) {
    if (actionRequest.current) return;
    actionRequest.current = true;
    setAction(id);
    setMessage('');
    try {
      const response = await fetch(`/api/codex-profile-${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, expectedRevision: revision, operationId: crypto.randomUUID() }),
      });
      const result = await response.json() as { ok: boolean; reason?: string; id?: string };
      if (!response.ok || !result.ok) throw new Error(result.reason ?? 'operation_failed');
      if (action === 'remove') {
        readFor.current.clear();
        setQuotas(current => { const { [id]: _gone, ...rest } = current; return rest; });
        setMessage('Account removed. Its sign-in and history are kept aside in the deck\'s data folder, not deleted.');
      } else setMessage('Default saved for new sessions. Restart open Codex sessions to use this account. Enable terminal integration once to apply it to the codex command.');
      await refreshProfiles().catch(() => setError(true));
    } catch (error) {
      const conflict = error instanceof Error && ['selection_conflict', 'operation_conflict', 'selection_busy'].includes(error.message);
      setMessage(conflict ? 'Another selection changed the default. Refreshing accounts; try again.' : 'Could not complete the operation. Refresh accounts and try again.');
      await refreshProfiles().catch(() => {});
    } finally { actionRequest.current = false; setAction(null); }
  }

  /** Make an account for the dialog, and read the roster again so it is listed.
   *  Resolves its id, or null when the deck refused. */
  async function createProfile(label: string): Promise<string | null> {
    try {
      const response = await fetch('/api/codex-profile-add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, expectedRevision: revision, operationId: crypto.randomUUID() }),
      });
      const result = await response.json() as { ok: boolean; id?: string };
      if (!response.ok || !result.ok || !result.id) return null;
      await refreshProfiles().catch(() => setError(true));
      return result.id;
    } catch { return null; }
  }

  /** Two presses within four seconds, like Claude's Remove: the first arms it. */
  function pressRemove(id: string) {
    if (confirmRemove === id) { setConfirmRemove(null); setMenu(null); void mutate('remove', id); }
    else setConfirmRemove(id);
  }

  async function copyCommand(kind: 'login' | 'terminal', id?: string, remove = false) {
    const key = id ?? 'terminal';
    try {
      const url = kind === 'login' ? `/api/codex-profile-login?id=${encodeURIComponent(id ?? '')}`
        : `/api/codex-terminal-command?action=${remove ? 'uninstall' : 'install'}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error('Unavailable');
      const result = await response.json() as { command: string };
      const copied = await copyText(result.command);
      setLaunch(current => ({ ...current, [key]: copied ? 'Command copied. Run it in your terminal.' : result.command }));
    } catch { setLaunch(current => ({ ...current, [key]: 'Could not prepare command' })); }
  }

  async function copyLaunch(id: string) {
    try {
      const response = await fetch(`/api/codex-profile-launch?id=${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error('Unavailable');
      const result = await response.json() as { command: string };
      const copied = await copyText(result.command);
      setLaunch((current) => ({ ...current, [id]: copied ? 'Copied launch command' : result.command }));
    } catch {
      setLaunch((current) => ({ ...current, [id]: 'Could not prepare command' }));
    }
  }

  /** Read one profile's numbers. `auto` is the first read of a profile and
   *  `poll` a later one, which keeps the old reading on screen until the new one
   *  lands so a poll never flashes "Checking…"; `ask` is somebody's press, and
   *  also reads the roster again, since a login may have changed under it. The
   *  roster has its own 15-second poll, so the other two leave it alone. */
  async function checkQuota(id: string, mode: 'ask' | 'auto' | 'poll' = 'ask') {
    if (quotaRequests.current.has(id)) return;
    quotaRequests.current.add(id);
    if (mode !== 'poll') setQuotas((current) => ({ ...current, [id]: null }));
    try {
      const response = await fetch(`/api/codex-profile-quota?id=${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error('Quota unavailable');
      const value = await response.json() as ProfileQuota;
      setQuotas((current) => ({ ...current, [id]: value }));
    } catch {
      setQuotas((current) => ({ ...current, [id]: { ok: false, reason: 'fetch_error' } }));
      return;
    } finally { quotaRequests.current.delete(id); }
    if (mode !== 'ask') return;
    const request = profileRequest.current + 1;
    await refreshProfiles().catch(() => {
      if (request === profileRequest.current) setError(true);
    });
  }

  async function refreshProfiles(signal = profileController.current?.signal) {
    if (signal?.aborted) return;
    const request = ++profileRequest.current;
    profileRefreshes.current++;
    try {
      const response = await fetch("/api/codex-profiles", { signal });
      if (!response.ok) throw new Error("Unable to load Codex profiles");
      const result = await response.json() as { profiles: CodexProfile[]; revision?: number };
      if (!Array.isArray(result.profiles)) throw new Error("Invalid Codex profiles response");
      if (signal?.aborted || request !== profileRequest.current) return;
      setProfiles(result.profiles);
      setRevision(result.revision ?? 0);
      setError(false);
    } finally { profileRefreshes.current--; }
  }

  useEffect(() => {
    const controller = new AbortController();
    profileController.current = controller;
    const load = () => {
      if (controller.signal.aborted || profileRefreshes.current > 0) return;
      const request = profileRequest.current + 1;
      return refreshProfiles(controller.signal).catch(() => {
        if (!controller.signal.aborted && request === profileRequest.current) setError(true);
      });
    };
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => { controller.abort(); profileRequest.current++; clearInterval(timer); };
  }, []);

  // Every profile is read once as it appears (and again when its login
  // changes), like the Claude column's rows, so the numbers are there before
  // anyone asks. A signed-out profile answers with its own reason, and says so.
  useEffect(() => {
    if (!profiles) return;
    for (const profile of profiles) {
      const key = `${profile.id}:${profile.identityVersion}`;
      if (profile.available === false || readFor.current.has(key)) continue;
      readFor.current.add(key);
      void checkQuota(profile.id, 'auto');
    }
  }, [profiles]);

  // The default account, the one being spent, is read again each minute.
  const activeId = profiles?.find(profile => profile.active)?.id;
  useEffect(() => {
    if (!activeId) return;
    const timer = setInterval(() => void checkQuota(activeId, 'poll'), QUOTA_POLL_MS);
    return () => clearInterval(timer);
  }, [activeId]);

  const nowSec = Math.floor(clock / 1000);
  const menuProfile = profiles?.find(profile => profile.id === menu) ?? null;
  const pick = (run: () => void) => () => { setMenu(null); run(); };
  useEffect(() => {
    if (!confirmRemove) return;
    const timer = setTimeout(() => setConfirmRemove(null), 4000);
    return () => clearTimeout(timer);
  }, [confirmRemove]);
  useEffect(() => { if (!menu) setConfirmRemove(null); }, [menu]);
  const reload = () => {
    void refreshProfiles().catch(() => setError(true));
    for (const profile of profiles ?? []) if (profile.available !== false) void checkQuota(profile.id, 'poll');
  };
  const moreGlyph = (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="currentColor" aria-hidden>
      <circle cx="2.8" cy="7" r="1.15" /><circle cx="7" cy="7" r="1.15" /><circle cx="11.2" cy="7" r="1.15" />
    </svg>
  );

  /** One account's row: the default one open with its bars, the others shut to
   *  the two numbers an account is chosen by and a Switch. */
  function accountRow(profile: CodexProfile, index: number) {
    const active = profile.active;
    const reading = readingFor(profile, quotas[profile.id]);
    const checking = Object.hasOwn(quotas, profile.id) && quotas[profile.id] === null;
    const shown = reading?.ok ? reading : reading?.stale ? reading.lastGood : undefined;
    const lanes = lanesOf(shown);
    const frozen = !!reading && !reading.ok;
    const live = lanes.filter(lane => !lapsed(lane, nowSec));
    const problem = reading && !reading.ok && !reading.stale
      ? `Quota unavailable: ${reading.reason?.replaceAll("_", " ") ?? "unknown"}` : null;
    return (
      <li key={profile.id} className={`ap-account${active ? " active" : ""}`}
        aria-current={active ? "true" : undefined} data-open={active ? "" : undefined} data-frozen={frozen ? "" : undefined}>
        <div className="ap-account-head">
          {active
            ? <span className="ap-live" title="Default account for new sessions"><span className="vis-hidden">Default account:</span></span>
            : <span className="ap-num">{index}</span>}
          <span className="ap-email" title={profile.label}>{profile.label}</span>
          {!active && profile.available !== false && (
            <button type="button" className="ap-switch" aria-busy={action === profile.id}
              aria-label={`Switch to ${profile.label}`} title="Use for new sessions"
              onClick={() => void mutate('select', profile.id)}>Switch</button>
          )}
          <button type="button" id={`ap-codex-more-${profile.id}`} className="ap-more"
            aria-label={`More actions for ${profile.label}`} title="More actions"
            aria-haspopup="menu" aria-expanded={menu === profile.id} aria-controls={menu === profile.id ? "ap-codex-menu" : undefined}
            onClick={() => setMenu(open => open === profile.id ? null : profile.id)}>{moreGlyph}</button>
        </div>
        {!lanes.length && <div className="ap-hint">{accountState(profile)}</div>}
        {checking && <div className="ap-hint" role="status">Checking quota…</div>}
        {problem && <div className="ap-hint" role="status">{problem}</div>}
        {launch[profile.id] && <div className="ap-hint" role="status">{launch[profile.id]}</div>}
        {active && lanes.length > 0 && (
          <div className="ap-detail">
            <div className="ap-lanes">
              {lanes.map(lane => <LaneBar key={lane.id} lane={lane} nowSec={nowSec} readAt={shown?.fetchedAt ?? null} frozen={frozen} />)}
            </div>
            <div className="ap-meta">
              <span className={`ap-age${frozen ? " ap-stale" : ""}`}>
                {shown?.fetchedAt ? `collected ${ago(shown.fetchedAt, nowSec)}` : "never collected"}
                {shown?.plan ? ` · ${shown.plan}` : ""}{shown?.partial ? " · ordinary limits only" : ""}
              </span>
            </div>
          </div>
        )}
        {!active && lanes.length > 0 && (
          <p className="ap-quota">
            {lanes.map(lane => (
              <span key={lane.id} className="ap-q">
                <span className="ap-q-label">{lane.label}</span>{" "}
                {live.includes(lane)
                  ? <span className="ap-q-pct">{Math.round(lane.pct)}%</span>
                  : <span className="ap-q-pct">reset</span>}
              </span>
            ))}
          </p>
        )}
      </li>
    );
  }

  const active = profiles?.find(profile => profile.active) ?? profiles?.[0];
  const rest = profiles?.filter(profile => profile !== active) ?? [];
  return (
    <>
      <div className="ap-header">
        <h2>Codex accounts</h2>
        <div className="ap-header-right">
          <button type="button" className="glyph-btn ap-add" aria-label="Add a Codex account" title="Add a Codex account"
            aria-haspopup="dialog" onClick={() => setDialog({})}>
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden>
              <path d="M7 2.2v9.6M2.2 7h9.6" />
            </svg>
          </button>
          <button type="button" className="glyph-btn ap-refresh" aria-label="Reload Codex accounts" title="Read the accounts and their numbers again"
            onClick={reload}>
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M11.6 6.2A4.8 4.8 0 1 0 11 9.6" />
              <path d="M11.9 2.6v3.7h-3.6" />
            </svg>
          </button>
          {onClose && (
            <button type="button" className="glyph-btn" aria-label="Close Codex accounts" onClick={onClose}>
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden>
                <path d="m3.5 3.5 7 7m0-7-7 7" />
              </svg>
            </button>
          )}
        </div>
      </div>
      <div className="ap-scroll">
        <section className="ap-codex" aria-label="Codex profiles">
          {error && profiles === null ? <p role="alert" className="ap-codex-hint">Could not load Codex profiles.</p> :
            profiles === null ? <p className="ap-codex-hint">Checking profiles…</p> :
            <>
              {error && <p role="alert" className="ap-codex-hint">Could not refresh Codex profiles. Showing the last roster.</p>}
              <ul className="ap-list">{active && accountRow(active, 1)}</ul>
              {rest.length > 0 && (
                <div className="ap-rest">
                  <button type="button" id="ap-codex-rest-entry" className="ap-nav" aria-expanded={restOpen}
                    aria-controls={restOpen ? "ap-codex-rest-panel" : undefined} onClick={() => setRestOpen(open => !open)}>
                    <span className="ap-nav-text">
                      <span className="ap-nav-name">Other accounts</span>
                      <span className="ap-nav-state">{rest.filter(ready).length} of {rest.length} ready</span>
                    </span>
                    <svg className="ap-nav-chev" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
                      strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M5.6 3.4 9.2 7l-3.6 3.6" />
                    </svg>
                  </button>
                </div>
              )}
              {rest.length > 0 && restOpen && (
                <div className="ap-rest-panel" id="ap-codex-rest-panel">
                  <ul className="ap-list ap-others">{rest.map((profile, index) => accountRow(profile, index + 2))}</ul>
                </div>
              )}
              {message && <p className="ap-codex-hint" role="status">{message}</p>}
              {launch.terminal && <p className="ap-codex-hint" role="status">{launch.terminal}</p>}
              <p className="ap-codex-hint" title="Terminal selection needs a one-time setup (in the default account's ⋯ menu); an explicit CODEX_HOME takes priority. Codex manages sign-in and renewal. A login file does not guarantee an active session.">
                New sessions use the default. Running ones keep their account.
              </p>
            </>}
        </section>
      </div>
      {menuProfile && (
        <AnchoredPopover anchorId={`ap-codex-more-${menuProfile.id}`} id="ap-codex-menu" className="ap-pop" role="menu"
          labelledBy={`ap-codex-more-${menuProfile.id}`} onClose={() => setMenu(null)}>
          {menuProfile.available !== false && (
            <button type="button" role="menuitem" className="ap-menu-item"
              onClick={pick(() => void checkQuota(menuProfile.id))}>Check quota</button>
          )}
          <button type="button" role="menuitem" className="ap-menu-item"
            onClick={pick(() => void copyLaunch(menuProfile.id))}>Copy launch command</button>
          <button type="button" role="menuitem" className="ap-menu-item"
            onClick={pick(() => setDialog({ id: menuProfile.id, label: menuProfile.label }))}>{signInWord(menuProfile)}</button>
          {menuProfile.active && (
            <>
              <button type="button" role="menuitem" className="ap-menu-item"
                title="Copies a one-time setup so the plain codex command follows the default"
                onClick={pick(() => void copyCommand('terminal'))}>Enable terminal selection</button>
              <button type="button" role="menuitem" className="ap-menu-item"
                onClick={pick(() => void copyCommand('terminal', undefined, true))}>Remove terminal selection</button>
            </>
          )}
          {menuProfile.managedLabel !== undefined && (
            <button type="button" role="menuitem"
              className={`ap-menu-item danger${confirmRemove === menuProfile.id ? " armed" : ""}`}
              aria-label={confirmRemove === menuProfile.id ? "Confirm remove" : undefined}
              title={confirmRemove === menuProfile.id
                ? "Press again within four seconds to remove it"
                : "Take this account out of the deck. Its sign-in and history are kept aside, not deleted."}
              onClick={() => pressRemove(menuProfile.id)}>{confirmRemove === menuProfile.id ? "Confirm" : "Remove"}</button>
          )}
        </AnchoredPopover>
      )}
      {dialog && (
        <AddCodexAccountDialog
          profile={dialog.id && dialog.label ? { id: dialog.id, label: dialog.label } : undefined}
          onCreate={createProfile}
          onCopyCommand={id => void copyCommand('login', id)}
          onSignedIn={() => {
            readFor.current.clear();
            void refreshProfiles().catch(() => setError(true));
          }}
          onClose={() => { setDialog(null); void refreshProfiles().catch(() => setError(true)); }}
        />
      )}
    </>
  );
}
