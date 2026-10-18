// Settings › General, last of its switches: the terminal (use-stage.ts), a
// Beta that every deck starts with off.
//
// Drawn as Keyboard's row is — a caption, then one <label> row with the switch
// on the name's line and the note under both — with Beta on the caption's
// right, where a group's one piece of metadata goes. The note says what the
// switch gives and what it needs, because tmux is the one thing here that is
// not already on the machine. Two states the press cannot change are said
// rather than offered: a deck launched with the terminal on (the switch reads
// on and is fixed), and Windows, which has no tmux.

export interface TerminalSwitch {
  /** The terminal is on now, whichever way. */
  on: boolean;
  /** On because of how the deck was launched; the switch cannot turn it off. */
  forced: boolean;
  toggle: () => void;
}

export const TERMINAL_LABEL = "Open sessions in a terminal";
export const TERMINAL_NOTE =
  "Click a session's card to open it beside the board and type into it, as in your own terminal. Runs on tmux — the deck sets one up if this machine has none.";
export const TERMINAL_FORCED_NOTE = "On for this run: the deck was started with the terminal switched on.";
export const TERMINAL_WINDOWS_NOTE = "Not on Windows yet: the terminal runs on tmux, which Windows does not have.";
export const BETA_TITLE = "Beta feature — still being tested and improved.";

export function terminalNote(forced: boolean, windows: boolean): string {
  if (forced) return TERMINAL_FORCED_NOTE;
  return windows ? TERMINAL_WINDOWS_NOTE : TERMINAL_NOTE;
}

export default function TerminalSection({ terminal, platform }: { terminal: TerminalSwitch; platform: string }) {
  const windows = /^win/i.test(platform);
  const fixed = terminal.forced || windows;
  return (
    <section className="settings-group" aria-labelledby="settings-terminal-caption">
      <div className="settings-caption">
        <h3 id="settings-terminal-caption">Terminal</h3>
        <span className="settings-beta" title={BETA_TITLE}>Beta</span>
      </div>
      <div className="appearance-controls">
        <label className="appearance-row">
          <span className="appearance-row-label" id="settings-terminal-label">{TERMINAL_LABEL}</span>
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
          <span id="settings-terminal-note" className="appearance-row-note">{terminalNote(terminal.forced, windows)}</span>
        </label>
      </div>
    </section>
  );
}
