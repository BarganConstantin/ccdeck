// Settings › Experimental: the Command Panel's switch (use-stage.ts), off on
// every deck until somebody turns it on. The panel lets a session be opened
// beside the board and typed into.
//
// In the shared shape (SettingsParts.tsx, #2176), as Radar's master switch is:
// one row in an untitled group, the section's name saying it is experimental
// and the row's note saying so again in one line. The switch is the only way
// on; no launch variable turns it on.
//
// OFF CLOSES THE PANEL, NOT ITS SESSIONS. A session the panel started keeps
// running with the switch off — in tmux on Linux and macOS, in the session
// host in the Windows preview — and is there again once it is on, so the note
// says that much in plain words: the reader deciding whether to turn it off is
// deciding about a window, not about their agents.
//
// The panel runs on Linux and macOS only for now. Elsewhere the switch is drawn
// off and fixed, and says so — though never fixed on: a settings file carried
// over from a Linux or macOS machine can still be switched off. The deck says which
// (`terminalSupported` in /api/prefs), not the browser, since the panel runs
// where the deck does; until it has said, the switch is offered as usual.

import { SettingRow, SettingsGroup } from "./SettingsParts";

export interface TerminalSwitch {
  /** The Command Panel is on now. */
  on: boolean;
  /** Whether the deck's platform has the panel; null until the deck has said. */
  supported: boolean | null;
  /** Its sessions run in the Windows session host (`terminalWindows` in
   *  /api/prefs), so the note names that as where they keep running. */
  windows?: boolean;
  toggle: () => void;
}

export const TERMINAL_LABEL = "Command Panel";
export const TERMINAL_NOTE =
  "Experimental: open sessions beside the board and type into them. Turning it off closes the panel, not its sessions: they keep running and are back when you turn it on again.";
export const TERMINAL_WINDOWS_NOTE =
  "Experimental: open sessions beside the board and type into them. Turning it off closes the panel, not its sessions: they keep running in the session host and are back when you turn it on again.";
export const TERMINAL_UNSUPPORTED_NOTE = "Not yet available on this platform.";

export function terminalNote(supported: boolean | null, windows = false): string {
  if (supported === false) return TERMINAL_UNSUPPORTED_NOTE;
  return windows ? TERMINAL_WINDOWS_NOTE : TERMINAL_NOTE;
}

export default function TerminalSection({ terminal }: { terminal: TerminalSwitch }) {
  const fixed = terminal.supported === false && !terminal.on;
  return (
    <SettingsGroup>
      <SettingRow
        settingId="terminal"
        name={TERMINAL_LABEL}
        nameId="settings-terminal-label"
        note={terminalNote(terminal.supported, terminal.windows)}
        noteId="settings-terminal-note"
        control={
          <button
            type="button"
            className="switch"
            role="switch"
            aria-checked={terminal.on}
            aria-labelledby="settings-terminal-label"
            aria-describedby="settings-terminal-note"
            disabled={fixed}
            onClick={terminal.toggle}
          >
            <span className="switch-knob" />
          </button>
        }
      />
    </SettingsGroup>
  );
}
