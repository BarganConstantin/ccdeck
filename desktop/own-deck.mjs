// The deck process this app started (#1160), and stopping it (#1782).
//
// The app starts a deck of its own when none is running, and a restart that
// the deck cannot do itself starts another. Each child's exit is heard, but
// only the CURRENT one's exit means the app has no deck of its own: a deck
// replaced earlier that exits afterwards used to clear the reference to the
// one that replaced it, and Quit then stopped neither.

/** The deck this app started, if it did. */
export function createOwnDeck() {
  let current = null;
  return {
    current: () => current,
    /** `child` is the app's deck from now on. `onExit(code, signal)` runs
     *  whenever it exits, and it stops being the current one only if it still
     *  is. Returns `child`. */
    track(child, onExit) {
      current = child;
      child.on("exit", (code, signal) => {
        if (current === child) current = null;
        onExit?.(code, signal);
      });
      return child;
    },
  };
}

/**
 * Wait for `child` to exit, and make it: after `graceMs` it is signalled, and
 * if it is still there as long again, signalled once more. The deck's
 * supervisor passes the first signal on to its worker as SIGTERM, which a
 * worker stuck in its own event loop never gets to handle — the hung deck a
 * restart is asked for — and takes a second as the order to SIGKILL it
 * (bin/agent-dag.js). Resolves whether it exited.
 */
export function stopChild(child, { graceMs = 4000, signals = 2 } = {}) {
  return new Promise(resolve => {
    if (child.exitCode != null || child.signalCode != null) return resolve(true);
    let sent = 0;
    let timer = null;
    const done = exited => { clearTimeout(timer); child.off("exit", onExit); resolve(exited); };
    const onExit = () => done(true);
    const wait = () => {
      timer = setTimeout(() => {
        if (sent >= signals) return done(false);
        sent++;
        try { child.kill(); } catch { /* already gone */ }
        wait();
      }, graceMs);
    };
    child.once("exit", onExit);
    wait();
  });
}

/**
 * What a look for a running deck does with the one it found (#1783): "attach"
 * to it, "replace" it — shut it down, so the app's own deck starts in its
 * place — or "none" when there is none.
 *
 * A deck OLDER than the one the app carries is replaced, as a newer `ccdeck`
 * started in a terminal replaces an older one (running-deck.mjs olderVersion,
 * which a deck reporting no version also fails). But only when `willStart`:
 * on the path that starts the app's own deck straight after (ensureDeck). The
 * other looks — every five seconds while there is no deck, and after the tray
 * stream or the app's own deck is lost — start nothing, and shutting a deck
 * down there left the machine with none. They attach to it instead; the
 * version note says it is older. Never while the app has a deck of its own or
 * is starting one.
 */
export function discoverPlan({ found, ours, ownDeck, starting, willStart = false, olderVersion }) {
  if (!found) return "none";
  if (willStart && !ownDeck && !starting && olderVersion(found.version, ours)) return "replace";
  return "attach";
}
