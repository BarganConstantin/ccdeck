// The deck process this app started (#1160), and stopping it (#1782).
//
// The app starts a deck of its own when none is running, and a restart that
// the deck cannot do itself starts another. Each child's exit is heard, but
// only the CURRENT one's exit means the app has no deck of its own: a deck
// replaced earlier that exits afterwards used to clear the reference to the
// one that replaced it, and Quit then stopped neither.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

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
 * Start the app's own deck and wait for it to answer — for as long as there is
 * a deck to wait for.
 *
 * The wait used to be forty seconds whatever the deck did. A deck that cannot
 * start — a settings.json that does not parse, or one a past `sudo claude`
 * left owned by root — prints why and exits in its first second, and its
 * supervisor does not restart a deck that never served. The tray said
 * "Starting the deck…" for the rest of the forty seconds, then "No deck
 * running", and why was written only to deck-app.log. So the wait ends when
 * the deck exits, and what the deck wrote to its log on the way out comes
 * back as the reason.
 *
 * `start(exited)` starts it and calls `exited(code, signal)` when it exits. A
 * throw from it — a launcher that could not be written, a log that could not
 * be opened — is a failed start too, rather than a rejection that took the
 * rest of the app's startup with it. `look()` looks for a running deck, and
 * `found()` says whether one is attached; one more look follows the exit,
 * because a deck that finds another already running leaves it to that one.
 *
 * -> { ok: true } | { ok: false, reason } — `reason` is null for a deck still
 *    starting when the wait runs out: it may yet come up, and the app's
 *    five-second look attaches it then.
 */
export async function startOwnDeck({ start, look, found, logFile, tries = 80, everyMs = 500 }) {
  const from = logSize(logFile);
  let gone = null;
  let wake = () => {};
  const exited = new Promise(resolve => { wake = resolve; });
  try {
    start((code, signal) => { gone = { code, signal }; wake(); });
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err) };
  }
  for (let i = 0; i < tries && !found(); i++) {
    await Promise.race([new Promise(resolve => setTimeout(resolve, everyMs)), exited]);
    await look();
    if (gone && !found()) return { ok: false, reason: logTail(logFile, from) || exitText(gone) };
  }
  return found() ? { ok: true } : { ok: false, reason: null };
}

/** How many bytes the log holds now, so a start reads only its own lines. */
function logSize(file) {
  try {
    const fd = openSync(file, "r");
    try { return fstatSync(fd).size; } finally { closeSync(fd); }
  } catch { return 0; }
}

/** The last lines that say something, of what the log gained from byte
 *  `from` on — at most the last 16 KB of it, colour codes and a spinner's
 *  overwritten frames taken out. Empty when there is nothing to read. */
export function logTail(file, from, { lines = 4, maxBytes = 16_384 } = {}) {
  let text = "";
  try {
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      // A log rotated or truncated since is read from its start.
      const start = Math.max(size < from ? 0 : from, size - maxBytes);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf8");
    } finally { closeSync(fd); }
  } catch { return ""; }
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .split("\n")
    .map(line => line.slice(line.lastIndexOf("\r") + 1).trim())
    .filter(Boolean)
    .slice(-lines)
    .join("\n");
}

/** What the exit says, for a deck that wrote nothing on its way out. */
function exitText({ code, signal }) {
  return `The deck stopped while it was starting (${signal ? `signal ${signal}` : `exit code ${code}`}).`;
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
