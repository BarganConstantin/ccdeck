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
import { DEFAULTS, readPrefs, updatePrefs, writePrefs } from "./deck-prefs.mjs";

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

// Read at import, so `consider` has its answer from the first event. LAN sync
// used to start from this same read, and it must not: bin/deck.js imports the
// server module to ASK whether a deck is already up, and a launcher that then
// attaches and exits had already bound the beacon and the sync port on the way
// in — which is the `lan sync (listen): EADDRINUSE` line a second `ccdeck`
// printed above `deck already running`. The engine starts from the listen that
// succeeds, in startServer, which is the only process that may hold a port.
export const prefsRead = readPrefs().then(p => { _prefs = p; }).catch(() => {});

export const heldPrefs = Object.freeze({
  /** What the last read or write left here. Never a disk read — see above. */
  current: () => _prefs,
  /** `writePrefs(patch)`, and keep what it wrote. A write that throws keeps
   *  nothing, so the copy is never ahead of the file. */
  write: async patch => (_prefs = await writePrefs(patch)),
  /** `updatePrefs(mutate)`, and keep what it wrote: for a patch that has to be
   *  computed from the file rather than from `current()` — see updatePrefs. */
  update: async mutate => (_prefs = await updatePrefs(mutate)),
});
