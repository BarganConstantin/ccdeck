import { useEffect, useState } from "react";
import { copyText } from "../copy-text";

interface CodexProfile {
  id: string;
  label: string;
  active: boolean;
  signedInFilePresent: boolean;
}

interface ProfileQuota {
  ok: boolean;
  reason?: string;
  plan?: string | null;
  windows?: { usedPercent: number; seconds: number | null; resetAt: number | null }[];
}

export default function CodexProfilesSection() {
  const [profiles, setProfiles] = useState<CodexProfile[] | null>(null);
  const [error, setError] = useState(false);
  const [quotas, setQuotas] = useState<Record<string, ProfileQuota | null>>({});
  const [launch, setLaunch] = useState<Record<string, string>>({});

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
    setQuotas((current) => ({ ...current, [id]: null }));
    try {
      const response = await fetch(`/api/codex-profile-quota?id=${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error('Quota unavailable');
      const value = await response.json() as ProfileQuota;
      setQuotas((current) => ({ ...current, [id]: value }));
    } catch {
      setQuotas((current) => ({ ...current, [id]: { ok: false, reason: 'fetch_error' } }));
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/codex-profiles", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Unable to load Codex profiles");
        return response.json() as Promise<{ profiles: CodexProfile[] }>;
      })
      .then((result) => {
        if (!Array.isArray(result.profiles)) throw new Error("Invalid Codex profiles response");
        if (!controller.signal.aborted) setProfiles(result.profiles);
      })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, []);

  return (
    <section className="ap-codex" aria-label="Codex profiles">
      <div className="ap-codex-title">Codex profiles</div>
      {error ? <p role="alert" className="ap-codex-hint">Could not load Codex profiles.</p> :
        profiles === null ? <p className="ap-codex-hint">Checking profiles…</p> :
        <>
          <ul className="ap-codex-list">
            {profiles.map((profile) => (
              <li key={profile.id} className="ap-codex-row">
                <span>{profile.label}{profile.active ? " · Current" : ""}</span>
                <span className="ap-codex-hint">{profile.signedInFilePresent ? "Login file found" : "No login file"}</span>
                {profile.signedInFilePresent && <button className="ap-codex-check" type="button" onClick={() => void checkQuota(profile.id)} disabled={Object.hasOwn(quotas, profile.id) && quotas[profile.id] === null}>Check quota</button>}
                <button className="ap-codex-check" type="button" onClick={() => void copyLaunch(profile.id)}>Copy launch command</button>
                {launch[profile.id] && <span className="ap-codex-hint" role="status">{launch[profile.id]}</span>}
                {Object.hasOwn(quotas, profile.id) && (quotas[profile.id] === null
                  ? <span className="ap-codex-hint" role="status">Checking quota…</span>
                  : quotas[profile.id]?.ok
                    ? <span className="ap-codex-hint">{quotas[profile.id]?.plan ?? 'Codex'} · {quotas[profile.id]?.windows?.map((w) => `${Math.round(w.usedPercent)}% used (${w.seconds ? `${Math.round(w.seconds / 3600)}h` : 'window'})`).join(' · ') || 'No limits reported'}</span>
                    : <span className="ap-codex-hint" role="status">Quota unavailable: {quotas[profile.id]?.reason?.replaceAll('_', ' ')}</span>)}
              </li>
            ))}
          </ul>
          <p className="ap-codex-hint">Launch commands start a separate Codex session in your terminal. Existing sessions stay on their current account. A login file does not guarantee an active session.</p>
        </>}
    </section>
  );
}
