// The children exec.mjs starts, and how they are stopped.
//
// Two things, and neither is about how a command is spelled: `killTree`, which
// on Windows has to reach the tool UNDER a cmd.exe wrapper as well as the
// wrapper, and the set of children still running, which shutdown() empties so a
// deadline that dies with the deck cannot leave its child orphaned (#1012).
// Every deadline in exec.mjs ends in one or the other.
//
// exec.mjs wraps each child it spawns in `watchChild` and re-exports the rest,
// so a caller that imports killTree, liveChildPids or killLiveChildren from
// there still does.
import { spawn } from "node:child_process";

/**
 * Stop a child AND everything it started.
 *
 * On POSIX the child is the tool, so a signal to it is the whole job and this
 * is exactly the `child.kill()` it replaces. On Windows a .cmd or .bat runs
 * THROUGH cmd.exe (see viaCmd), so the tool — node, for the claude and npm
 * shims — is a grandchild, and a kill is one TerminateProcess against the
 * wrapper. Windows terminates no descendants and libuv's job object lets them
 * break away, so the wrapper vanished and the work carried on: every cancelled
 * or expired `claude auth login` left a node.exe blocked forever on the stdin
 * pipe this process holds, and because that node.exe kept the inherited stdout
 * handle open, the wrapper's 'close' never arrived either — the run that was
 * reported dead never settled.
 *
 * `taskkill /T` is the descendant walk Windows does have, and `/F` is what
 * stops a console app that is not pumping its message queue. Taking it from
 * System32 rather than from PATH matters here: PATH is the user's, and this is
 * the program we hand a pid to kill. If it cannot run at all, the plain kill
 * still happens, which is no worse than before.
 *
 * A process group would be the tidier answer and is the wrong one on Windows:
 * `detached` there only means CREATE_NEW_PROCESS_GROUP, and Node cannot signal
 * a group — `process.kill(-pid)` is POSIX-only.
 */
export function killTree(child, signal) {
  const plain = () => { try { child?.kill(signal); } catch { /* already gone */ } };
  if (process.platform !== "win32" || !child?.pid) return plain();
  try {
    const root = process.env.SystemRoot || process.env.systemroot;
    const exe = root ? `${root}\\System32\\taskkill.exe` : "taskkill";
    const killer = spawn(exe, ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore", windowsHide: true,
    });
    killer.on("error", plain);
    killer.on("exit", (code) => { if (code !== 0) plain(); });
    killer.unref?.();
  } catch {
    plain();
  }
}

/**
 * Every child this module started and has not yet seen the end of.
 *
 * A deadline is not a promise unless something is alive to enforce it, and the
 * deadlines in this file all live in the parent: `run` states the outcome on a
 * timer and only then kills, `runInteractive` does the same. Kill the parent
 * and the timer dies with it, so the very case a deadline exists for — a tool
 * that has hung — is the one case where nothing is left to stop it.
 *
 * Observed (#1012). A sandboxed deck, a quota poll in flight, SIGINT to the
 * deck at 05:26:22.706. The deck was gone within 200ms; its `claude --print
 * /usage` child, spawned at 05:26:18.078 under a 15-second deadline, was still
 * running at 05:26:35.204 — reparented to init, past the deadline the dead
 * parent would have enforced, and with nothing anywhere that would ever kill
 * it. A whole Claude Code process, hundreds of MB resident, orphaned by a
 * Ctrl+C.
 *
 * REMOVED ON 'close', NOT ON 'exit', and the difference is Windows'. A batch
 * candidate runs THROUGH cmd.exe and the tool is a grandchild (see viaCmd and
 * killTree): the wrapper can exit while the tool underneath goes on holding
 * the inherited stdio, which is exactly the shape killTree's `taskkill /T`
 * exists for. 'exit' there means "the wrapper is gone" and 'close' means "and
 * so is everything it started" — forgetting on the first would drop a tree
 * that is still running and still reachable. 'error' is the third way a child
 * ends, and the only one after which 'close' may never come at all.
 *
 * `runDetached` is deliberately absent. It is the one function here named for
 * outliving its call — a sound, or a collection whose result lands in a file
 * the next poll reads — it holds no deadline, and it unrefs its child on
 * purpose. Killing those on the way out would be this set overreaching.
 */
const live = new Set();

/** Track one child until it ends. Returns it, so it can wrap a spawn inline. */
export function watchChild(cp) {
  if (!cp) return cp;
  live.add(cp);
  const forget = () => { live.delete(cp); };
  cp.once?.("close", forget);
  cp.once?.("error", forget);
  return cp;
}

/**
 * The pids of the children this deck still has running.
 *
 * Exported for the test below this, and because it is the honest answer to
 * "what is this deck still doing" that a future `--status` wants. It may
 * over-report by one in the Windows case above — a wrapper whose 'close' never
 * arrives stays here — which is the right direction to be wrong in: that entry
 * names a process that really is still running.
 */
export const liveChildPids = () => [...live].map(c => c?.pid).filter(Boolean);

/**
 * Stop every child this module started, and everything they started.
 *
 * Called from shutdown(), where the alternative is the orphan above. It does
 * not WAIT for the corpses, on purpose: a signal is delivered synchronously on
 * POSIX, and on Windows killTree's taskkill is a process of its own that
 * CreateProcess has already started by the time spawn() returns and that
 * outlives this one. Waiting would buy nothing and would spend the ~200ms exit
 * that is the rest of shutdown's good behaviour.
 *
 * The set is cleared first so a 'close' arriving mid-loop cannot mutate what
 * is being iterated, and so a second call — shutdown can be reached twice —
 * has nothing left to do.
 */
export function killLiveChildren(signal) {
  const doomed = [...live];
  live.clear();
  for (const cp of doomed) killTree(cp, signal);
  return doomed.length;
}
