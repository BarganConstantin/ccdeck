// A CLI installed after the deck started, noticed by the deck.
//
// Whether this deck serves Claude Code and Codex is decided once, at boot
// (wantsCli in bin/deck.js), and everything hangs off that answer: the hooks in
// Claude Code's settings.json, claude-swap, the ccusage prime, the Codex rollout
// watcher. A first run is the boot where that answer is most likely to change a
// few minutes later — the desktop app is installed and opened, and only then
// does its user install Claude Code. Reproduced on a clean Windows VM: the deck
// said "Waiting for Claude Code or Codex", no hook was installed, and the
// sessions the user went on to start never appeared, until the app was quit and
// opened again, which nothing told them to do.
//
// So while a CLI is neither served nor switched off, the boot's own question is
// asked again on a slow timer, and the first yes restarts the deck through its
// supervisor. The respawn asks wantsCli afresh and comes back serving the CLI;
// bin/deck.js runs the Claude setup it then owes (claudeArrived there). The
// checks are the boot's own, hasClaudeInstalled and hasCodexInstalled: a
// handful of stats, which is nothing at this cadence.

/** How often to look. A user who has just installed Claude Code takes longer
 *  than this to open a terminal and start it. */
export const CLI_POLL_MS = 15_000;

/** The interval, as the environment may override it — for tests, which
 *  should not wait fifteen real seconds to see a restart. Anything unparseable
 *  or below a tenth of a second is the default. */
export function cliPollMs(env = process.env) {
  const n = Number(env.AGENTS_DECK_CLI_POLL_MS);
  return Number.isFinite(n) && n >= 100 ? n : CLI_POLL_MS;
}

/**
 * Watch for a CLI the boot did not find, and call `onArrive(name)` once, for
 * the first one that appears. Answers a function that stops the watch.
 *
 * `clis` is `{ name, want, off, installed }` per CLI: `want` is the boot's
 * answer, `off` is `--no-claude` / `--no-codex` (the user telling the deck to
 * leave that CLI alone, which still holds for one installed afterwards), and
 * `installed` is the boot's presence check. A CLI already served or switched
 * off is not watched, and with nothing to watch no timer is started at all.
 *
 * The timer is unref'd: it must never be the thing keeping a deck alive.
 * A presence check that throws is a no for this beat, not the end of the watch.
 */
export function watchForClis({ clis, onArrive, everyMs = cliPollMs(), timers = globalThis }) {
  const awaited = clis.filter(c => !c.want && !c.off);
  if (!awaited.length) return () => {};
  let stopped = false;
  const timer = timers.setInterval(() => {
    if (stopped) return;
    const found = awaited.find(c => {
      try { return Boolean(c.installed()); } catch { return false; }
    });
    if (!found) return;
    stop();
    onArrive(found.name);
  }, everyMs);
  timer?.unref?.();
  function stop() {
    stopped = true;
    timers.clearInterval(timer);
  }
  return stop;
}
