// Ending a deck that is not our child.
//
// `ccdeck --stop` holds a pid and a port out of a discovery file and nothing
// else — no ChildProcess, no IPC channel, no shell job. That rules out
// exec.mjs's killTree, which takes a ChildProcess and calls `child.kill`, and it
// is why the Windows half of that function is spelled a second time here rather
// than shared: the two have the same shape and different inputs.
//
// THREE RUNGS, and each one exists for a failure the one above it cannot cover:
//
//   THE POST. /api/shutdown, with the token out of the record, ending in the
//   deck's own shutdown(): the listener closes, the registration is unlinked,
//   the LAN beacon says goodbye so paired colleagues see it LEAVE rather than
//   time out. This is the rung that behaves identically on all three platforms,
//   which is the whole reason the route exists — Windows has no signals.
//
//   SIGTERM, POSIX only. Not a fallback for a wedged deck — a wedged deck is
//   wedged for this too — but the only way to end a deck OLDER than the route,
//   which answers the POST with a 404 and would otherwise be unstoppable by its
//   own command. bin/deck.js has handled SIGTERM with shutdown(0) for years, so
//   this is still a clean exit on every version that has ever shipped.
//
//   THE HARD KILL. SIGKILL, or `taskkill /T /F` on Windows. Leaves the discovery
//   file behind for the next boot to sweep and gives the LAN no goodbye, and is
//   still better than a process the user cannot end with the tool that started
//   it — which is the outcome this whole file is written against.
//
// THE PARENT GOES FIRST on both kill rungs. A worker killed under a live
// supervisor is a worker the supervisor puts back: that is what it is for. So
// the supervisor is ended first and the worker second, which is also what the
// record's `parent` field is written for.
import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { isProcessAlive } from "./deck-probe.mjs";

/** Long enough for a loopback POST and the deck's own teardown to begin; short
 *  enough that a wedged deck does not hold the terminal. */
export const STOP_ASK_MS = 2000;
/** How long a deck gets to actually disappear after each rung. A clean shutdown
 *  drains SSE connections and closes the listener; 1500ms of that is the
 *  fallback timer in bin/deck.js's shutdown(), so this has to outlast it. */
export const STOP_GONE_MS = 3000;

/**
 * Ask one deck to end itself, politely.
 *
 * Never rejects: every failure is a verdict the caller has a next rung for. A
 * 404 is a deck too old to know the route, a refused connection is a record
 * whose port is already gone, a timeout is a deck that is not answering — and
 * all three lead to the same place.
 */
export function askDeckToStop(rec, { timeoutMs = STOP_ASK_MS, request = httpRequest } = {}) {
  return new Promise(resolve => {
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; resolve(v); };
    let req;
    try {
      req = request({
        hostname: "127.0.0.1",
        port: rec.port,
        path: "/api/shutdown",
        method: "POST",
        timeout: timeoutMs,
        headers: {
          // The one spelling the server reads. The token came out of a file
          // only this user can open, which is the whole of the access control.
          "x-ccdeck-token": String(rec.token ?? ""),
          "content-length": "0",
        },
      }, res => {
        // The body is drained rather than read: the verdict is the status, and
        // a response left unconsumed keeps the socket open past our exit.
        res.resume();
        res.on("end", () => finish({
          ok: res.statusCode === 200,
          status: res.statusCode ?? 0,
          // A route that is not there is a deck older than this feature, and
          // the caller says so rather than reporting a mysterious refusal.
          old: res.statusCode === 404,
        }));
      });
    } catch (err) {
      return finish({ ok: false, status: 0, old: false, reason: err?.code ?? "request_failed" });
    }
    req.on("error", (err) => finish({ ok: false, status: 0, old: false, reason: err?.code ?? "unreachable" }));
    req.on("timeout", () => { req.destroy(); finish({ ok: false, status: 0, old: false, reason: "timeout" }); });
    req.end();
  });
}

/**
 * End a pid and everything under it.
 *
 * exec.mjs's killTree with a pid where its ChildProcess goes — see the note at
 * the top of this file. `/T` is the half that matters: the supervisor's worker
 * is a child of the pid being ended, and on Windows there is no process group
 * to signal as one.
 *
 * On Windows a "polite" rung does not exist. `taskkill` without `/F` posts
 * WM_CLOSE to a window, and the deck has none, so the only thing to do there is
 * the forceful one — which is why the caller skips the SIGTERM rung on win32
 * rather than running it twice under a different name.
 */
export function killPidTree(pid, signal = "SIGTERM", {
  platform = process.platform, spawnFn = spawn, kill = (p, s) => process.kill(p, s),
} = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const plain = () => { try { kill(pid, signal); } catch { /* already gone */ } };
  if (platform !== "win32") return plain();
  try {
    const root = process.env.SystemRoot || process.env.systemroot;
    const exe = root ? `${root}\\System32\\taskkill.exe` : "taskkill";
    const killer = spawnFn(exe, ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.on("error", plain);
    killer.on("exit", (code) => { if (code !== 0) plain(); });
    killer.unref?.();
  } catch {
    plain();
  }
}

/** Has this pid actually gone, within the deadline? Polled rather than waited
 *  on: this process is not the parent, so there is no exit to listen for. */
async function gone(pid, { alive, deadlineMs, sleep, now }) {
  const until = now() + deadlineMs;
  for (;;) {
    if (!alive(pid)) return true;
    if (now() >= until) return false;
    await sleep(50);
  }
}

/**
 * Stop one deck, and say how it went out.
 *
 * `how` is not decoration. "asked" means the deck closed its listener, unlinked
 * its registration and left the LAN cleanly; "killed" means none of that
 * happened and the next boot has litter to sweep. A command that reported both
 * as "stopped" would hide the one case worth knowing about.
 */
export async function stopDeck(rec, {
  ask = askDeckToStop,
  alive = isProcessAlive,
  kill = killPidTree,
  platform = process.platform,
  now = Date.now,
  sleep = (ms) => new Promise(r => setTimeout(r, ms)),
  askMs = STOP_ASK_MS,
  goneMs = STOP_GONE_MS,
} = {}) {
  const wait = () => gone(rec.pid, { alive, deadlineMs: goneMs, sleep, now });
  const parent = Number.isInteger(rec.parent) ? rec.parent : null;

  const answer = await ask(rec, { timeoutMs: askMs });
  if (answer.ok && await wait()) return { ok: true, how: "asked" };

  if (platform !== "win32") {
    // Parent first: see the note at the top. A supervisor left alive over a
    // killed worker is a supervisor doing its job, which here means undoing
    // ours.
    if (parent !== null) kill(parent, "SIGTERM", { platform });
    kill(rec.pid, "SIGTERM", { platform });
    if (await wait()) return { ok: true, how: "signalled", old: answer.old === true };
  }

  if (parent !== null) kill(parent, "SIGKILL", { platform });
  kill(rec.pid, "SIGKILL", { platform });
  if (await wait()) return { ok: true, how: "killed", old: answer.old === true };

  return { ok: false, how: "stuck", reason: answer.reason ?? `http ${answer.status}` };
}
