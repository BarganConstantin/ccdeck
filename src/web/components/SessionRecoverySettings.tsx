import { useEffect, useRef, useState } from "react";
import { SettingsGroup, SettingRow } from "./SettingsParts";

/** This preference applies to the next server start; it never replays tools. */
export default function SessionRecoverySettings({ provider }: { provider: "Codex" | "Claude" }) {
  const key = provider === "Codex" ? "recoverCodexSessions" : "recoverClaudeSessions";
  const settingId = `${provider.toLowerCase()}-session-recovery`;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saving = useRef(false);
  useEffect(() => {
    let live = true;
    fetch("/api/prefs").then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(d => {
      if (!d.ok) throw new Error();
      if (live) setEnabled(d.prefs?.[key] !== false);
    }).catch(() => { if (live) setError("Could not read this setting. Reopen Settings to retry."); });
    return () => { live = false; };
  }, [key]);
  const change = async () => {
    if (enabled === null || saving.current) return;
    saving.current = true; setBusy(true); setError("");
    try {
      const r = await fetch("/api/prefs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ [key]: !enabled }) });
      if (!r.ok) throw new Error();
      const d = await r.json();
      if (!d.ok) throw new Error();
      setEnabled(d.prefs[key] !== false);
    } catch { setError("Could not save this setting. Try again."); }
    finally { saving.current = false; setBusy(false); }
  };
  return <SettingsGroup id={`${settingId}-title`} title={`${provider} sessions`} note="Choose what appears after ccdeck starts.">
    <SettingRow settingId={settingId} name="Restore unfinished sessions" note={provider === "Codex" ? "Find unfinished turns in recent local Codex logs on the next start. A missing ending does not confirm the process is still running." : "On the next start, find busy local Claude sessions whose process identity can be verified."} control={
      <button type="button" className="switch" role="switch" aria-label={`Restore unfinished ${provider} sessions`} aria-checked={enabled === true} disabled={enabled === null || busy} aria-busy={busy} onClick={() => { void change(); }}><span className="switch-knob" /></button>
    } />
    {error && <p role="alert">{error}</p>}
  </SettingsGroup>;
}
