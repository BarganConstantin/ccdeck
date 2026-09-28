// The one spelling of a directory the deck compares against: the
// `--workspace` flag, and the cwd a Codex rollout says it ran in.
//
// These lived in src/server/index.mjs, between the health payload's workspace
// and the Clear route. Neither touches the server: canonicalWorkspace runs once
// in bin/deck.js before a server exists, and canonicalCwd is a realpath the
// rollout watcher asks for once per file. So they moved to a leaf, unchanged,
// and index.mjs imports the one it calls and re-exports both under the names
// bin/deck.js and the tests have always imported.
import { realpath as realpathCb, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

/**
 * The one spelling of `--workspace` everything downstream compares against.
 * Empty — including a value that is nothing but spaces — stays empty, which is
 * how every reader of it says "machine-wide".
 *
 * Called once, in bin/deck.js, where the flag arrives: that process's cwd is the
 * shell the user typed the command in, and it is the only process on either
 * capture path whose cwd is the one a relative `--workspace ./sub` was written
 * against. The raw string used to go straight into the discovery file, and
 * hook.js resolved it inside its own process — which the host CLI runs with the
 * AGENT's cwd — so `--workspace ./sub` scoped Claude sessions to a `sub`
 * directory under whatever the agent happened to be working in, a different
 * directory per agent and none of them the one asked for. The Codex path
 * resolved the same string in the server process and was right. Resolving here
 * makes both of them right, and for the same reason bin/deck.js already resolves
 * the events log before publishing it: what goes in the discovery file is read
 * by other processes that cannot reconstruct the context it was written in.
 *
 * Symlinks are resolved too, so that `--workspace /tmp/proj` on a Mac is not
 * scoped to /tmp/proj while every session inside it reports /private/tmp/proj,
 * leaving the deck empty. A path that does not exist yet keeps its resolved form
 * rather than failing: scoping a deck to a directory you are about to create is
 * not an error.
 *
 * That resolution is only half the rule. Canonicalising the flag means nothing
 * unless the cwd it is compared against is canonicalised the same way, and that
 * is a separate job on each capture path: hook.js does it with normPath, and the
 * rollout watcher does it with canonicalCwd below. This comment used to claim
 * the second half came for free — that "a process's cwd comes from getcwd() and
 * has none left in it" — which is true on POSIX and false on Windows. See
 * canonicalCwd.
 *
 * WHICH REALPATH, AND WHY IT IS `.native` AT ALL THREE SITES. Node ships two
 * implementations with different Windows behaviour, and picking one per site is
 * how the flag and the two cwd paths end up meaning different things again:
 *
 *   fs.realpathSync / fs.realpath  a JavaScript lstat-and-readlink walk. It
 *                                  resolves symlinks and junctions and NOTHING
 *                                  else — a DOS 8.3 short component survives it
 *                                  untouched.
 *   …Sync.native / …native / the   uv_fs_realpath, which on Windows is
 *   fs/promises realpath           GetFinalPathNameByHandleW: symlinks and
 *                                  junctions, the UNC form of a mapped drive,
 *                                  the LONG form of an 8.3 short name, and the
 *                                  on-disk case of every component.
 *
 * The long form is the canonical one, and not by preference: it is the only
 * spelling that is a fixed point. Short names are an alias for the same
 * directory exactly as a junction is, they cannot be derived back from the long
 * form (8.3 generation can be disabled per volume), and they are not a corner
 * case a test invented — `%TEMP%` under a shortened profile directory answers
 * with one, which is what every GitHub Windows runner has. It is also already
 * this codebase's answer: persistAuth in src/server/codex-auth.mjs resolves
 * through the fs/promises realpath, i.e. this one.
 *
 * So all three sites name `.native` explicitly rather than one of them reaching
 * for whichever realpath came to hand. Being explicit is the point — the reason
 * this had to be said twice is that fs/promises' realpath IS the native one
 * while its sync namesake is not, an equivalence nothing documents and no reader
 * should have to know.
 */
export function canonicalWorkspace(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return "";
  const abs = resolve(raw);
  try { return realpathSync.native(abs); } catch { return abs; }
}

// The async half of the rule canonicalWorkspace states above, named the same way
// it is: fs.realpath.native is the documented callback form of uv_fs_realpath,
// and promisifying it says which realpath this is at the point of use. The
// fs/promises realpath is the same call and would have read as if it were the
// JavaScript one.
const realpathNative = promisify(realpathCb.native);

/**
 * The one spelling of the directory a Codex session says it is running in —
 * hook.js's normPath, for the capture path that never goes through the hook.
 *
 * `--workspace` is canonicalised above before anything compares against it, and
 * the Claude side canonicalises the session's cwd to match: hook.js runs every
 * incoming cwd through normPath (resolve + realpath) before asking
 * capturesSession. The Codex side compared the rollout header's `cwd` raw, and
 * the comment above said that was safe because a cwd comes from getcwd(), which
 * has already resolved every link.
 *
 * That is true of getcwd(3) and not true of Windows. There the current directory
 * is stored as the string it was set with, and GetCurrentDirectoryW — what
 * Rust's std::env::current_dir() behind Codex calls — hands that string back
 * without resolving a junction, a `subst` drive or a mapped network drive.
 * realpath does resolve them, and on a mapped drive goes further and returns the
 * UNC form, because libuv asks GetFinalPathNameByHandleW. So a deck started as
 * `--workspace Z:\proj` scoped itself to `\\server\share\proj`, the Claude
 * session in that tree reported `Z:\proj` and was realpath'd into the workspace
 * and drawn, and the Codex session beside it reported `Z:\proj` in its rollout
 * header, was compared raw, and silently never appeared — no error printed
 * anywhere, the banner still claiming the rollout watcher was running. The same
 * asymmetry runs in reverse for a user who passes the resolved path and works
 * through the junction. The log election went wrong with it: writesCodexLog
 * models the OTHER decks' capture with this same predicate against their
 * published (canonical) workspaces, so it was picking the wrong group.
 *
 * Called at the one read of the header (readCodexHeader, in codex-watch.mjs)
 * rather than inside codexCwdInWorkspace: the result is cached in codexFileState for
 * the life of the file, so it costs one realpath per rollout instead of one per
 * tick, and it leaves the predicate the pure string function that lets it be
 * pinned against hook.js's copy in a test.
 *
 * `.native`, for the reason canonicalWorkspace sets out at length: three sites
 * canonicalise a path against each other and all three must fold the same way,
 * 8.3 short names included. Case IS canonicalised as a side effect — that is
 * what GetFinalPathNameByHandleW and realpath(3) on a case-insensitive volume
 * return — but nothing here DEPENDS on it: the two predicates still fold case
 * per-platform themselves, which is the only place that decision can stay
 * correct on Linux, where /srv/Proj and /srv/proj are two real directories and
 * realpath quite rightly keeps them apart.
 *
 * Async, unlike canonicalWorkspace, because of where each one runs.
 * canonicalWorkspace runs once in bin/deck.js before the server exists, so
 * blocking there costs nothing. This runs inside the watcher's 1.5s tick, in the
 * live event loop, against a path a rollout recorded some time ago — which on
 * the very platform this exists for is quite likely to name a mapped drive that
 * is no longer connected, and a synchronous realpath on one of those blocks the
 * whole dashboard until SMB times out.
 *
 * A cwd that no longer resolves keeps its resolved form, exactly as the flag
 * does: a deleted directory or a disconnected drive is not a reason to drop a
 * session the deck can still draw, and the resolved string is the best answer
 * available — for a rollout recorded in the tree the deck is scoped to and never
 * moved, it is also the right one. Anything that is not a non-empty string is
 * null, which is what readCodexHeader returned before and what both copies of
 * the predicate read as "this session never said where it runs".
 */
export async function canonicalCwd(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const abs = resolve(raw);
  try { return await realpathNative(abs); } catch { return abs; }
}
