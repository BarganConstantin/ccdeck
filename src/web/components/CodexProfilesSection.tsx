import { useEffect, useRef, useState } from "react";
import { copyText } from "../copy-text";
import AnchoredPopover from "./AnchoredPopover";

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

function quotaSummary(quota: ProfileQuota, now: number): string {
  const windows = quota.windows?.map((w) => `${Math.round(w.usedPercent)}% used (${w.seconds ? `${Math.round(w.seconds / 3600)}h` : 'window'})`).join(' · ');
  const age = quota.fetchedAt ? ` · Read ${Math.max(0, Math.floor((now - quota.fetchedAt) / 1000))}s ago` : '';
  return `${quota.plan ?? 'Codex'} · ${windows || 'No limits reported'}${age}${quota.partial ? ' · Ordinary Codex limits only' : ''}`;
}

function quotaStatus(quota: ProfileQuota, now: number): string {
  if (quota.ok) return quotaSummary(quota, now);
  const error = `Quota unavailable: ${quota.reason?.replaceAll('_', ' ') ?? 'unknown'}`;
  return quota.stale && quota.lastGood
    ? `${error} · Last confirmed (stale): ${quotaSummary(quota.lastGood, now)}`
    : error;
}

export default function CodexProfilesSection({ standalone = false }: { standalone?: boolean } = {}) {
  const [profiles, setProfiles] = useState<CodexProfile[] | null>(null);
  const profileRequest = useRef(0);
  const profileRefreshes = useRef(0);
  const profileController = useRef<AbortController | null>(null);
  const quotaRequests = useRef(new Set<string>());
  const [error, setError] = useState(false);
  const [quotas, setQuotas] = useState<Record<string, ProfileQuota | null>>({});
  const [launch, setLaunch] = useState<Record<string, string>>({});
  const [revision, setRevision] = useState(0);
  const [action, setAction] = useState<string | null>(null);
  const actionRequest = useRef(false);
  const [message, setMessage] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [clock, setClock] = useState(Date.now);
  /** Which ⋯ menu is open: a profile's id, or "section" for the title's own. */
  const [menu, setMenu] = useState<string | null>(null);
  /** The label field and Add are not drawn until the + asks for them. */
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  async function mutate(action: 'select' | 'add', id?: string) {
    if (actionRequest.current) return;
    actionRequest.current = true;
    setAction(id ?? 'add');
    setMessage('');
    try {
      const response = await fetch(`/api/codex-profile-${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, label: newLabel.trim(), expectedRevision: revision, operationId: crypto.randomUUID() }),
      });
      const result = await response.json() as { ok: boolean; reason?: string; id?: string };
      if (!response.ok || !result.ok) throw new Error(result.reason ?? 'operation_failed');
      if (action === 'add' && result.id) {
        setNewLabel('');
        await copyCommand('login', result.id);
        setMessage('Profile created. Run its sign-in command in a terminal, then complete the official Codex login.');
      } else setMessage('Default saved for new sessions. Restart open Codex sessions to use this account. Enable terminal integration once to apply it to the codex command.');
      await refreshProfiles().catch(() => setError(true));
    } catch (error) {
      const conflict = error instanceof Error && ['selection_conflict', 'operation_conflict', 'selection_busy'].includes(error.message);
      setMessage(conflict ? 'Another selection changed the default. Refreshing accounts; try again.' : 'Could not complete the operation. Refresh accounts and try again.');
      await refreshProfiles().catch(() => {});
    } finally { actionRequest.current = false; setAction(null); }
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

  async function checkQuota(id: string) {
    if (quotaRequests.current.has(id)) return;
    quotaRequests.current.add(id);
    setQuotas((current) => ({ ...current, [id]: null }));
    try {
      const response = await fetch(`/api/codex-profile-quota?id=${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error('Quota unavailable');
      const value = await response.json() as ProfileQuota;
      setQuotas((current) => ({ ...current, [id]: value }));
    } catch {
      setQuotas((current) => ({ ...current, [id]: { ok: false, reason: 'fetch_error' } }));
      return;
    } finally { quotaRequests.current.delete(id); }
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

  const status = (profile: CodexProfile) => profile.available === false ? "Profile unavailable"
    : profile.metadataUnavailable ? `Login inspection unavailable: ${profile.metadataReason?.replaceAll('_', ' ') ?? 'unknown'}`
    : profile.signedIn ? "Codex login found"
    : profile.authSource === 'native' ? "Not signed in to Codex"
    : profile.signedInFilePresent ? "Login file found" : "No login file";
  const signInWord = (profile: CodexProfile) => profile.metadataUnavailable ? "Open sign-in command"
    : (profile.authSource === 'native' ? profile.signedIn : profile.signedInFilePresent) ? "Sign in again" : "Sign in";
  const menuProfile = profiles?.find(profile => profile.id === menu) ?? null;
  const pick = (run: () => void) => () => { setMenu(null); run(); };
  const moreGlyph = (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="currentColor" aria-hidden>
      <circle cx="2.8" cy="7" r="1.15" /><circle cx="7" cy="7" r="1.15" /><circle cx="11.2" cy="7" r="1.15" />
    </svg>
  );

  return (
    <section className="ap-codex" aria-label="Codex profiles">
      <div className="ap-codex-head">
        <div className="ap-codex-title">{standalone ? "" : "Codex profiles"}</div>
        <button type="button" className="ap-more" aria-label="Add a Codex account" title="Add a Codex account"
          aria-expanded={adding} onClick={() => setAdding(open => !open)}>
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
            <path d="M7 2.5v9M2.5 7h9" />
          </svg>
        </button>
        <button type="button" id="ap-codex-more-section" className="ap-more" aria-label="More Codex actions" title="More actions"
          aria-haspopup="menu" aria-expanded={menu === "section"} aria-controls={menu === "section" ? "ap-codex-menu" : undefined}
          onClick={() => setMenu(open => open === "section" ? null : "section")}>{moreGlyph}</button>
      </div>
      {error && profiles === null ? <p role="alert" className="ap-codex-hint">Could not load Codex profiles.</p> :
        profiles === null ? <p className="ap-codex-hint">Checking profiles…</p> :
        <>
          {error && <p role="alert" className="ap-codex-hint">Could not refresh Codex profiles. Showing the last roster.</p>}
          <ul className="ap-codex-list">
            {profiles.map((profile) => (
              <li key={profile.id} className="ap-codex-row">
                <div className="ap-codex-line">
                  <span className="ap-codex-name">{profile.label}</span>
                  {profile.active
                    ? <span className="ap-codex-default" title="New sessions start on this account">Default</span>
                    : <button className="ap-switch" type="button" aria-busy={action === profile.id}
                        aria-label={`Use ${profile.label} for new sessions`} title="Use for new sessions"
                        onClick={() => void mutate('select', profile.id)}>Use</button>}
                  <button type="button" id={`ap-codex-more-${profile.id}`} className="ap-more"
                    aria-label={`More actions for ${profile.label}`} title="More actions"
                    aria-haspopup="menu" aria-expanded={menu === profile.id} aria-controls={menu === profile.id ? "ap-codex-menu" : undefined}
                    onClick={() => setMenu(open => open === profile.id ? null : profile.id)}>{moreGlyph}</button>
                </div>
                <span className="ap-codex-hint">{status(profile)}</span>
                {launch[profile.id] && <span className="ap-codex-hint" role="status">{launch[profile.id]}</span>}
                {Object.hasOwn(quotas, profile.id) && (quotas[profile.id] === null
                  ? <span className="ap-codex-hint" role="status">Checking quota…</span>
                  : <span className="ap-codex-hint" role="status">{quotaStatus(
                    (quotas[profile.id]?.ok || quotas[profile.id]?.stale) &&
                    (quotas[profile.id]?.identityVersion ?? quotas[profile.id]?.lastGood?.identityVersion) !== profile.identityVersion
                      ? { ok: false, reason: 'profile_changed' } : quotas[profile.id]!, clock)}</span>)}
              </li>
            ))}
          </ul>
          {adding && (
            <form className="ap-codex-add" onSubmit={event => { event.preventDefault(); void mutate('add'); }}>
              <input required autoFocus className="ap-codex-label" aria-label="New Codex account label" placeholder="Account label"
                value={newLabel} maxLength={80} onChange={event => setNewLabel(event.target.value)} />
              <button className="ap-switch" type="submit" aria-busy={action === 'add'}>Add</button>
            </form>
          )}
          {message && <p className="ap-codex-hint" role="status">{message}</p>}
          {launch.terminal && <p className="ap-codex-hint" role="status">{launch.terminal}</p>}
          <p className="ap-codex-hint" title="Terminal selection needs a one-time setup; an explicit CODEX_HOME takes priority. Codex manages sign-in and renewal. A login file does not guarantee an active session.">
            New sessions use the default. Running ones keep their account.
          </p>
        </>}
      {menu === "section" && (
        <AnchoredPopover anchorId="ap-codex-more-section" id="ap-codex-menu" className="ap-pop" role="menu"
          labelledBy="ap-codex-more-section" onClose={() => setMenu(null)}>
          <button type="button" role="menuitem" className="ap-menu-item"
            title="Copies a one-time setup so the plain codex command follows the default"
            onClick={pick(() => void copyCommand('terminal'))}>Enable terminal selection</button>
          <button type="button" role="menuitem" className="ap-menu-item"
            onClick={pick(() => void copyCommand('terminal', undefined, true))}>Remove terminal selection</button>
        </AnchoredPopover>
      )}
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
            onClick={pick(() => void copyCommand('login', menuProfile.id))}>{signInWord(menuProfile)}</button>
        </AnchoredPopover>
      )}
    </section>
  );
}
