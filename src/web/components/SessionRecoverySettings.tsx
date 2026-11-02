import { useEffect, useRef, useState } from "react";
import { selfPressAccepted, selfPressProps } from "../panel-press";
import { SettingsGroup, SettingRow } from "./SettingsParts";
import { useT, type TFunction } from "../i18n";
import { useOptimisticSwitch } from "../use-optimistic-switch";
import { WriteState } from "./WriteState";

/** One switch over one boolean in /api/prefs: what it reads as, saving it, and
 *  what went wrong. `fallback` is the server's default, used when the answer
 *  holds no real boolean for it. */
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
      if (!r.ok) return false;
      const d = await r.json();
      if (!d.ok) return false;
      setEnabled(read(d.prefs[key]));
      return true;
    } catch { return false; }
    finally { savingRef.current = false; }
  };
  const flip = useOptimisticSwitch(enabled, write);
  const change = () => {
    if (enabled === null || !selfPressAccepted(savingRef.current)) return;
    void flip.flip();
  };
  return { enabled: flip.checked, ready: enabled !== null, error, failed: flip.failed, change };
}

/** This preference applies to the next server start; it never replays tools. */
export default function SessionRecoverySettings({ provider }: { provider: "Codex" | "Claude" }) {
  const key = provider === "Codex" ? "recoverCodexSessions" : "recoverClaudeSessions";
  const settingId = `${provider.toLowerCase()}-session-recovery`;
  const t = useT();
  const recover = usePrefSwitch(key, true, t);
  return <SettingsGroup id={`${settingId}-title`} title={t("settings.recover.group", { provider })}>
    <SettingRow settingId={settingId} name={t("settings.recover.name")} note={provider === "Codex" ? t("settings.recover.codexNote") : t("settings.recover.claudeNote")} details={provider === "Codex" ? t("settings.recover.codexDetails") : t("settings.recover.claudeDetails")} control={
      <button type="button" className="switch" role="switch" aria-label={provider === "Codex" ? t("settings.recover.codexAria") : t("settings.recover.claudeAria")} aria-checked={recover.enabled} {...selfPressProps(false, !recover.ready)} onClick={recover.change}><span className="switch-knob" /></button>
    } />
    {recover.error && <p role="alert">{recover.error}</p>}
    {recover.failed && <WriteState state="failed" role="alert" sentence={t("settings.recover.saveFail")} />}
    {provider === "Claude" && <ContinueStoppedRow t={t} />}
  </SettingsGroup>;
}

/** Continue stopped background sessions by themselves (#2193): OFF until it is
 *  turned on, the server's default (deck-prefs.mjs `continueStopped`). */
function ContinueStoppedRow({ t }: { t: TFunction }) {
  const pref = usePrefSwitch("continueStopped", false, t);
  return <>
    <SettingRow settingId="claude-continue-stopped" name={t("settings.recover.continueName")} note={t("settings.recover.continueNote")} details={t("settings.recover.continueDetails")} control={
      <button type="button" className="switch" role="switch" aria-label={t("settings.recover.continueAria")} aria-checked={pref.enabled} {...selfPressProps(false, !pref.ready)} onClick={pref.change}><span className="switch-knob" /></button>
    } />
    {pref.error && <p role="alert">{pref.error}</p>}
    {pref.failed && <WriteState state="failed" role="alert" sentence={t("settings.recover.saveFail")} />}
  </>;
}
