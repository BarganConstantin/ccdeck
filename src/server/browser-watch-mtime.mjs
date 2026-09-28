// The stamp both of Browser Watch's caches are keyed on: a file's modification
// time.
//
// Moved out of browser-watch.mjs unchanged when the relay report left it for
// browser-watch-relay.mjs, because both reads that cache ask this one question
// — the History read in browser-watch.mjs and the Secure Preferences read in
// browser-watch-relay.mjs — and two spellings of "not there" would be two
// answers to it. It imports node:fs and nothing else, so either side reaches it
// without reaching the other.
import { statSync } from "node:fs";

/** The file's modification time in ms, or null when it is not there at all —
 *  an uninstalled browser, a profile that has never been opened, a home
 *  directory on a volume that is not mounted. Never throws: one unreadable
 *  profile must not take the other browsers' answers down with it. */
export function mtimeMs(file, deps) {
  try { return (deps.statSync ?? statSync)(file).mtimeMs; } catch { return null; }
}
