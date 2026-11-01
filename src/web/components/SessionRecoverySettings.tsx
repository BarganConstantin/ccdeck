import { useEffect, useRef, useState } from "react";
import { selfPressAccepted, selfPressProps } from "../panel-press";
import { SettingsGroup, SettingRow } from "./SettingsParts";
import { useT, type TFunction } from "../i18n";

/** One switch over one boolean in /api/prefs: what it reads as, saving it, and
 *  what went wrong. `fallback` is the server's default, used when the answer
 *  holds no real boolean for it. */
function usePrefSwitch(key: string, fallback: boolean, t: TFunction) {
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
    }).catch(() => { if (live) setError(t("settings.recover.readFail")); });
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
    } catch { setError(t("settings.recover.saveFail")); }
    finally { savingRef.current = false; setBusy(false); }
  };
  return { enabled, busy, error, change };
}

/** This preference applies to the next server start; it never replays tools. */
export default function SessionRecoverySettings({ provider }: { provider: "Codex" | "Claude" }) {
  const key = provider === "Codex" ? "recoverCodexSessions" : "recoverClaudeSessions";
  const settingId = `${provider.toLowerCase()}-session-recovery`;
  const t = useT();
  const recover = usePrefSwitch(key, true, t);
  return <SettingsGroup id={`${settingId}-title`} title={t("settings.recover.group", { provider })}>
    <SettingRow settingId={settingId} name={t("settings.recover.name")} note={provider === "Codex" ? t("settings.recover.codexNote") : t("settings.recover.claudeNote")} details={provider === "Codex" ? t("settings.recover.codexDetails") : t("settings.recover.claudeDetails")} control={
      <button type="button" className="switch" role="switch" aria-label={provider === "Codex" ? t("settings.recover.codexAria") : t("settings.recover.claudeAria")} aria-checked={recover.enabled === true} {...selfPressProps(recover.busy, recover.enabled === null)} onClick={() => { void recover.change(); }}><span className="switch-knob" /></button>
    } />
    {recover.error && <p role="alert">{recover.error}</p>}
    {provider === "Claude" && <ContinueStoppedRow t={t} />}
  </SettingsGroup>;
}

/** Continue stopped background sessions by themselves (#2193): OFF until it is
 *  turned on, the server's default (deck-prefs.mjs `continueStopped`). */
function ContinueStoppedRow({ t }: { t: TFunction }) {
  const pref = usePrefSwitch("continueStopped", false, t);
  return <>
    <SettingRow settingId="claude-continue-stopped" name={t("settings.recover.continueName")} note={t("settings.recover.continueNote")} details={t("settings.recover.continueDetails")} control={
      <button type="button" className="switch" role="switch" aria-label={t("settings.recover.continueAria")} aria-checked={pref.enabled === true} {...selfPressProps(pref.busy, pref.enabled === null)} onClick={() => { void pref.change(); }}><span className="switch-knob" /></button>
    } />
    {pref.error && <p role="alert">{pref.error}</p>}
  </>;
}
