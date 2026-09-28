// How the deck says it will not write prefs.json, and why.
//
// Moved out of deck-prefs.mjs whole: the error writePrefs throws rather than
// merge onto a base it knows is not the user's, and the two readings of it the
// route hands the panel (#1335) — a reason from a closed set, and the detail,
// every field of which is picked from a closed set too, because a route's body
// is readable by a DNS-rebound page and a path names the user.
import { PRODUCT } from "./brand.mjs";

/** The refusal `writePrefs` throws rather than merge onto a base it knows is
 *  not the user's. Shaped like installer.mjs's SETTINGS_UNREADABLE, which is
 *  the same policy on the other file this deck rewrites: a file we cannot
 *  reproduce is never treated as an empty one. */
export function unreadablePrefs(path, why, blocked) {
  const err = new Error(
    `${path} could not be read (${why}). Refusing to overwrite it — this deck's ` +
    `LAN key and its pairings are in there and cannot be re-derived. Fix the ` +
    `file or move it aside, then restart ${PRODUCT}.`,
  );
  err.code = "PREFS_UNREADABLE";
  err.prefsPath = path;
  err.why = why;
  err.blocked = blocked;
  return err;
}

/** The errors a filesystem raises for a place this user may not write — most
 *  often a settings folder a `sudo` run left owned by root (#1335). */
const NOT_WRITABLE = new Set(["EACCES", "EPERM", "EROFS"]);

/**
 * Why a settings write failed, as a reason the panel can name — or null when
 * the failure is not one of the two a person can fix from outside the deck.
 *
 * A code, never the message: the message carries the absolute path, and a
 * route's body is readable by a DNS-rebound page (see sendInternalError). The
 * deck's log keeps the path for the person who has to go and look.
 */
export function prefsWriteRefusal(err) {
  if (err?.code === "PREFS_UNREADABLE") return "prefs_unreadable";
  if (NOT_WRITABLE.has(err?.code)) return "prefs_not_writable";
  return null;
}

/** What blocked a prefs.json that is not JSON and could not be moved aside —
 *  no errno for it, so a name of the deck's own in the same shape. */
export const NOT_JSON = Object.freeze({ code: "BADJSON", owner: "unknown", on: "file" });

const OWNERS = new Set(["you", "other", "unknown"]);
/** An errno as Node spells one, or the deck's BADJSON. Anything else — which
 *  nothing here produces — is dropped rather than echoed to the page. */
const ERRNO = /^E?[A-Z][A-Z0-9]{1,15}$/;

/**
 * The same refusal, told precisely enough to act on from a screenshot (#1335).
 *
 * 3.29.3's panel could only guess — "the file may belong to another user" — and
 * the one Mac it was written for turned out not to be the case 3.29.4 repairs,
 * with nothing on the screen to say which case it was. So the page now gets the
 * errno, who owns what blocked the read (`you`, `other`, `unknown`), and whether
 * that is the `file` or its `folder`.
 *
 * Every field is picked from a closed set. Still no path and no uid: the route's
 * body is readable by a DNS-rebound page (see prefsWriteRefusal), and a path
 * names the user. Null when there is nothing precise to add.
 */
export function prefsRefusalDetail(err) {
  const blocked = err?.code === "PREFS_UNREADABLE" ? err.blocked
    : NOT_WRITABLE.has(err?.code) ? { code: err.code, owner: "unknown", on: "folder" }
    : null;
  if (!blocked || typeof blocked !== "object") return null;
  return {
    code: ERRNO.test(blocked.code ?? "") ? blocked.code : "",
    owner: OWNERS.has(blocked.owner) ? blocked.owner : "unknown",
    on: blocked.on === "folder" ? "folder" : "file",
  };
}
