import { useEffect, useState } from "react";

interface CodexProfile {
  id: string;
  label: string;
  active: boolean;
  signedInFilePresent: boolean;
}

export default function CodexProfilesSection() {
  const [profiles, setProfiles] = useState<CodexProfile[] | null>(null);
  const [error, setError] = useState(false);

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
              </li>
            ))}
          </ul>
          <p className="ap-codex-hint">Profiles are read-only for now. A login file does not guarantee an active session.</p>
        </>}
    </section>
  );
}
