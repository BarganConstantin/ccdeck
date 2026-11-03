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

import { workspaceOffered } from "../use-view";
import { SettingRow, SettingsGroup } from "./SettingsParts";
import { useT, type TFunction } from "../i18n";

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
      </div>
      {unsupported && <p className="settings-note" id="settings-terminal-unavailable">{t("settings.terminal.unsupported")}</p>}
    </SettingsGroup>
  );
}
