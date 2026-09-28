// Moving a prefs.json nobody can use out of the way, before anything can write
// over it: the bytes of a file that is not JSON (#1002), and a file another
// user owns (#1335). Moved out of deck-prefs.mjs unchanged; loadPrefs decides
// when, and this is how.
import { stat } from "node:fs/promises";
import { renameWithRetry } from "./atomic-write.mjs";
import { deckDataDir } from "./deck-home.mjs";
import { prefsDir, prefsPath } from "./prefs-path.mjs";

/** Where the bytes of a prefs.json nothing could parse are put.
 *
 *  `Date.now()` rather than an ISO timestamp because a colon is not a legal
 *  filename character on Windows, and a quarantine that cannot be created on
 *  the platform it is protecting is not a quarantine. */
export const quarantinePath = (home = deckDataDir(), at = Date.now()) =>
  `${prefsPath(home)}.corrupt-${at}`;

/** The read errors that can mean "not yours" rather than "broken". Only these
 *  send a read to setAsideForeign; EISDIR, EIO and EMFILE never do. */
export const DENIED = new Set(["EACCES", "EPERM"]);

/** Where a prefs.json another user owns is put. Beside the file, like
 *  quarantinePath, and stamped in milliseconds for the same Windows reason —
 *  but a name of its own, because nothing is wrong with these bytes. */
export const foreignPath = (home = deckDataDir(), at = Date.now()) =>
  `${prefsPath(home)}.foreign-${at}`;

/**
 * Move a prefs.json that ANOTHER USER OWNS out of the way, or say why not.
 *
 * #1335. A `sudo ccdeck` that kept the user's HOME writes a root-owned 0600
 * prefs.json into the user's own folder. From then on every
 * deck that user starts is refused the read, refuses every settings write on
 * top of it — rightly — and so can never keep anything: a new LAN identity on
 * every start, a share tick that says "Could not share that account", and no
 * way out from inside the deck.
 *
 * WHY MOVING IT IS SAFE HERE WHEN IT IS NOT FOR "unreadable". The refusal
 * exists so the deck never loses a key it could still have read. A file owned
 * by somebody else is not one this user's deck will ever read — waiting does
 * not help, and the deck is already running on defaults. A rename reads and
 * changes nothing: owner and mode travel with the file, so the key in it stays
 * private and whole, and `sudo chown` plus a move puts it back.
 *
 * Only when the owner is KNOWN to be somebody else. A file this user owns and
 * still cannot read (a mode bit, a lock, a sandbox) is left exactly where it
 * is, and so is anything on Windows, where there is no uid to compare and
 * EPERM is usually another program holding the file.
 *
 * Answers `{ moved, uid }`, `{ gone }` when the file vanished under it, or,
 * when it stayed, `{ why, owner, on }`: a sentence for the log, possibly empty,
 * and who owns what blocked the read — "you", "other" or "unknown" — and
 * whether that is the "file" or its "folder". The last two are what the panel
 * is told (see prefsRefusalDetail); the sentence, which has the path, is not.
 */
export async function setAsideForeign(path, home, deps) {
  const uid = deps.getuid ? deps.getuid() : process.getuid?.();
  if (uid === undefined) return { why: "", owner: "unknown", on: "file" };
  const look = deps.stat ?? stat;
  let st;
  try {
    st = await look(path);
  } catch (err) {
    if (err?.code === "ENOENT") return { gone: true };
    // The folder itself is out of reach, so nothing in it can be looked at, let
    // alone moved. Name the folder and its owner, which is what a person needs.
    const folder = prefsDir(home);
    const owner = await look(folder).then(s => s.uid, () => undefined);
    if (owner === undefined) return { why: "", owner: "unknown", on: "folder" };
    if (owner === uid) return { why: "", owner: "you", on: "folder" };
    return {
      why: ` The folder ${folder} belongs to another user (uid ${owner}), most likely from a run with sudo; sudo chown -R "$(id -un)" "${folder}" gives it back.`,
      owner: "other",
      on: "folder",
    };
  }
  if (st.uid === uid) return { why: "", owner: "you", on: "file" };
  const to = foreignPath(home);
  try {
    await (deps.rename ?? renameWithRetry)(path, to);
  } catch (err) {
    if (err?.code === "ENOENT") return { gone: true };
    return { why: ` It belongs to another user (uid ${st.uid}) and could not be moved aside either: ${err?.message ?? err}.`, owner: "other", on: "file" };
  }
  return { moved: to, uid: st.uid };
}
