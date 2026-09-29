// The deck's settings as this process holds them: the one in-memory copy every
// reader asks, and the one place a write's answer is kept.
//
// This was `let _prefs` in src/server/index.mjs, and it is the reason the LAN
// section could not leave that file. The notifier and the away-update read it;
// the settings route, the LAN peer route and six of the LAN engine's callbacks
// each assigned it back with `_prefs = await writePrefs(...)`; and a
// module-level `let` is one no other module can assign. So the variable moved
// first, behind the three things its callers actually do with it: read it,
// write a patch, and compute a patch from the file. Every write now goes
// through here, which is also what keeps the promise the comment below has
// always made — that the copy and the file cannot drift within one process —
// true by construction rather than by every caller remembering the assignment.
//
// The disk half is deck-prefs.mjs, unchanged: the queue, the merge and the
// refusal to write over a file it could not read all live there. This holds
// what they return and nothing else.
import { DEFAULTS, loadPrefs, loadPrefsInTurn, updatePrefs, writePrefs } from "./deck-prefs.mjs";

/**
 * The deck's own settings, in memory, refreshed whenever they are written.
 *
 * Read once at boot and then kept here rather than read per event: `consider`
 * is on the ingest path every hook event goes through, and a file read there
 * would be a syscall per event to answer a question that changes when somebody
 * presses a switch. The write path below updates this, so the in-memory copy
 * and the file cannot drift within one process — and a second deck writing the
 * file is picked up on ITS next write or this one's next boot, which is the
 * same freshness every other cross-deck setting has.
 */
let _prefs = { ...DEFAULTS };
/** Where that copy came from: loadPrefs' `source` for the boot read, and
 *  "file" once a write has landed, since a write only lands on a file it could
 *  read. Anything else is a deck running on the defaults (#1711). */
let _source = "missing";

// Read at import, so `consider` has its answer from the first event. LAN sync
// used to start from this same read, and it must not: bin/deck.js imports the
// server module to ASK whether a deck is already up, and a launcher that then
// attaches and exits had already bound the beacon and the sync port on the way
// in — which is the `lan sync (listen): EADDRINUSE` line a second `ccdeck`
// printed above `deck already running`. The engine starts from the listen that
// succeeds, in startServer, which is the only process that may hold a port.
export const prefsRead = loadPrefs().then(r => { _prefs = r.prefs; _source = r.source; }).catch(() => {});

export const heldPrefs = Object.freeze({
  /** What the last read or write left here. Never a disk read — see above. */
  current: () => _prefs,
  /** `writePrefs(patch)`, and keep what it wrote. A write that throws keeps
   *  nothing, so the copy is never ahead of the file. */
  write: async patch => kept(await writePrefs(patch)),
  /** `updatePrefs(mutate)`, and keep what it wrote: for a patch that has to be
   *  computed from the file rather than from `current()` — see updatePrefs. */
  update: async mutate => kept(await updatePrefs(mutate)),
  /** Read the file again, as a boot would, once something outside the deck has
   *  made it readable (#1711) — and only then. A copy that already came from
   *  the file is left alone and answers "held": re-reading it would race the
   *  engine's own writes for nothing. Otherwise the read waits its turn behind
   *  the writes, and is kept only when it really is the user's file; a read
   *  that still fails leaves the copy this process was running on. Answers
   *  "held", or the read's `source`. */
  reload: async () => {
    if (_source === "file") return "held";
    const { prefs, source } = await loadPrefsInTurn();
    if (source === "file") { _prefs = prefs; _source = "file"; }
    return source;
  },
});

function kept(prefs) {
  _prefs = prefs;
  _source = "file";
  return prefs;
}
