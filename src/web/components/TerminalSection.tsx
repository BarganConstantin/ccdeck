// Settings › General › Experimental: the Command Panel's switch (use-stage.ts), on
// until somebody turns it off. The panel lets a session be opened beside the
// board and typed into. Its words are in the settings catalogs, in every
// language: the name is the one Settings search already carries
// (settings.search.commandPanel), the notes are settings.terminal.*.
//
// In the shared shape (SettingsParts.tsx, #2176): one row in a group called
// Experimental, at the foot of Settings › General (V4 draws no tab of its own
// for it), the row's note saying so again in one line. The switch is the only
// way off; no launch variable turns it on or off.
//
// OFF CLOSES THE PANEL, NOT ITS SESSIONS. A session the panel started keeps
// running with the switch off — in tmux on Linux and macOS, in the session
// host in the Windows preview — and is there again once it is on, so the note
// says that much in plain words: the reader deciding whether to turn it off is
// deciding about a window, not about their agents.
//
// The panel runs on Linux, macOS and Windows. Where a deck's platform has none
// the switch is drawn off and fixed, and a note under the row says so — though
// never fixed on: a settings file carried over from another machine can still
// be switched off. The deck says which (`terminalSupported` in /api/prefs), not
// the browser, since the panel runs where the deck does; until it has said, the
// switch is offered as usual.

import { useState, type ReactNode } from "react";
import { workspaceOffered } from "../use-view";
import { SettingRow, SettingsGroup } from "./SettingsParts";
import { useT, type TFunction } from "../i18n";
import { mb, olderVersion, platformLabel } from "../engine-install-api";
import { useEngineInstall } from "../use-engine-install";

export interface TerminalSwitch {
  /** The Command Panel is on now. */
  on: boolean;
  /** Whether the deck's platform has the panel; null until the deck has said. */
  supported: boolean | null;
  /** Its sessions run in the Windows session host (`terminalWindows` in
   *  /api/prefs), so the note names that as where they keep running. */
  windows?: boolean;
  /** The window is a phone's, which is the Board alone: no Workspace, so no
   *  chord to name (App's PHONE_QUERY). */
  phone?: boolean;
  /** The stage's chunk would not load, so Workspace is not on offer. */
  failed?: boolean;
  toggle: () => void;
}

/** Whether the key sheet and Settings name Workspace's chord: where Workspace
 *  is on offer at all, so never on a phone. */
export function offersWorkspace(terminal: TerminalSwitch | undefined): boolean {
  return terminal != null && workspaceOffered({ enabled: terminal.on, supported: terminal.supported }, terminal.phone === true) && terminal.failed !== true;
}

/** The note under the row's name, in the reader's language: the platform's
 *  answer when it has no panel, else where the sessions keep running. */
export function terminalNote(t: TFunction, supported: boolean | null, windows = false): string {
  if (supported === false) return t("settings.terminal.unsupported");
  return t(windows ? "settings.terminal.noteWindows" : "settings.terminal.note");
}

/**
 * The engine under the switch, while it is on (Figma "Settings › Terminal"):
 * which version is here and that it verified, Check for an update, Remove
 * (it installs again the next time a terminal opens), Install where it is
 * missing, and an install's progress with Cancel. The deck's status is read
 * only while the switch is on: off, the route is not there.
 */
export function EngineRows() {
  const t = useT();
  const eng = useEngineInstall(true);
  const [upToDate, setUpToDate] = useState(false);
  const s = eng.status;
  if (!s || !s.supported) return null;
  const platform = platformLabel(s.platform);
  const job = s.job;
  const canDownload = s.blocked === null;
  const newer = !!s.installed && !!s.pinned && olderVersion(s.installed.version, s.pinned);
  const lastFailed = s.last?.outcome === "failed" && eng.watched.has(s.last.id);
  let note: string;
  let control: ReactNode = null;
  let progress: ReactNode = null;
  if (job) {
    const ours = job.id === eng.mine;
    note = !ours ? t("settings.terminal.engine.elsewhere")
      : s.installed && s.pinned ? t("settings.terminal.engine.updating", { from: s.installed.version, to: s.pinned })
        : t("settings.terminal.engine.installing", { version: s.pinned ?? "" });
    if (job.phase === "downloading") {
      const share = job.total ? Math.min(1, job.received / job.total) : null;
      const line = job.total ? t("board.stage.setupProgress", { received: mb(job.received), total: mb(job.total) }) : t("board.stage.setupReceived", { received: mb(job.received) });
      progress = (
        <span className="settings-engine-progress">
          <span className="ts-setup-bar ts-eng-bar" role="progressbar" aria-label={note} aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={share == null ? undefined : Math.round(share * 100)} aria-valuetext={line} data-unknown={share == null || undefined}>
            <i className="ts-setup-fill" style={share == null ? undefined : { transform: `scaleX(${share})` }} />
          </span>
          <span className="ts-eng-mono">{line}</span>
        </span>
      );
      if (ours) control = <button type="button" className="btn" aria-busy={eng.pending || undefined} onClick={() => { void eng.cancel(); }}>{t("common.cancel")}</button>;
    }
  } else if (s.elsewhere) {
    note = t("settings.terminal.engine.elsewhere");
  } else if (s.installed) {
    note = t("settings.terminal.engine.verified", { version: s.installed.version, platform });
    control = (
      <button
        type="button" className="btn" aria-busy={eng.pending || undefined}
        onClick={() => {
          if (newer && canDownload) { void eng.install(); return; }
          void eng.refresh().then(() => { setUpToDate(true); setTimeout(() => setUpToDate(false), 2000); });
        }}
      >
        {upToDate ? t("settings.terminal.engine.upToDate") : t("settings.terminal.engine.checkUpdate")}
      </button>
    );
  } else if (s.blocked === "no-keys" || s.blocked === "not-published") {
    note = t("settings.terminal.engine.notAvailable");
  } else {
    note = t("settings.terminal.engine.notInstalled");
    if (canDownload) control = <button type="button" className="btn primary" aria-busy={eng.pending || undefined} onClick={() => { void eng.install(); }}>{t("settings.terminal.engine.install")}</button>;
  }
  if (lastFailed && !job) note = `${note} ${t("settings.terminal.engine.failed")}`;
  return (
    <>
      <SettingRow as="div" settingId="terminal-engine" name={t("settings.terminal.engine.name")} nameId="settings-engine-label" note={note} noteId="settings-engine-note" control={control}>
        {progress}
      </SettingRow>
      {s.installed && !job && (
        <SettingRow
          as="div" settingId="terminal-engine-remove" name={t("settings.terminal.engine.removeName")}
          note={t("settings.terminal.engine.removeNote", { size: mb(s.installed.bytes) })}
          control={<button type="button" className="btn" aria-busy={eng.pending || undefined} onClick={() => { void eng.remove(); }}>{t("settings.terminal.engine.remove")}</button>}
        />
      )}
    </>
  );
}

export default function TerminalSection({ terminal }: { terminal: TerminalSwitch }) {
  const t = useT();
  const fixed = terminal.supported === false && !terminal.on;
  // Where the panel is not available the row keeps its own words and the
  // platform's answer stands under it as a note, as V4 draws it.
  const unsupported = terminal.supported === false;
  return (
    <SettingsGroup id="settings-experimental-caption" title={t("settings.experimental.group")} list={false}>
      <div className="settings-list">
        <SettingRow
          settingId="terminal"
          name={t("settings.search.commandPanel")}
          nameId="settings-terminal-label"
          note={terminalNote(t, null, terminal.windows)}
          noteId="settings-terminal-note"
          control={
            <button
              type="button"
              className="switch"
              role="switch"
              aria-checked={terminal.on}
              aria-labelledby="settings-terminal-label"
              aria-describedby={unsupported ? "settings-terminal-note settings-terminal-unavailable" : "settings-terminal-note"}
              disabled={fixed}
              onClick={terminal.toggle}
            >
              <span className="switch-knob" />
            </button>
          }
        />
        {terminal.on && !unsupported && <EngineRows />}
      </div>
      {unsupported &&<p className="settings-note" id="settings-terminal-unavailable">{t("settings.terminal.unsupported")}</p>}
    </SettingsGroup>
  );
}
