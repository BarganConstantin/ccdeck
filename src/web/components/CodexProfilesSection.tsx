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

function resetLabel(resetAt: number | null): string {
  if (!resetAt) return '';
  const at = new Date(resetAt * 1000);
  return `, resets ${at.toLocaleDateString(undefined, { weekday: 'short' })} ${at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

function quotaSummary(quota: ProfileQuota, now: number): string {
  const windows = quota.windows?.map((w) => `${Math.round(w.usedPercent)}% used (${w.seconds ? `${Math.round(w.seconds / 3600)}h` : 'window'}${resetLabel(w.resetAt)})`).join(' · ');
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

const OPEN_KEY = "ccdeck.codexProfilesOpen";

function storedOpen(): boolean {
  try { return localStorage.getItem(OPEN_KEY) === "1"; } catch { return false; }
}

function foldLine(profiles: CodexProfile[] | null, quotas: Record<string, ProfileQuota | null>): string {
  if (profiles === null) return "Checking profiles…";
  const parts = profiles.map(profile => {
    const name = profile.label.split(/[@·]/)[0].trim();
    const quota = quotas[profile.id];
    const used = quota?.ok && quota.identityVersion === profile.identityVersion ? quota.windows?.[0]?.usedPercent : undefined;
    return used === undefined ? name : `${name} ${Math.round(used)}%`;
  });
  return [`${profiles.length} ${profiles.length === 1 ? "account" : "accounts"}`, ...parts].join(" · ");
}

export default function CodexProfilesSection({ autoQuota = true, initiallyOpen }: { autoQuota?: boolean; initiallyOpen?: boolean } = {}) {
  const [open, setOpen] = useState(() => initiallyOpen ?? storedOpen());
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

  // Background reads keep the last reading on screen and skip the roster refresh.
  async function checkQuota(id: string, background = false) {
    if (quotaRequests.current.has(id)) return;
    quotaRequests.current.add(id);
    if (!background) setQuotas((current) => ({ ...current, [id]: null }));
    try {
      const response = await fetch(`/api/codex-profile-quota?id=${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error('Quota unavailable');
      const value = await response.json() as ProfileQuota;
      setQuotas((current) => ({ ...current, [id]: value }));
    } catch {
      setQuotas((current) => background && current[id]?.ok ? current : ({ ...current, [id]: { ok: false, reason: 'fetch_error' } }));
      return;
    } finally { quotaRequests.current.delete(id); }
    if (background) return;
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

  const quotaIds = profiles?.filter(profile => profile.available !== false).map(profile => profile.id).join(',') ?? '';
  useEffect(() => {
    if (!autoQuota || !quotaIds) return;
    const ids = quotaIds.split(',');
    const read = () => { for (const id of ids) void checkQuota(id, true); };
    read();
    // The server caches each profile's reading for 60s, so this is one request per profile per minute at most.
    const timer = setInterval(read, 60_000);
    return () => clearInterval(timer);
  }, [autoQuota, quotaIds]);

  function toggle() {
    setOpen(current => {
      try { localStorage.setItem(OPEN_KEY, current ? "0" : "1"); } catch { /* per-viewer convenience only */ }
      return !current;
    });
  }

  return (
    <section className="ap-codex" aria-label="Codex profiles">
      <div className="ap-rest">
        <button type="button" className="ap-nav" aria-expanded={open} aria-controls={open ? "ap-codex-body" : undefined} onClick={toggle}>
          <span className="ap-nav-text">
            <span className="ap-nav-name">Codex profiles</span>
            <span className="ap-nav-state">{error && profiles === null ? "Could not load" : foldLine(profiles, quotas)}</span>
          </span>
          <svg className="ap-nav-chev" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
            strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M5.6 3.4 9.2 7l-3.6 3.6" />
          </svg>
        </button>
      </div>
      {open && <div className="ap-codex-body" id="ap-codex-body">
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
      </div>}
    </section>
  );
}
