import { useEffect, useRef, useState } from "react";
import { selfPressAccepted, selfPressProps } from "../panel-press";
import { SettingRow } from "./SettingsParts";
import { useT, type TFunction } from "../i18n";
import { useOptimisticSwitch } from "../use-optimistic-switch";
import { refuseSave, setSettingsFailure } from "../settings-failure";

/** One switch over one boolean in /api/prefs: what it reads as, saving it, and
 *  what went wrong. `fallback` is the server's default, used when the answer
 *  holds no real boolean for it. A refused save is said once, under the page
 *  head (settings-failure.ts), with the server's answer so the line can offer
 *  the repair it names. */
function usePrefSwitch(key: string, fallback: boolean, t: TFunction) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const savingRef = useRef(false);
  const read = (v: unknown) => (typeof v === "boolean" ? v : fallback);
  useEffect(() => {
    let live = true;
    fetch("/api/prefs").then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(d => {
      if (!d.ok) throw new Error();
      if (live) setEnabled(read(d.prefs?.[key]));
    }).catch(() => { if (live) setError(t("settings.recover.readFail")); });
    return () => { live = false; };
  }, [key]);
  /** The write behind the flip: true when the server took it. */
  const write = async (next: boolean) => {
    savingRef.current = true;
    try {
      const r = await fetch("/api/prefs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ [key]: next }) });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d?.ok) { refuseSave(d, t); return false; }
      setEnabled(read(d.prefs?.[key]));
      setSettingsFailure(null);
      return true;
    } catch { refuseSave(null, t); return false; }
    finally { savingRef.current = false; }
  };
  const flip = useOptimisticSwitch(enabled, write);
  const change = () => {
    if (enabled === null || !selfPressAccepted(savingRef.current)) return;
    void flip.flip();
  };
  return { enabled: flip.checked, ready: enabled !== null, error, change };
}

/** Bring back the sessions a restart interrupted, one row per provider: busy
 *  Claude sessions, unfinished Codex turns. The preference applies to the next
 *  server start; it never replays tools. Drawn in General's Sessions group
 *  (SessionsSection.tsx). */
export default function SessionRecoveryRow({ provider }: { provider: "Codex" | "Claude" }) {
  const key = provider === "Codex" ? "recoverCodexSessions" : "recoverClaudeSessions";
  const settingId = `${provider.toLowerCase()}-session-recovery`;
  const t = useT();
  const recover = usePrefSwitch(key, true, t);
  const nameId = `settings-${settingId}-name`, noteId = `settings-${settingId}-note`;
  return <>
    <SettingRow settingId={settingId}
      name={provider === "Codex" ? t("settings.recover.codexName") : t("settings.recover.claudeName")} nameId={nameId}
      note={provider === "Codex" ? t("settings.recover.codexNote") : t("settings.recover.claudeNote")} noteId={noteId}
      details={provider === "Codex" ? t("settings.recover.codexDetails") : t("settings.recover.claudeDetails")} control={
      <button type="button" className="switch" role="switch" aria-labelledby={nameId} aria-describedby={noteId} aria-checked={recover.enabled} {...selfPressProps(false, !recover.ready)} onClick={recover.change}><span className="switch-knob" /></button>
    } />
    {recover.error && <p role="alert">{recover.error}</p>}
  </>;
}

/** Continue stopped background sessions by themselves (#2193): OFF until it is
 *  turned on, the server's default (deck-prefs.mjs `continueStopped`). Claude's,
 *  and last in the Sessions group, after Codex's row. */
export function ContinueStoppedRow() {
  const t = useT();
  const pref = usePrefSwitch("continueStopped", false, t);
  return <>
    <SettingRow settingId="claude-continue-stopped" name={t("settings.recover.continueName")} note={t("settings.recover.continueNote")} details={t("settings.recover.continueDetails")} control={
      <button type="button" className="switch" role="switch" aria-label={t("settings.recover.continueAria")} aria-checked={pref.enabled} {...selfPressProps(false, !pref.ready)} onClick={pref.change}><span className="switch-knob" /></button>
    } />
    {pref.error && <p role="alert">{pref.error}</p>}
  </>;
}
