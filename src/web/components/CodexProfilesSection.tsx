import { useEffect, useRef, useState } from "react";
import { copyText } from "../copy-text";
import { readStored, writeStored } from "../storage";

const SELECTED_CODEX_PROFILE_KEY = "agent-dag.codex.selectedProfile";

interface CodexProfile {
  id: string;
  label: string;
  identityVersion: string;
  active: boolean;
  signedInFilePresent: boolean;
}

interface ProfileQuota {
  ok: boolean;
  identityVersion?: string;
  reason?: string;
  stale?: boolean;
  lastGood?: ProfileQuota;
  fetchedAt?: number;
  plan?: string | null;
  windows?: { usedPercent: number; seconds: number | null; resetAt: number | null }[];
}

function quotaSummary(quota: ProfileQuota, now: number): string {
  const windows = quota.windows?.map((w) => `${Math.round(w.usedPercent)}% used (${w.seconds ? `${Math.round(w.seconds / 3600)}h` : 'window'})`).join(' · ');
  const age = quota.fetchedAt ? ` · Read ${Math.max(0, Math.floor((now - quota.fetchedAt) / 1000))}s ago` : '';
  return `${quota.plan ?? 'Codex'} · ${windows || 'No limits reported'}${age}`;
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
  const [selectedId, setSelectedId] = useState(() => readStored(SELECTED_CODEX_PROFILE_KEY) ?? "");
  const [clock, setClock] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  function selectProfile(id: string) {
    setSelectedId(id);
    writeStored(SELECTED_CODEX_PROFILE_KEY, id);
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
    const result = await response.json() as { profiles: CodexProfile[] };
    if (!Array.isArray(result.profiles)) throw new Error("Invalid Codex profiles response");
    if (signal?.aborted || request !== profileRequest.current) return;
    setProfiles(result.profiles);
    setError(false);
    setSelectedId(current => result.profiles.some(profile => profile.id === current) ? current : result.profiles[0]?.id ?? "");
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
                <span>{profile.label}{profile.active ? " · Server default" : ""}{selectedId === profile.id ? " · Launch target" : ""}</span>
                <span className="ap-codex-hint">{profile.signedInFilePresent ? "Login file found" : "No login file"}</span>
                <button className="ap-codex-check" type="button" disabled={selectedId === profile.id} onClick={() => selectProfile(profile.id)}>{selectedId === profile.id ? "Launch target" : "Choose for new CLI"}</button>
                {profile.signedInFilePresent && <button className="ap-codex-check" type="button" onClick={() => void checkQuota(profile.id)} aria-busy={Object.hasOwn(quotas, profile.id) && quotas[profile.id] === null}>Check quota</button>}
                {selectedId === profile.id && <button className="ap-codex-check" type="button" onClick={() => void copyLaunch(profile.id)}>Copy launch command</button>}
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
          <p className="ap-codex-hint">Choose a launch target and copy its command into a terminal to start a new Codex CLI session. This browser choice does not switch running sessions, server defaults, or credentials. A login file does not guarantee an active session.</p>
        </>}
    </section>
  );
}
