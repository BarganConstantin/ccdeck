// The `--help` text, and nothing else.
//
// Lifted out of bin/deck.js, which answers `--help` before anything else in the
// boot has run and was carrying sixty lines of prose it prints once and never
// reads. A leaf, like the modules that file imports at the top: brand.mjs and
// nothing more, so asking for help still starts nothing.
import { PRODUCT } from "../../src/server/brand.mjs";

export function printHelp() {
  process.stdout.write(`${PRODUCT} — live deck of Claude Code + Codex agents

Usage:
  ${PRODUCT} [options]

Options:
  -p, --port <number>      Preferred port (default: 4317; falls back to random 4318–4400)
      --no-open            Don't open the browser automatically
      --foreground         Hold the terminal, the way every version before 3.20
                           did. Ctrl+C stops the deck again
      --new                Replace the running deck with a fresh one.
                           Without it, a bare \`${PRODUCT}\` beside a deck that is
                           already up opens that deck's tab instead of building
                           a rival on another port
      --stop               Stop the running deck.
                           With --port <n>, stop that one; with --all, stop every
                           deck on this machine
      --status             What is running on this machine, and on which ports
      --logs               What the deck wrote where a terminal would have shown
                           it, and where that file is
      --install            Put the deck on your PATH and start it at login.
                           What an \`npx\` run needs to survive a reboot
      --install-service    Start the deck when you log in. Set up on first run;
                           this is only for putting it back
      --uninstall-service  Stop starting at login. \`--uninstall\` does this too
      --workspace <path>   Only capture sessions whose cwd is inside <path>
      --scope              Restrict to current working directory
      --all                Capture every session (default). Accepted and
                           ignored — it is what a bare run already does, and
                           \`--stop --port <n>\` is the only way to narrow a stop
      --history <path>     Override events log file (default: this platform's log directory)
      --no-persist         Don't write or replay events log (RAM-only)
      --codex              Force-enable Codex capture even if ~/.codex/ missing
      --no-codex           Skip Codex capture (Claude only)
      --claude             Force-enable Claude capture even if Claude Code wasn't found
      --no-claude          Skip Claude entirely: no hooks, no claude-swap, no accounts panel
      --uninstall          Remove ${PRODUCT}'s hooks from ~/.claude/settings.json and
                           ~/.codex/hooks.json, and restore any sound hooks of yours it parked.
                           Hook entries only: the forwarder script under
                           ~/.claude/agent-dag/, the deck's own state and log
                           directories (\`--status\` names them), ~/.agents-deck/
                           and claude-swap all stay. It NAMES the prefs.json
                           files that still hold this deck's LAN private key
      --purge              With --uninstall: delete those prefs.json files too, so the
                           private key every deck you paired with has pinned does not
                           outlive the uninstall. Your ${PRODUCT} settings go with them
  -h, --help               Show this help
  -v, --version            Print the version and exit

Anything else on the command line is reported as an unknown option and then
ignored: the deck still starts.

A flag that takes a value never swallows the next flag. If the value is missing,
empty, or itself looks like a flag — \`${PRODUCT} --workspace \$UNSET --no-persist\`
after the shell has dropped an unset variable — the flag is reported, left on its
default, and the token it would have eaten is parsed as the flag it is.
`);
}
