import { useEffect, useRef, useState } from "react";
import { copyText } from "../copy-text";

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

export default function CodexProfilesSection() {
  const [profiles, setProfiles] = useState<CodexProfile[] | null>(null);
  const profileRequest = useRef(0);
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

  async function refreshProfiles(signal?: AbortSignal) {
    const request = ++profileRequest.current;
    const response = await fetch("/api/codex-profiles", { signal });
    if (!response.ok) throw new Error("Unable to load Codex profiles");
    const result = await response.json() as { profiles: CodexProfile[]; revision?: number };
    if (!Array.isArray(result.profiles)) throw new Error("Invalid Codex profiles response");
    if (signal?.aborted || request !== profileRequest.current) return;
    setProfiles(result.profiles);
    setRevision(result.revision ?? 0);
    setError(false);
  }

  useEffect(() => {
    const controller = new AbortController();
    const load = () => {
      const request = profileRequest.current + 1;
      return refreshProfiles(controller.signal).catch(() => {
        if (!controller.signal.aborted && request === profileRequest.current) setError(true);
      });
    };
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);

  return (
    <section className="ap-codex" aria-label="Codex profiles">
      <div className="ap-codex-title">Codex profiles</div>
      {error && profiles === null ? <p role="alert" className="ap-codex-hint">Could not load Codex profiles.</p> :
        profiles === null ? <p className="ap-codex-hint">Checking profiles…</p> :
        <>
          {error && <p role="alert" className="ap-codex-hint">Could not refresh Codex profiles. Showing the last roster.</p>}
          <ul className="ap-codex-list">
            {profiles.map((profile) => (
              <li key={profile.id} className="ap-codex-row">
                <span>{profile.label}{profile.active ? " · Default for new sessions" : ""}</span>
                <span className="ap-codex-hint">{profile.available === false ? "Profile unavailable" : profile.metadataUnavailable ? `Login inspection unavailable: ${profile.metadataReason?.replaceAll('_', ' ') ?? 'unknown'}` : profile.signedIn ? "Codex login found" : profile.authSource === 'native' ? "Not signed in to Codex" : profile.signedInFilePresent ? "Login file found" : "No login file"}</span>
                <button className="ap-codex-check" type="button" aria-pressed={profile.active} aria-busy={action === profile.id} onClick={() => { if (!profile.active) void mutate('select', profile.id); }}>{profile.active ? "Default account" : "Use account"}</button>
                {profile.available !== false && <button className="ap-codex-check" type="button" onClick={() => void checkQuota(profile.id)} aria-busy={Object.hasOwn(quotas, profile.id) && quotas[profile.id] === null}>Check quota</button>}
                <button className="ap-codex-check" type="button" onClick={() => void copyLaunch(profile.id)}>Copy launch command</button>
                <button className="ap-codex-check" type="button" onClick={() => void copyCommand('login', profile.id)}>{profile.metadataUnavailable ? "Open sign-in command" : (profile.authSource === 'native' ? profile.signedIn : profile.signedInFilePresent) ? "Sign in again" : "Sign in"}</button>
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
          <form onSubmit={event => { event.preventDefault(); void mutate('add'); }}>
            <label className="ap-codex-hint">New account label <input required className="ap-codex-label" aria-label="New Codex account label" value={newLabel} maxLength={80} onChange={event => setNewLabel(event.target.value)} /></label>
            <button className="ap-codex-check" type="submit" aria-busy={action === 'add'}>Add Codex account</button>
          </form>
          {message && <p className="ap-codex-hint" role="status">{message}</p>}
          <button className="ap-codex-check" type="button" onClick={() => void copyCommand('terminal')}>Enable terminal selection</button>
          <button className="ap-codex-check" type="button" onClick={() => void copyCommand('terminal', undefined, true)}>Remove terminal selection</button>
          {launch.terminal && <p className="ap-codex-hint" role="status">{launch.terminal}</p>}
          <p className="ap-codex-hint">The default applies to new sessions. Existing sessions keep their account until restarted. Terminal selection needs a one-time setup; an explicit CODEX_HOME takes priority. Codex manages sign-in and renewal. A login file does not guarantee an active session.</p>
        </>}
    </section>
  );
}
