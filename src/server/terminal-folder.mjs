// Is this folder one an agent can start in? Asked by the New session picker
// before it hands the folder to a launch (internal #106), so that a folder
// that went away, one this user may not open, or a file is said in the picker
// with the folder still chosen — not as a stage that failed after the picker
// closed.
//
// A QUESTION, NOT A BROWSER. It answers yes or why not for one path the page
// already has — picked in the desktop app's own folder dialog, typed in full,
// or one of the page's recent projects — and never lists what a folder holds
// or reads a file. A page that can call it can already launch an agent in the
// same path, which answers the same question less kindly; it is behind the
// same switch and the same gates as that launch (terminal-routes.mjs).
//
// THE LAUNCH AND THE ADOPT ASK IT TOO (terminal-routes.mjs, posted): a pane
// reopened, or started again, in a folder that has gone since is refused
// `folder-missing`, `folder-denied` or `folder-unreachable` with the folder,
// before anything starts.
//
// GONE IS NOT UNREACHABLE. A folder on a drive or a network folder that is
// disconnected right now — a FUSE or sshfs mount whose helper went away, an
// NFS share gone stale, a host that is down — is still where it was, and
// comes back when the drive does. The system says so in its own words
// (UNREACHABLE), which are never read as "missing".
//
// THE ENGINE STILL DECIDES. The launch is asked of the engine as before, which
// checks the folder again; a yes here is a courtesy that can go stale, never a
// permission. Nothing is ever started in another folder than the one asked.
import { constants } from "node:fs";
import { access, opendir, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** Why a folder is not one to start in. */
export const FOLDER_PROBLEMS = Object.freeze(["relative", "missing", "denied", "not-folder", "unreachable"]);

const DENIED = new Set(["EACCES", "EPERM"]);

/** The system's answers for a folder that is there but cannot be reached
 *  right now: a mount whose helper went away (ENOTCONN), a network share
 *  whose handle went stale (ESTALE), whose host is down (EHOSTDOWN) or does
 *  not answer (ETIMEDOUT), a drive that fails to read (EIO). The page's own
 *  copy of this list reads an agent's words about its folder
 *  (use-terminal-session.ts, agentFolderFailure). */
export const UNREACHABLE = Object.freeze(["ENOTCONN", "EIO", "ESTALE", "EHOSTDOWN", "ETIMEDOUT"]);
const UNREACHABLE_SET = new Set(UNREACHABLE);

/** One of FOLDER_PROBLEMS for the system's refusal of a stat or an access. */
function problemOf(err) {
  if (DENIED.has(err?.code)) return "denied";
  if (UNREACHABLE_SET.has(err?.code)) return "unreachable";
  return "missing";
}

/** The path as asked, without trailing separators — but never the root itself
 *  ("/", "C:\\"), and never resolved: the folder the reader chose is the one
 *  that is started in, links and all. */
export function trimFolder(path) {
  if (typeof path !== "string") return "";
  const trimmed = path.replace(/[\\/]+$/, "");
  if (trimmed === "") return path.startsWith("/") ? "/" : path;
  // "C:\" keeps its separator; a bare "C:" is a drive's current folder, not a path.
  if (/^[A-Za-z]:$/.test(trimmed)) return path.length > 2 ? `${trimmed}${path[2]}` : path;
  return trimmed;
}

/**
 * `{ ok: true, cwd }` for a folder an agent can be started in, else `{ ok:
 * false, code }` with one of FOLDER_PROBLEMS. `cwd` is the path trimmed of
 * trailing separators and nothing else.
 */
export async function checkFolder(path, { statFn = stat, accessFn = access, opendirFn = opendir } = {}) {
  const cwd = trimFolder(path);
  // A control character is no folder the deck stores (checkCwd): not a path at all.
  if (!cwd || !isAbsolute(cwd) || /[\u0000-\u001f\u007f]/.test(cwd)) return { ok: false, code: "relative" };
  let st;
  try {
    st = await statFn(cwd);
  } catch (err) {
    return { ok: false, code: problemOf(err) };
  }
  if (!st.isDirectory()) return { ok: false, code: "not-folder" };
  // Seen is not entered: an agent has to list it and to work inside it.
  try {
    await accessFn(cwd, constants.R_OK | constants.X_OK);
  } catch (err) {
    return { ok: false, code: problemOf(err) };
  }
  // Opened and closed again, nothing read: a disconnected mount can still
  // answer the two questions above from what the system remembers of it, and
  // the agent's first read of its folder is then what fails. Only that answer
  // is taken from the open; any other refusal stays the agent's to meet, as
  // before this question opened anything.
  try {
    const dir = await opendirFn(cwd);
    try { await dir?.close?.(); } catch {}
  } catch (err) {
    if (UNREACHABLE_SET.has(err?.code)) return { ok: false, code: "unreachable" };
  }
  return { ok: true, cwd };
}
