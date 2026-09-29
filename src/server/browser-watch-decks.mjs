// Which decks are on this machine, as Browser Watch needs to know it: whose
// tabs are the deck's own, and which deck is the one that writes.
//
// Two questions the snapshot asks of the discovery directory — the record
// every running deck keeps in `~/.claude/agent-dag` — and of nothing else.
// `deckOwnOrigins` and `registeredDeckPorts` answer the first: a deck opens its
// own tab through `open`, Chrome marks that visit as a program's, and the watch
// must not report ccdeck to its owner. `isReactingDeck` answers the second:
// one machine, one store, usually more than one deck, and only one of them may
// write the archive and react.
//
// Reading only. Neither question claims anything on disk to answer it, so
// neither can leave a claim behind. browser-watch.mjs re-exports the two the
// route imports, so browser-watch-routes.mjs and the tests that import them
// from there are unchanged.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeConfigDir } from "./claude-dir.mjs";
// Is that pid still running? The probe every other reader of this directory
// uses, rather than the copy this module kept of it. A bare `catch { continue; }`
// once stood where it is called, which threw away the one distinction that
// matters: a process this account may not signal answers EPERM on POSIX and
// EACCES on Windows, and both mean ALIVE. Treating them as gone made an
// elevated deck invisible to the writer election below, which is how a machine
// ends up with two elected writers — duplicate log lines, duplicate reactions,
// and two writers racing the same rename. One probe is one rule to keep right.
import { isProcessAlive } from "./deck-probe.mjs";

/**
 * Every loopback address a ccdeck could have opened a tab on.
 *
 * Not just this process's port. The deck asks for 4317 and, when something else
 * already holds it, binds a RANDOM port in 4318-4400 instead (startServer's
 * `portRange`), so a machine that has been running decks for a month has tabs
 * on several. The real profile this feature was tuned against carried 41 visits
 * to 127.0.0.1:4317 and 34 to 127.0.0.1:4399 — two ports, both this deck, both
 * FROM_API because `open` is an API call, and every one of them a card the
 * panel would have shown its owner about itself.
 *
 * The whole range rather than the ports seen: the alternative is to remember
 * which ports past decks used, which is a file to keep, a file to migrate, and
 * a file that is empty the first time it matters. Eighty-four loopback ports
 * this program documents as its own are not a meaningful loss of coverage — a
 * user's own dev server on 3000 or 44440 is still reported, which is the case
 * that would have hurt.
 */
export function deckOwnOrigins(portRange = [4317, 4400], registered = []) {
  const [lo, hi] = portRange;
  const out = [];
  for (let port = lo; port <= hi; port++) out.push(`http://127.0.0.1:${port}`);
  // AND THE PORTS DECKS ACTUALLY REGISTERED, which the range cannot know about.
  // The range covers the default and its fallback; an explicit `--port` lands
  // anywhere. Measured: a deck running from a worktree on `--port 4793` opened
  // its own tab, and this panel reported it to its owner as a program driving
  // the browser — which it was, and the program was ccdeck.
  //
  // Read rather than guessed. The registry already holds a port per live deck
  // for the election, so this is a fact the machine has, not a range somebody
  // has to keep current.
  //
  // A deck that registered NOTHING is still reported, and that is right rather
  // than a gap: from here it is a program driving the browser and nothing
  // announces otherwise. The reader can dismiss it once and it stays dismissed.
  for (const port of registered) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    if (port >= lo && port <= hi) continue;
    out.push(`http://127.0.0.1:${port}`);
  }
  return out;
}

/** The port of every live deck that registered one. Same directory and the same
 *  liveness check the election uses — a record whose process is gone is a
 *  leftover, not a deck whose tabs should be excused. */
export async function registeredDeckPorts(deps = {}) {
  if (deps.registeredDeckPorts) return deps.registeredDeckPorts();
  const dir = join(claudeConfigDir(), "agent-dag");
  let files;
  try { files = await readdir(dir); } catch { return []; }
  const ports = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const d = JSON.parse(await readFile(join(dir, f), "utf8"));
      if (typeof d?.pid !== "number" || typeof d?.port !== "number") continue;
      if (!isProcessAlive(d.pid)) continue;
      ports.push(d.port);
    } catch { /* corrupt, or gone between listing and read */ }
  }
  return ports;
}

/**
 * Whether THIS deck is the one that reacts and writes.
 *
 * ONE MACHINE, ONE STORE, AND USUALLY MORE THAN ONE DECK. The archive and the
 * log live at a single path per machine, but running two decks is ordinary here
 * — the repo has electWriters and a discovery directory precisely because it is.
 * Both would read the same Chrome history, find the same new episode, and each
 * write a line and fire a notification: one event, told twice.
 *
 * Verified rather than assumed: at the moment this was written, two decks were
 * live on this machine (ports 4317 and 4393), so the collision is the ordinary
 * case and not a corner.
 *
 * The rule is log-election.mjs's, reused rather than reinvented: among live
 * decks, the LOWEST PORT wins, with the pid breaking a tie a stale discovery
 * file could invent. Deterministic, needs no lock file, and cannot strand the
 * feature — a deck that reads a directory it cannot open decides it is alone,
 * which for the common case of one deck is the right answer anyway.
 *
 * Reading only, never writing: this is a question about who else is running, and
 * a watcher that had to claim something to answer it could leave the claim
 * behind. The shell tool this descends from lost its lock on SIGHUP and then
 * refused to watch anything ever again.
 */
export async function isReactingDeck(deps = {}) {
  if (deps.isReactingDeck) return deps.isReactingDeck();
  const dir = join(claudeConfigDir(), "agent-dag");
  let files;
  try { files = await readdir(dir); } catch { return true; }   // cannot look — assume alone

  let best = null;
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const d = JSON.parse(await readFile(join(dir, f), "utf8"));
      if (typeof d?.pid !== "number" || typeof d?.port !== "number") continue;
      // ONLY DECKS THAT RUN THE WATCH GET A VOTE. This elected on port alone,
      // so an older ccdeck that predates the feature won by holding the lower
      // port and then wrote nothing — while the deck that has the watch stood
      // down and also wrote nothing. Measured here: a v1.46 deck out of an npx
      // cache held 4317, answered this route with the SPA's index.html, and the
      // watch recorded nothing at all for as long as both were up. Findings on
      // screen, an empty disk, and not one line anywhere saying why.
      //
      // An older deck has no such field, so it loses by construction rather
      // than by a version comparison this would otherwise have to keep.
      if (d.watch !== true) continue;
      // A record whose process is gone is a leftover, not a rival.
      if (!isProcessAlive(d.pid)) continue;
      if (!best || d.port < best.port || (d.port === best.port && d.pid < best.pid)) best = d;
    } catch { /* corrupt, or gone between listing and read */ }
  }
  return best === null || best.pid === process.pid;
}
