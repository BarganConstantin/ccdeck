// Browser Watch's settings: the quiet gate, the reaction to a finding, and
// what the watch can and cannot read, behind the footer's gear.
//
// Lifted out of BrowserWatchModal.tsx unchanged. Both selects write through the
// dialog's `save`, and the quiet select shows the dialog's `quiet` — the value
// just picked while its save is out, the stored one otherwise. Whether "What
// Browser Watch can access" is expanded is the dialog's state too: this panel
// unmounts when the gear closes it, and the disclosure is still open the next
// time it does.
import type { Dispatch, SetStateAction } from "react";

import { logBytesLabel, type WatchSettings, type WatchSnapshot } from "../browser-watch-model";
import { currentLanguage, useT } from "../i18n";
import { richText } from "./settings-rich";

export default function BrowserWatchSettings({
  snap,
  quiet,
  setQuiet,
  save,
  access,
  setAccess,
}: {
  snap: WatchSnapshot;
  quiet: number | null;
  setQuiet: (minutes: number | null) => void;
  save: (patch: Partial<WatchSettings>) => Promise<void>;
  access: boolean;
  setAccess: Dispatch<SetStateAction<boolean>>;
}) {
  const t = useT();
  return (
    <div className="bw-settings">
      <label title={t("settings.bw.quiet.tip")}>
        <span>{t("settings.bw.quiet.label")}</span>
        <select value={quiet ?? snap.settings.quietMinutes} onChange={e => { setQuiet(Number(e.target.value)); void save({ quietMinutes: Number(e.target.value) }); }}>
          {[1, 5, 15, 30, 60].map(n => <option key={n} value={n}>{t("settings.bw.minutes", { n })}</option>)}
        </select>
      </label>

      <label>
        <span>{t("settings.bw.reaction.label")}</span>
        <select
          value={snap.settings.reaction}
          onChange={e => void save({ reaction: e.target.value as WatchSettings["reaction"] })}
          disabled={!snap.settings.enabled}
          title={snap.settings.enabled
            ? t("settings.bw.reaction.hintOn")
            : t("settings.bw.reaction.hintOff")}
        >
          {(snap.reactions ?? ["notify"]).map(r => (
            <option key={r} value={r}>
              {r === "notify" ? t("settings.bw.reaction.notify")
                : r === "close-tab" ? t("settings.bw.reaction.closeTab")
                : t("settings.bw.reaction.quit")}
            </option>
          ))}
        </select>
      </label>

      <div className="bw-settings-note">
        <p>
          {t("settings.bw.note.chrome")} <strong>{t("settings.bw.note.usually")}</strong>
        </p>
        <button className="bw-why" onClick={() => setAccess(a => !a)} aria-expanded={access}>
          <span className="bw-chev" aria-hidden>{access ? "▾" : "▸"}</span> {t("settings.bw.access.toggle")}
        </button>
        {access && (
          <dl className="bw-access">
            <dt>{t("settings.bw.access.reads")}</dt>
            <dd>{t("settings.bw.access.readsText", { when: new Date(snap.coverage.startedMs).toLocaleString(currentLanguage()) })}</dd>
            <dt>{t("settings.bw.access.keeps")}</dt>
            <dd>
              {richText(t("settings.bw.access.keepsText", {
                path: "{path}",
                size: typeof snap.coverage.logBytes === "number" ? ` (${logBytesLabel(snap.coverage.logBytes)})` : "",
              }), { path: <code className="bw-path">{snap.coverage.logPath}</code> })}
            </dd>
            <dt>{t("settings.bw.access.sends")}</dt>
            <dd>{t("settings.bw.access.sendsText")}</dd>
            <dt>{t("settings.bw.access.never")}</dt>
            <dd>{t("settings.bw.access.neverText")}</dd>
          </dl>
        )}
      </div>
    </div>
  );
}
