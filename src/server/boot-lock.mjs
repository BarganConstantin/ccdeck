// Two starts at the same moment used to become two decks.
//
// THE GAP. A start asks the registry "is one of my decks already up?", and a
// deck can answer that only once it has written <config>/agent-dag/<pid>.json —
// which happens after its server has bound and its startup report has run, up
// to eight seconds later (BOOT_DEADLINE_MS). Two starts inside that window both
// read an empty registry, both start, and the second finds 4317 taken and takes
// a random port. The login item and a terminal opened at login are exactly two
// starts inside one window, and that is how one machine came to show up twice
// on a colleague's Local network list.
//
// So asking and starting become one step: a start takes this lock before it
// asks, and gives it back only once its own record is on disk. A second start
// inside the window waits for the first to register, and then finds it.
//
// A FILE, CREATED EXCLUSIVELY. `open(…, "wx")` is O_CREAT|O_EXCL on POSIX and
// CREATE_NEW on Windows: one process wins and everybody else gets EEXIST, on all
// three platforms and without a native module. It is held for seconds, not for
// the life of the deck — once a deck is registered the registry and its token
// handshake already answer "is a deck up", and a lock held forever would need
// that liveness proof all over again.
//
// A HOLDER THAT DIED IS NOT A HOLDER. A start killed inside its boot window
// leaves the file behind, and the next start must not wait on it forever. Two
// ways out, and each covers the other's blind spot: the holder's pid no longer
// answers (a crash), or the lock is older than any boot takes (a pid the OS has
// recycled into something else, which answers signal 0 forever — #695).
//
// One race is left and it is named rather than hidden: two starts that both
// judge the SAME dead lock stale can interleave so that the second removes the
// lock the first has just taken. That needs three starts inside one boot window
// right after a crash, and what it costs is the behaviour every version before
// this one had.
//
// UNGUARDED RATHER THAN STUCK. A directory this process cannot write — a
// read-only home, a permissions mistake — is answered by starting without the
// lock, which is also what every earlier version did. Refusing to start a deck
// over a lock file would be a worse bug than the one this fixes.
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { isProcessAlive } from "./deck-probe.mjs";

/** Beside the registry records, and not a `.json`: hook/hook.js and the stale
 *  sweep read only `*.json` in that directory, so neither ever sees it. */
export const BOOT_LOCK_FILE = "boot.lock";

/** Longer than any boot. BOOT_DEADLINE_MS bounds the report at 8s, and a start
 *  that replaces a running deck spends up to three stop rungs on top of it. */
export const BOOT_LOCK_STALE_MS = 30_000;

/** An empty lock is one being written this instant — unless it has looked like
 *  that for longer than a write of forty bytes can take. */
const HALF_WRITTEN_MS = 2_000;

function readHolder(file, fs) {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    return Number.isInteger(d?.pid) && Number.isFinite(d?.at) ? d : null;
  } catch {
    return null;
  }
}

function modifiedAt(file, fs) {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

/**
 * Has whoever holds this lock stopped being able to let go of it?
 *
 * `self` is here for the recycled-pid case pointed the other way: a lock left by
 * a dead process whose pid this one now has answers signal 0 — it is us — and
 * would be waited on until it went stale.
 */
export function holderIsGone(holder, { now, alive, staleMs = BOOT_LOCK_STALE_MS, mtime = null, self = process.pid }) {
  if (!holder) return mtime == null || now - mtime > HALF_WRITTEN_MS;
  if (holder.pid === self) return true;
  if (now - holder.at > staleMs) return true;
  return !alive(holder.pid);
}

/** Give the lock back, if it is still ours. A lock judged stale and taken by
 *  somebody else carries their nonce now, and removing it would hand the gap
 *  straight back to a third start. Idempotent: the second call finds nothing. */
function release(file, nonce, fs) {
  try {
    if (JSON.parse(fs.readFileSync(file, "utf8"))?.nonce !== nonce) return false;
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Take the boot lock for this registry directory, waiting for a live holder to
 * finish booting.
 *
 * Resolves `{ held, waited, release }`. `held` is false only on the unguarded
 * path; `waited` says another start was in its boot window when this one began,
 * which the caller has no use for beyond the tests. `release` is synchronous so
 * it can run from a process `exit` handler.
 */
export async function takeBootLock({
  dir,
  pid = process.pid,
  now = Date.now,
  alive = isProcessAlive,
  staleMs = BOOT_LOCK_STALE_MS,
  pollMs = 100,
  fs = nodeFs,
  sleep = (ms) => new Promise(r => setTimeout(r, ms)),
} = {}) {
  const file = join(dir, BOOT_LOCK_FILE);
  const nonce = randomBytes(8).toString("hex");
  let waited = false;
  // 0700 like the registry beside it — installer.mjs asserts the same mode on
  // the same directory, and whichever runs first creates it.
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* the open below decides */ }
  for (;;) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      try { fs.writeSync(fd, JSON.stringify({ pid, at: now(), nonce })); } finally { fs.closeSync(fd); }
      return { held: true, waited, release: () => release(file, nonce, fs) };
    } catch (err) {
      if (err?.code !== "EEXIST") return { held: false, waited, reason: err?.code ?? "open_failed", release: () => false };
    }
    const holder = readHolder(file, fs);
    if (holderIsGone(holder, { now: now(), alive, staleMs, mtime: modifiedAt(file, fs), self: pid })) {
      try { fs.unlinkSync(file); } catch { /* another start cleared it first */ }
      continue;
    }
    waited = true;
    await sleep(pollMs);
  }
}
