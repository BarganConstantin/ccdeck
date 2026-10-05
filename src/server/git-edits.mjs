// The files a session's agents edited, as paths in its repository — what the
// git view marks in its file lists, and what the collision check compares.
//
// The edit tracker (agent-git-edits.mjs) keeps each edit as the absolute path
// the agent's tool named. A repository answers in paths relative to its top
// level, and git names that top level by its real path, so an edit is placed
// in the repository lexically when it can be, and else by the real path of its
// folder: a session started in a symlinked folder (/tmp against /private/tmp,
// a junction on Windows) names its files through the link. An edit outside the
// repository is not one of its files and is left out.
//
// Only edits made through an edit tool are here (Claude's Edit, Write,
// MultiEdit and NotebookEdit; Codex's apply_patch). A file changed from a shell
// is not, because nothing says which agent's command changed it — the view
// labels these marks as inferred from edits for that reason.
import { realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { agentGit, editsFor } from "./agent-git-tap.mjs";

const WINDOWS_ABS = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/** `path` relative to `top` with forward slashes, as git spells it, or null
 *  when it is not strictly inside. Lexical only. */
export function relativeIn(top, path, platform = process.platform) {
  if (typeof top !== "string" || !top || typeof path !== "string" || !path) return null;
  const flavour = platform === "win32" || WINDOWS_ABS.test(top) ? win32 : posix;
  if (!flavour.isAbsolute(path)) return null;
  let rel = flavour.relative(top, path);
  // macOS folds case like Windows does, and posix.relative does not.
  if (platform === "darwin" && rel.startsWith("..")) {
    const t = flavour.normalize(top).replace(/\/+$/, "");
    const p = flavour.normalize(path);
    if (p.toLowerCase().startsWith(`${t.toLowerCase()}/`)) rel = p.slice(t.length + 1);
  }
  if (!rel || rel === ".." || rel.startsWith(`..${flavour.sep}`) || flavour.isAbsolute(rel)) return null;
  return rel.split(flavour.sep).join("/");
}

/**
 * Each path's place in the repository at `top`, or null when it is not in it.
 * A path that is not lexically inside is tried again by the real path of the
 * nearest folder on it that still exists.
 *
 * @param {string} top the repository's top level, as git named it
 * @param {string[]} paths absolute paths
 * @returns {Promise<Map<string, string | null>>}
 */
export async function placeInRepo(top, paths, { platform = process.platform } = {}) {
  const out = new Map();
  const realTop = await realpath(top).catch(() => top);
  const flavour = platform === "win32" || WINDOWS_ABS.test(top) ? win32 : posix;
  const realDirs = new Map(); // folder -> its real path, or null
  const realDir = async (dir) => {
    if (!realDirs.has(dir)) realDirs.set(dir, await realpath(dir).catch(() => null));
    return realDirs.get(dir);
  };
  for (const path of paths) {
    if (out.has(path)) continue;
    let rel = relativeIn(top, path, platform) ?? relativeIn(realTop, path, platform);
    if (rel === null && typeof path === "string" && flavour.isAbsolute(path)) {
      // The file may be gone (deleted, renamed): walk up to a folder that is not.
      let dir = flavour.dirname(path);
      let rest = flavour.basename(path);
      for (let i = 0; i < 8 && rel === null; i++) {
        const real = await realDir(dir);
        if (real) { rel = relativeIn(realTop, flavour.join(real, rest), platform); break; }
        const up = flavour.dirname(dir);
        if (up === dir) break;
        rest = flavour.join(flavour.basename(dir), rest);
        dir = up;
      }
    }
    out.set(path, rel);
  }
  return out;
}

/** What a session or one of its subagents is called, as far as the deck
 *  knows: the session's name, or the subagent's type. */
export function agentLabel(sessionId, agentId = null) {
  const f = agentGit.facts.snapshot(sessionId, agentId);
  return (agentId ? f.agentType : f.sessionName || f.sessionTitle) || null;
}

/**
 * The files the session's agents edited inside `repo`, newest first:
 * `[{ path, agentId, label, at }]`, one row per agent per file. The whole
 * session — main thread and every subagent — unless `agentId` names one
 * subagent.
 *
 * @param {{ topLevel: string }} repo a resolved repository (git-repo.mjs)
 * @param {string} sessionId
 * @param {string | null} [agentId]
 */
export async function sessionEdits(repo, sessionId, agentId = null) {
  const rows = agentId ? editsFor(sessionId, { agentId }) : editsFor(sessionId, { includeSubagents: true });
  const placed = await placeInRepo(repo.topLevel, rows.map((r) => r.path));
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const path = placed.get(r.path);
    if (!path) continue;
    // Two spellings of one file by one agent are one row: the newest.
    const key = `${r.agentId ?? ""}\0${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path, agentId: r.agentId ?? null, label: agentLabel(sessionId, r.agentId ?? null), at: r.at });
  }
  return out;
}
