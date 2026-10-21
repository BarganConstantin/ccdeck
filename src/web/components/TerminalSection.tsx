// Settings › General, after the board: the terminal (use-stage.ts), a Beta
// that every deck starts with off.
//
// One row in the shared shape (SettingsParts.tsx, #2176) — the switch on the
// name's line, the note under the name — in a group of its own, with Beta in
// the caption's right-hand slot, where a group's one piece of metadata goes.
// The note says what the switch gives and what it needs, because tmux is the
// one thing here that is not already on the machine. Two states the press cannot change are said
// rather than offered: a deck launched with the terminal on (the switch reads
// on and is fixed), and Windows, which has no tmux — fixed off there, though
// never fixed on: a settings file carried over from another machine can still
// be switched off.

import { SettingRow, SettingsGroup } from "./SettingsParts";

export interface TerminalSwitch {
  /** The terminal is on now, whichever way. */
  on: boolean;
  /** On because of how the deck was launched; the switch cannot turn it off. */
  forced: boolean;
  toggle: () => void;
}

export const TERMINAL_LABEL = "Type into sessions from the deck";
export const TERMINAL_NOTE =
  "Click a session's card to open it beside the board and type into it, as in your own terminal. Runs on tmux: if this machine has none, the deck downloads its own copy into its folder, and nothing is installed on the system.";
export const TERMINAL_FORCED_NOTE = "On for this run: the deck was started with the terminal switched on.";
export const TERMINAL_WINDOWS_NOTE = "Not on Windows yet: the terminal runs on tmux, which Windows does not have.";
export const BETA_TITLE = "Beta feature — still being tested and improved.";

export function terminalNote(forced: boolean, windows: boolean): string {
  if (forced) return TERMINAL_FORCED_NOTE;
  return windows ? TERMINAL_WINDOWS_NOTE : TERMINAL_NOTE;
}

export default function TerminalSection({ terminal, platform }: { terminal: TerminalSwitch; platform: string }) {
  const windows = /^win/i.test(platform);
  const fixed = terminal.forced || (windows && !terminal.on);
  return (
    <SettingsGroup
      id="settings-terminal-caption"
      title="Terminal"
      aside={<span className="settings-beta" title={BETA_TITLE}>Beta</span>}
    >
      <SettingRow
        settingId="terminal"
        name={TERMINAL_LABEL}
        nameId="settings-terminal-label"
        note={terminalNote(terminal.forced, windows)}
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
