// Which page of ccdeck.dev an install came from — the `--ref` its command
// carried, for the usage reports (reports.mjs).
//
// WHAT IT ANSWERS. The site offers a command to copy on most of its pages, and
// puts a ref naming the page in it: `npx ccdeck --ref=guides-first-run`. The
// first "install" report carries that ref, and nothing else ever does, so the
// people who make ccdeck can tell which page a new install came from rather than
// guess it from site visits. A ref names a page of the site and nothing about the
// person: lowercase letters, digits and dashes, at most REF_MAX of them, and
// anything else is dropped here rather than sent.
//
// ONCE. A ref on any later run — a reinstall over an install that already
// reported, a respawn whose argv still carries it — is ignored: only the install
// it arrived with is new. If that install's report cannot get out, the ref waits
// in the prefs beside the install id and goes with the next try, then is cleared.
//
// The boot (bin/deck.js) is what reads the command line, and it reaches this
// module through noteRef. This file imports nothing, so the boot and the prefs
// can both load it early.

/** The longest ref. The API takes the same. */
export const REF_MAX = 32;

/** The ref if it is one, else undefined. */
export function refSlug(raw) {
  return typeof raw === "string" && raw.length <= REF_MAX && /^[a-z0-9-]+$/.test(raw) ? raw : undefined;
}

let noted;

/** What this run's command line said, if it said anything that is a ref. */
export function noteRef(raw) {
  noted = refSlug(raw);
}

/** This run's ref, or undefined. */
export function notedRef() {
  return noted;
}
