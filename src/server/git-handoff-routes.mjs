// GET /api/git/handoffs and POST /api/git/open — the git view's hand-off
// buttons: which git client, editor and terminal this machine has, and opening
// one of them on a session's folder.
//
// A launch names a SESSION and a slot, never a folder or a program. The folder
// is the one the deck heard that session run in (git-sessions.mjs); the program
// is the slot's app as detection found it (git-handoff-apps.mjs), the one picked
// in Appearance or else the first; the command line is a fixed vector
// (git-handoff-launch.mjs). An editor may be handed one file, as a path inside
// the session's repository, and a path that leaves it is refused.
//
// ONLY FROM THIS MACHINE. Opening an app on the deck's screen is a thing only
// the person at that screen may ask for, so a launch from anything that does
// not look like a browser on this machine is refused (viewerIsLocal), and the
// GET tells the page which it is, so a page viewed from elsewhere draws only
// the copy buttons.
//
// NOTHING IS WRITTEN TO THE REPOSITORY. The only git question asked is
// `repoOf`, the git view's own read-only one, for the top of the repository.
//
// Shapes:
//   GET  → 200 { ok, local, machine, slots: { git|editor|terminal: { apps: [{ id, name }], chosen } } }
//   POST { session, agent?, slot, file? } → 200 { ok, app: { id, name } }
//   400 a field missing or malformed · 403 not from this machine · 404 an
//   unknown session, a folder that is gone, or a file not in the repository ·
//   409 git switched off, no app for the slot, not a repository, or a folder
//   the app cannot be given.
import { realpath, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";
import { runDetached } from "./exec.mjs";
import { readBody, send } from "./http-io.mjs";
import { heldPrefs } from "./prefs-state.mjs";
import { isLoopbackHost } from "./request-gates.mjs";
import { sessionFolder } from "./git-sessions.mjs";
import { repoOf } from "./git-state.mjs";
import { gitEnabled } from "./git-watch.mjs";
import { SLOTS, chooseApp, detectApps, pathExists } from "./git-handoff-apps.mjs";
import { REFUSALS, launchEnv, launchSpec, viewerIsLocal } from "./git-handoff-launch.mjs";

/** How long one look at the machine is believed. Detection is a few dozen
 *  stats, so it is cheap; it is cached so a page drawing the buttons on every
 *  card it opens does not repeat them, and expires so an app installed while
 *  the deck runs turns up without a restart. */
export const DETECT_TTL_MS = 5 * 60_000;
const MAX_FIELD = 4096;

let detector = () => detectApps();
let launcher = runDetached;
let clock = () => Date.now();
let cache = null; // { at, apps: Promise<app[]> }

/** The detection the routes use, replaced by the tests. */
export function setHandoffDetector(fn) {
  detector = typeof fn === "function" ? fn : () => detectApps();
  cache = null;
}

/** What starts the app, replaced by the tests so nothing opens on their
 *  machine: `(file, args, opts)`, runDetached's shape. */
export function setHandoffLauncher(fn) {
  launcher = typeof fn === "function" ? fn : runDetached;
}

/** The clock the cache reads, replaced by the tests. */
export function setHandoffClock(fn) {
  clock = typeof fn === "function" ? fn : () => Date.now();
}

/** Forget the last look, so the next ask looks again. */
export function forgetHandoffApps() {
  cache = null;
}

/** This machine's apps, from the last look while it is fresh. Never rejects. */
function detected() {
  const now = clock();
  if (!cache || now - cache.at > DETECT_TTL_MS) {
    cache = { at: now, apps: Promise.resolve().then(() => detector()).then((a) => (Array.isArray(a) ? a : []), () => []) };
  }
  return cache.apps;
}

const picks = () => heldPrefs.current()?.gitApps ?? {};

const str = (v) => (typeof v === "string" && v !== "" && v.length <= MAX_FIELD ? v : null);

/** GET — the apps, the picks, and whether the page is on this machine.
 *  `?fresh=1` looks at the machine again first: Appearance asks that way. */
export async function handleGitHandoffs(req, res, url) {
  if (!gitEnabled()) return send(res, 409, { error: "git is switched off in Settings" });
  if (url?.searchParams?.get("fresh") === "1") forgetHandoffApps();
  const apps = await detected();
  const chosen = picks();
  const slots = {};
  for (const slot of SLOTS) {
    slots[slot] = {
      apps: apps.filter((a) => a.slot === slot).map((a) => ({ id: a.id, name: a.name })),
      chosen: chooseApp(apps, slot, chosen[slot])?.id ?? null,
    };
  }
  send(res, 200, { ok: true, local: viewerIsLocal(req, { isLoopbackHost }).local, machine: hostname(), slots });
}

/** Whether `p` is a directory right now. */
async function isDir(p) {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

/**
 * The absolute path of `file`, a path inside the repository at `top`, or null
 * for one that is absolute, climbs out, or resolves (through a link) outside
 * it, or does not exist.
 */
export async function fileInRepo(top, file) {
  if (typeof file !== "string" || !file || file.includes("\0")) return null;
  // Repository paths are git's: forward slashes, relative to the top.
  if (posix.isAbsolute(file) || win32.isAbsolute(file) || /^[a-z]:/i.test(file)) return null;
  if (file.split(/[\\/]/).some((part) => part === "..")) return null;
  const full = resolve(top, file);
  const within = (root, p) => {
    const rel = relative(root, p);
    return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
  };
  if (!within(top, full)) return null;
  try {
    const [realTop, realFull] = await Promise.all([realpath(top), realpath(full)]);
    return within(realTop, realFull) ? full : null;
  } catch {
    return null;
  }
}

const REFUSAL_WORDS = {
  [REFUSALS.unquotable]: "this folder's name has a % or !, which the launcher cannot pass on safely",
  [REFUSALS.separator]: "this folder's name has a ;, which Windows Terminal reads as a separator",
  [REFUSALS.noTerminal]: "no terminal was found to run lazygit in",
};

/** POST — open the slot's app on the session's folder. */
export async function handleGitOpen(req, res) {
  if (!gitEnabled()) return send(res, 409, { error: "git is switched off in Settings" });
  // Before the body is even read: a page on another machine gets nothing.
  if (!viewerIsLocal(req, { isLoopbackHost }).local) {
    return send(res, 403, { error: "apps open only from a browser on the deck's own machine" });
  }
  // `send` is a no-op once readBody has answered a body too large itself.
  const raw = await readBody(req, res, 16_384).catch(() => null);
  if (raw === null) return send(res, 400, { error: "the body could not be read" });
  let body = null;
  try { body = JSON.parse(raw); } catch { /* handled below */ }
  if (!body || typeof body !== "object" || Array.isArray(body)) return send(res, 400, { error: "a JSON body is required" });
  const sid = str(body.session);
  const slot = SLOTS.includes(body.slot) ? body.slot : null;
  if (!sid) return send(res, 400, { error: "session required" });
  if (!slot) return send(res, 400, { error: "slot must be git, editor or terminal" });
  if (body.file !== undefined && body.file !== null && (slot !== "editor" || !str(body.file))) {
    return send(res, 400, { error: "a file is only for the editor, as a path in the repository" });
  }
  const agent = str(body.agent);

  const folder = sessionFolder(sid, agent);
  if (!folder) return send(res, 404, { error: "unknown session" });
  // A folder that is gone, or one that was never a real place — the session's
  // own cwd is absolute, and a relative one would resolve against the deck's.
  if (!isAbsolute(folder.cwd) || !(await isDir(folder.cwd))) return send(res, 404, { error: "the session's folder is gone" });

  let where = folder.cwd;
  let file = null;
  if (slot === "git" || str(body.file)) {
    const repo = await repoOf(folder.cwd);
    if (repo.state !== "repo") return send(res, 409, { error: "the session's folder is not a git repository" });
    // A git client opens the repository, which is the folder git calls its
    // top; an editor keeps the session's own folder and opens the file in it.
    if (slot === "git") where = repo.topLevel;
    if (str(body.file)) {
      file = await fileInRepo(repo.topLevel, body.file);
      if (!file) return send(res, 404, { error: "no such file in this repository" });
    }
  }

  const apps = await detected();
  const chosen = picks();
  const app = chooseApp(apps, slot, chosen[slot]);
  if (!app) return send(res, 409, { error: `no ${slot === "git" ? "git client" : slot} was found on this machine` });
  const terminal = app.id === "lazygit" ? chooseApp(apps, "terminal", chosen.terminal) : null;
  const spec = launchSpec(app, { folder: where, file, terminal });
  if (!spec) return send(res, 409, { error: "this app cannot be opened here" });
  if (spec.refused) return send(res, 409, { error: REFUSAL_WORDS[spec.refused] ?? "this folder cannot be opened here" });

  // Still there? Uninstalled since the last look means a button that does
  // nothing, so the look is thrown away and the answer says why. Asked the way
  // detection asks: a plain stat would call Windows Terminal's alias gone.
  if (!(await pathExists(app.target.path))) {
    forgetHandoffApps();
    return send(res, 409, { error: `${app.name} is no longer on this machine` });
  }

  launcher(spec.file, spec.args, {
    cwd: spec.cwd,
    env: launchEnv(process.env),
    ownGroup: true,
    window: true,
    verbatim: spec.verbatim === true,
  });
  return send(res, 200, { ok: true, app: { id: app.id, name: app.name } });
}
