// How `ccdeck` stops dying with the terminal it was typed into.
//
// The deck was a daemon in everything but its lifecycle. It holds the hooks
// Claude Code posts every event to, it answers the LAN beacon that lets paired
// machines repair each other's expired logins, and it watches the quota that
// auto-switch trips on — and all three stopped the moment a window closed. That
// is the wrong unit: those things should be true for as long as the machine is
// awake, not for as long as somebody keeps a tab of a terminal open.
//
// NODE CANNOT DAEMONISE ITSELF. There is no fork(2), so "run in the background"
// is always a detached CHILD plus a parent that leaves. This file is the parent.
// It spawns bin/agent-dag.js again — marked, so the copy does not do this a
// second time — in its own process group, watches it come up, and exits.
//
// WHERE THE CHILD'S OUTPUT GOES, and why it is not a pipe. A pipe dies with this
// process: the moment the launcher exits, the read end closes and every later
// write in the deck is an EPIPE on an unhandled 'error' — which ends the deck we
// just detached, minutes or hours later, for no reason a user could ever trace.
// So the child's stdout and stderr are a FILE from the first instruction, and
// the terminal is fed by TAILING that file rather than by holding a pipe open.
// One sink, no handover, nothing to break when the launcher goes.
//
// That file is `deck.log`, and it is truncated only when no deck is registered
// on this machine. A running deck holds an open descriptor into it, so
// truncating underneath one would punch a hole in the log of a deck nobody
// asked to disturb — and the case that reaches here with a deck already up is
// the attach, which has six lines to say and no business erasing anything.
//
// COLOUR IS PASSED DOWN, MOTION IS NOT. Writing to a file makes `isTTY` false in
// the child, which switches off both — so FORCE_COLOR and COLUMNS are handed
// over to bring the colour and the layout back, and the pulse line stays off
// because motionOK asks isTTY directly and nothing overrides it. The trade is
// that deck.log carries escape sequences: it is a mirror of the terminal the
// deck was started from, which is what makes `--logs` worth reading, and the
// launcher passes nothing at all when it is not itself a terminal.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

/** The marker that stops the child doing this again. A fork bomb is the only
 *  way this file can fail catastrophically, so the guard is one variable with
 *  one spelling, read in exactly one place. */
export const DETACHED_ENV = "AGENTS_DECK_DETACHED";

/** What the deck wrote where a terminal would have shown it. Beside
 *  `events.jsonl`, which is the agents' events rather than the deck's own
 *  voice — two different logs, and conflating them was never on the table. */
export const DECK_LOG = "deck.log";

/**
 * Truncate this log, or append to it?
 *
 * Truncated when nothing is registered, which is the ordinary start and the
 * only moment the previous contents are certainly nobody's. Appended otherwise,
 * because a registered deck is holding an open descriptor at some offset into
 * this very file: truncating under it does not make it start again at zero, it
 * makes its next write land past the end and leave a hole.
 */
export function logMode(liveCount) {
  return liveCount > 0 ? "a" : "w";
}

/**
 * What to add to the child's environment.
 *
 * Only ever additions, and only the two the child cannot work out for itself.
 * Nothing is passed when the launcher is not a terminal — a piped or CI start
 * gets a plain log file, which is what a log file should be when nobody is
 * watching it be written.
 */
export function detachEnv({ isTTY = false, profile = "none", columns = 0 } = {}) {
  const out = { [DETACHED_ENV]: "1" };
  if (!isTTY || profile === "none") return out;
  // The tier this terminal was detected at, in FORCE_COLOR's own grammar, so
  // the child's colorProfile lands on the same answer rather than on "colour,
  // at the safe floor".
  out.FORCE_COLOR = profile === "truecolor" ? "3" : profile === "ansi256" ? "2" : "1";
  if (Number.isInteger(columns) && columns > 0) out.COLUMNS = String(columns);
  return out;
}

/**
 * The command that ends it, spelled the way this user would have to type it.
 *
 * An npx run has no `ccdeck` on PATH — that is the whole point of npx — so
 * telling one to run `ccdeck --stop` is telling them to run something that does
 * not exist on their machine. `invokedAs` already answers which of the three
 * published names was typed; this only decides whether `npx ` goes in front.
 */
export function stopCommand({ npx = false, invokedAs = null, product = "ccdeck" } = {}) {
  const name = invokedAs || product;
  return npx ? `npx ${name} --stop` : `${name} --stop`;
}

/**
 * Copy a growing file to a stream, from an offset, until told to stop.
 *
 * Polled rather than watched. `fs.watch` is three different implementations
 * with three different truths about append-only writes, and the thing being
 * watched here lives for a few seconds; 40ms of latency on a boot report is
 * invisible and the code is the same on every platform.
 */
export function tailFile(path, out, { from = 0, everyMs = 40 } = {}) {
  let fd = null;
  let at = from;
  let stopped = false;
  const buf = Buffer.alloc(64 * 1024);
  const pump = () => {
    if (fd === null) {
      try { fd = openSync(path, "r"); } catch { return; }
    }
    for (;;) {
      let n = 0;
      try { n = readSync(fd, buf, 0, buf.length, at); } catch { return; }
      if (n <= 0) return;
      at += n;
      try { out.write(Buffer.from(buf.subarray(0, n))); } catch { return; }
    }
  };
  const timer = setInterval(pump, everyMs);
  timer.unref?.();
  return {
    pump,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      // One last read, always: the deck's final lines are usually written in the
      // same tick as the message that says it is up.
      pump();
      try { if (fd !== null) closeSync(fd); } catch { /* nothing to close */ }
    },
  };
}

/**
 * Spawn the detached copy, show its boot, and leave.
 *
 * Never returns. Every way out of this function is an exit, because the whole
 * contract of the launcher is that the terminal comes back:
 *
 *   the deck came up      → print the background line, unref, exit 0
 *   the child exited first → whatever it wrote is already on screen (the attach
 *                            prints and exits 0 through exactly this path), so
 *                            exit with its code
 *   Ctrl+C while waiting  → the child is in its own process group and the
 *                            terminal's signal never reached it, so it is ended
 *                            here. You interrupted a start, not a running deck.
 */
export async function detachAndWatch({
  file,
  argv = [],
  logDir,
  liveCount = 0,
  env = process.env,
  out = process.stdout,
  isTTY = false,
  profile = "none",
  columns = 0,
  execPath = process.execPath,
  spawnFn = spawn,
  backgroundLine = "",
  exit = (code) => process.exit(code),
} = {}) {
  const path = join(logDir, DECK_LOG);
  try { mkdirSync(logDir, { recursive: true }); } catch { /* reported by the open below */ }

  const mode = logMode(liveCount);
  // Where the terminal starts reading. An append leaves the previous deck's log
  // alone and shows only what this child writes.
  const from = mode === "a" ? (() => { try { return statSync(path).size; } catch { return 0; } })() : 0;

  let fd;
  try {
    fd = openSync(path, mode, 0o600);
  } catch (err) {
    // A log we cannot open is not a reason to refuse to start. Say so once and
    // run in the foreground, which is exactly what every version before this
    // one did.
    return { ok: false, reason: err?.code ?? "log_unwritable" };
  }

  const child = spawnFn(execPath, [file, ...argv], {
    detached: true,
    // ONE FILE for both streams, and an IPC channel that is the only thing this
    // launcher and that deck ever say to each other: "I am up".
    stdio: ["ignore", fd, fd, "ipc"],
    env: { ...env, ...detachEnv({ isTTY, profile, columns }) },
    windowsHide: true,
  });
  // Ours to close: the child holds its own duplicate.
  try { closeSync(fd); } catch { /* already gone */ }

  const tail = tailFile(path, out, { from });
  let done = false;
  const finish = (code) => {
    if (done) return;
    done = true;
    tail.stop();
    exit(code);
  };

  child.on("message", (m) => {
    // `booted`, not `listening`. The port is bound well before the report is
    // finished — the server-ready row, the log row and the browser line are all
    // written after it — so leaving on `listening` would cut the last three
    // lines of every boot off the terminal and leave them in the file.
    if (!m || typeof m !== "object" || m.type !== "booted" || done) return;
    tail.stop();
    if (backgroundLine) { try { out.write(backgroundLine); } catch { /* the terminal went */ } }
    // Nothing more will be said to each other. Disconnect before unref so the
    // child is not left holding a channel to a process that has exited.
    try { child.disconnect(); } catch { /* already closed */ }
    child.unref();
    finish(0);
  });

  child.on("exit", (code, signal) => finish(signal ? 1 : (code ?? 0)));
  child.on("error", () => finish(1));

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      // It is in its own process group, so the terminal's Ctrl+C did NOT reach
      // it. Without this the interrupted start would carry on in the background
      // and the user would have interrupted nothing at all.
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      finish(130);
    });
  }

  // Held open by the child handles above until one of them exits the process.
  return new Promise(() => {});
}
