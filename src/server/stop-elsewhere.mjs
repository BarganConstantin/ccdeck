// Stop there and resume here: ending the Claude Code process that holds a
// session in a terminal outside the deck, so the pane's Resume here after exit
// continues the same conversation here (use-terminal-session.ts).
//
// THE PROCESS IS NOT THE DECK'S. The user started it in a terminal of their
// own, so the deck holds no child, no pane and no job for it: only a pid, read
// off the record Claude Code writes for every live session
// (<config dir>/sessions/<pid>.json, process-identity.mjs). A pid is a number
// the kernel hands out again, so it is signalled only on evidence that it is
// still the process that wrote that record, and that the record is this
// session's:
//
//   - the record names the session, and is not from another machine or pid
//     namespace (a devcontainer sharing the config dir);
//   - it carries the start time Claude Code wrote, and the process holding the
//     pid now started at exactly that time. A record without one is NOT
//     evidence enough to signal anything (`unverifiable`): terminal-target
//     falls back to the command line for a lookup, never here;
//   - the command line is still Claude Code's, and an interactive session's
//     (not a print, an attach client, a host or a maintenance command);
//   - it is not a background session: that one has a door of its own, and its
//     pty host would only start it again (`background`);
//   - on Linux, the process works in the session's own folder, both sides
//     resolved (`unverifiable` otherwise). macOS has no cheap way to read
//     another process's folder, so there the start time carries it;
//   - exactly one live process passes for the session (`not-found`,
//     `ambiguous`);
//   - it is not the deck, nor anything the deck runs under (`shared-parent`):
//     a deck started from inside that Claude session would go down with it.
//
// ONE SIGNAL, AND A POLITE ONE. SIGTERM to that one pid: never a negative pid
// or a process group, never SIGKILL, never a `kill` binary. Claude Code ends on
// it as it ends on /exit, keeping the conversation up to there. There is no
// forced stop: a Claude that does not end is the user's to exit there.
//
// THE PID STAYS HERE. The pane is never told one (docs/contracts, "Never
// sent"): the check answers an opaque token for the holder it found, the stop
// brings it back, and the holder is looked up again at that moment. A token
// that no longer names the holder found then is a session that changed in
// between, and nothing is signalled.
//
// WHY EVERYTHING IS A PARAMETER. As in terminal-target.mjs: every read of the
// filesystem, /proc and `ps`, the deck's own pid and the signal itself go
// through `deps`, so the suite runs every refusal on fixtures and signals
// nothing but a stand-in it started itself.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { claudeConfigDir } from "./claude-dir.mjs";
import {
  NOT_A_SESSION, PTY_HOST, ancestry, collapse, foreignRecord, looksLikeClaude, procView, psView, readClaudeSessions, readPsTable,
} from "./process-identity.mjs";

/** The platforms whose process tables this reads: /proc, and `ps` on macOS.
 *  Windows has no signal to send, and its sessions run in the session host. */
export const STOP_PLATFORMS = Object.freeze(["linux", "darwin"]);

/** The shape of a token: what holderToken answers, and all a stop accepts. */
export const STOP_TOKEN = /^[0-9a-f]{32}$/;

/** How long a stop that was sent is remembered, by its holder: a second stop
 *  for the same process meanwhile (another tab, a press repeated after Cancel)
 *  is answered as under way and sends nothing more. As long as the pane waits
 *  before it says Claude has not stopped yet. */
export const STOP_SENT_FOR_MS = 15_000;

/** The key a token is made with, one per deck process: a token says nothing
 *  of the pid or the start time it names, and one from before a restart names
 *  nothing (a stop with it answers `changed`). */
const TOKEN_KEY = randomBytes(32);

/** The stops sent lately: token → when. One map per deck process. */
const SENT = new Map();

/**
 * The token for a holder: the first 32 hex characters of an HMAC-SHA256 over
 * `sessionId|pid|start`, under the deck's own key. `key` is for tests.
 */
export function holderToken(sessionId, holder, key = TOKEN_KEY) {
  return createHmac("sha256", key)
    .update(`${String(sessionId).toLowerCase()}|${holder.pid}|${holder.start}`)
    .digest("hex")
    .slice(0, 32);
}

function ioFor(deps) {
  return {
    platform: deps.platform ?? process.platform,
    claudeDir: deps.claudeDir ?? claudeConfigDir(),
    readdir: deps.readdir ?? ((p) => readdirSync(p)),
    readFile: deps.readFile ?? ((p) => readFileSync(p, "utf8")),
    readlink: deps.readlink ?? ((p) => readlinkSync(p)),
    realpath: deps.realpath ?? ((p) => realpathSync(p)),
    processTable: deps.processTable ?? readPsTable,
    selfPid: deps.selfPid ?? process.pid,
  };
}

/**
 * The one process that holds `session` ({ sessionId, cwd }) in a terminal
 * outside the deck, as `{ ok: true, pid, start }`, or `{ ok: false, reason }`
 * with why it may not be signalled (see the header for each reason). Reads
 * only; never rejects for a state of the machine.
 *
 * `deps`, every one optional: platform, claudeDir, readdir/readFile/readlink/
 * realpath (synchronous), processTable (async; the `ps` table where there is
 * no /proc) and selfPid (the deck's own pid, whose ancestry is refused).
 */
export async function findHolder(session, deps = {}) {
  const io = ioFor(deps);
  const sessionId = String(session?.sessionId ?? "").toLowerCase();
  const proc = io.platform === "linux" ? procView(io) : await psView(io);
  const here = proc.domain();
  const found = [];
  for (const rec of readClaudeSessions(io.claudeDir, io)) {
    if (rec.sessionId.toLowerCase() !== sessionId || foreignRecord(rec, here)) continue;
    const p = proc.info(rec.pid);
    // No such process: a record left behind by a Claude that has ended.
    if (!p) continue;
    if (rec.procStart == null || p.start == null) {
      // Nothing to compare, so nothing proves this is the process that wrote
      // the record. A Claude there may still be the session: it is counted,
      // and can never be signalled. Anything else is a recycled pid.
      if (looksLikeClaude(p.cmd)) found.push({ reason: "unverifiable" });
      continue;
    }
    // Another process under a recycled pid.
    if (collapse(rec.procStart) !== collapse(p.start)) continue;
    found.push(judge(rec, p, session, io, proc));
  }
  if (found.length === 0) return { ok: false, reason: "not-found" };
  if (found.length > 1) return { ok: false, reason: "ambiguous" };
  const [one] = found;
  return one.reason ? { ok: false, reason: one.reason } : { ok: true, pid: one.pid, start: one.start };
}

/** What the live process a record names may be: the holder, or why not. */
function judge(rec, p, session, io, proc) {
  const words = String(p.cmd).split(" ").slice(1);
  if (!looksLikeClaude(p.cmd) || words.some((w) => NOT_A_SESSION.test(w))) return { reason: "unverifiable" };
  // The parent only, as terminal-target decides it (WHY BACKGROUND BEFORE TMUX).
  const chain = ancestry(proc, rec.pid);
  if (rec.kind === "bg" || (chain.length > 1 && PTY_HOST.test(chain[1].cmd))) return { reason: "background" };
  if (io.platform === "linux" && !sameFolder(io, rec.pid, session?.cwd)) return { reason: "unverifiable" };
  if (rec.pid <= 1 || rec.pid === io.selfPid || deckChain(io, proc).has(rec.pid)) return { reason: "shared-parent" };
  return { pid: rec.pid, start: collapse(p.start) };
}

/** Whether the process works in the session's folder: both resolved, so a
 *  link on either side is no difference, and a folder that is gone (or cannot
 *  be read) is no evidence. */
function sameFolder(io, pid, cwd) {
  if (typeof cwd !== "string" || !cwd) return false;
  try {
    return String(io.realpath(`/proc/${pid}/cwd`)) === String(io.realpath(cwd));
  } catch {
    return false;
  }
}

/** The deck's own pid and every process above it, read with the same view. */
function deckChain(io, proc) {
  return new Set([io.selfPid, ...ancestry(proc, io.selfPid).map((c) => c.pid)]);
}

/** The check: a token for the holder, or why there is none. Signals nothing. */
export async function checkStop(session, deps = {}) {
  const holder = await findHolder(session, deps);
  if (!holder.ok) return { ok: false, reason: holder.reason };
  return { ok: true, token: holderToken(session.sessionId, holder, deps.key) };
}

/**
 * The stop: the holder looked up again, its token compared with the one the
 * check gave, and SIGTERM to that one pid. Answers `{ ok: true, stopping: true
 * }` once it is sent, `{ ok: true, gone: true }` for a process that had ended
 * by then, or `{ ok: false, reason }`: `changed` when the token names another
 * holder than the one there now (or none), `signal-failed` when the signal was
 * refused. Nothing is signalled on any refusal.
 *
 * `deps` as findHolder, and: kill(pid, signal), sent (the map of stops sent
 * lately), now and key, for tests.
 */
export async function stopHolder(session, token, deps = {}) {
  const holder = await findHolder(session, deps);
  // No live process holds the session any more: it ended between the check
  // and the stop, by itself or from its own terminal. That is what the stop
  // was for, so it answers as one that ended, and the pane's wait resumes it.
  if (!holder.ok && holder.reason === "not-found") return { ok: true, gone: true };
  if (!holder.ok || !sameToken(holderToken(session.sessionId, holder, deps.key), token)) return { ok: false, reason: "changed" };
  const pid = holder.pid;
  if (!Number.isInteger(pid) || pid <= 1) return { ok: false, reason: "changed" };
  // From the look above to the signal, nothing waits: two stops at once
  // cannot both pass this.
  const sent = deps.sent ?? SENT;
  const now = (deps.now ?? Date.now)();
  for (const [t, at] of sent) if (now - at >= STOP_SENT_FOR_MS) sent.delete(t);
  if (sent.has(token)) return { ok: true, stopping: true };
  const kill = deps.kill ?? ((p, signal) => process.kill(p, signal));
  try {
    kill(pid, "SIGTERM");
  } catch (err) {
    return err?.code === "ESRCH" ? { ok: true, gone: true } : { ok: false, reason: "signal-failed" };
  }
  sent.set(token, now);
  return { ok: true, stopping: true };
}

function sameToken(a, b) {
  if (typeof b !== "string" || !STOP_TOKEN.test(b) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
