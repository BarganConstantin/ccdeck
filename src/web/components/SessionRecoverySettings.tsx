import { useEffect, useRef, useState } from "react";
import { selfPressAccepted, selfPressProps } from "../panel-press";
import { SettingsGroup, SettingRow } from "./SettingsParts";

/** One switch over one boolean in /api/prefs: what it reads as, saving it, and
 *  what went wrong. `fallback` is the server's default, used when the answer
 *  holds no real boolean for it. */
function usePrefSwitch(key: string, fallback: boolean) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const savingRef = useRef(false);
  const read = (v: unknown) => (typeof v === "boolean" ? v : fallback);
  useEffect(() => {
    let live = true;
    fetch("/api/prefs").then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(d => {
      if (!d.ok) throw new Error();
      if (live) setEnabled(read(d.prefs?.[key]));
    }).catch(() => { if (live) setError("Could not read this setting. Reopen Settings to retry."); });
    return () => { live = false; };
  }, [key]);
  const change = async () => {
    if (enabled === null || !selfPressAccepted(savingRef.current)) return;
    savingRef.current = true; setBusy(true); setError("");
    try {
      const r = await fetch("/api/prefs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ [key]: !enabled }) });
      if (!r.ok) throw new Error();
      const d = await r.json();
      if (!d.ok) throw new Error();
      setEnabled(read(d.prefs[key]));
    } catch { setError("Could not save this setting. Try again."); }
    finally { savingRef.current = false; setBusy(false); }
  };
  return { enabled, busy, error, change };
}

/** This preference applies to the next server start; it never replays tools. */
export default function SessionRecoverySettings({ provider }: { provider: "Codex" | "Claude" }) {
  const key = provider === "Codex" ? "recoverCodexSessions" : "recoverClaudeSessions";
  const settingId = `${provider.toLowerCase()}-session-recovery`;
  const recover = usePrefSwitch(key, true);
  return <SettingsGroup id={`${settingId}-title`} title={`${provider} sessions`} note="Choose what appears after ccdeck starts.">
    <SettingRow settingId={settingId} name="Restore unfinished sessions" note={provider === "Codex" ? "Find unfinished turns in recent local Codex logs on the next start. A missing ending does not confirm the process is still running." : "On the next start, find busy local Claude sessions whose process identity can be verified."} control={
      <button type="button" className="switch" role="switch" aria-label={`Restore unfinished ${provider} sessions`} aria-checked={recover.enabled === true} {...selfPressProps(recover.busy, recover.enabled === null)} onClick={() => { void recover.change(); }}><span className="switch-knob" /></button>
    } />
    {recover.error && <p role="alert">{recover.error}</p>}
    {provider === "Claude" && <ContinueStoppedRow />}
  </SettingsGroup>;
}

/** Continue stopped background sessions by themselves (#2193): OFF until it is
 *  turned on, the server's default (deck-prefs.mjs `continueStopped`). */
function ContinueStoppedRow() {
  const pref = usePrefSwitch("continueStopped", false);
  return <>
    <SettingRow settingId="claude-continue-stopped" name="Continue stopped background sessions" note="When a background session stops on an expired login or a usage limit, continue it once a working login with room is active. Once per stop; a session that stops again right after waits for you." control={
      <button type="button" className="switch" role="switch" aria-label="Continue stopped background sessions automatically" aria-checked={pref.enabled === true} {...selfPressProps(pref.busy, pref.enabled === null)} onClick={() => { void pref.change(); }}><span className="switch-knob" /></button>
    } />
    {pref.error && <p role="alert">{pref.error}</p>}
  </>;
}
