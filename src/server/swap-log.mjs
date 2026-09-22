// The timeline of which account was active, and when.
//
// Nothing in claude-swap or the deck ever recorded this. sequence.json holds a
// single `activeAccountNumber` — who is active *now* — and overwrites it on
// every switch, so the moment a swap happens the previous truth is gone. The
// account-projects report needs the opposite: a durable, append-only record of
// "at time T the active account became X", so a transcript message written at
// some past instant can be attributed to whoever was active *then*.
//
// The deck is the one thing that performs a swap (it drives `cswap switch` and
// the auto tick), so it does not have to reconstruct or guess: it writes one
// line each time it moves the live account. The past before this file existed
// is unrecoverable — there is no timestamped history anywhere to mine — so the
// report is honest only from the first line here onward, and everything earlier
// is left unattributed.
//
// One line per swap, JSON:
//   { "at": <ms>, "slot": <n>, "email": "...", "orgUuid": "...", "source": "manual"|"auto"|"start" }
// `source` "start" is the anchor the rollup writes once at boot for whoever is
// already active, so a machine that never swaps still attributes its work.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { backupRoot } from "./claude-accounts.mjs";

/** The log the deck appends swaps to. Under ~/.agents-deck like cswap-auto's
 *  own state, not under the claude-swap store — this is the deck's record, not
 *  claude-swap's. */
export function swapLogPath(home = homedir()) {
  return join(home, ".agents-deck", "log", "account-active.jsonl");
}

/** Read one JSON value from a file, or null if it is missing or unparseable. */
async function readJsonSafe(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** The `(email, organizationUuid)` a slot number points at right now, read from
 *  claude-swap's sequence.json. Null when the store or the slot is not there. */
export async function identityForSlot(slot, root = backupRoot()) {
  const seq = await readJsonSafe(join(root, "sequence.json"));
  const acc = seq?.accounts?.[String(slot)];
  if (!acc) return null;
  return {
    email: typeof acc.email === "string" ? acc.email : "",
    orgUuid: typeof acc.organizationUuid === "string" ? acc.organizationUuid : "",
  };
}

/** The slot claude-swap says is active right now, or null. */
export async function currentActiveSlot(root = backupRoot()) {
  const seq = await readJsonSafe(join(root, "sequence.json"));
  const n = Number(seq?.activeAccountNumber);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Parse the log into swap entries sorted oldest-first. A truncated or garbage
 *  last line (a crash mid-append) is skipped, never fatal. */
export async function readSwapLog(path = swapLogPath()) {
  const text = await readFile(path, "utf8").catch(() => "");
  const out = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let obj = null;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== "object") continue;
    const at = Number(obj.at);
    if (!Number.isFinite(at)) continue;
    out.push({
      at,
      slot: Number(obj.slot) || 0,
      email: typeof obj.email === "string" ? obj.email : "",
      orgUuid: typeof obj.orgUuid === "string" ? obj.orgUuid : "",
      source: typeof obj.source === "string" ? obj.source : "",
    });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

/** Append one swap line. Creates the log directory on first use. Best-effort:
 *  a failure to record must never break a switch, so callers ignore rejection. */
export async function appendSwap(entry, path = swapLogPath()) {
  await mkdir(join(path, ".."), { recursive: true });
  await appendFile(path, JSON.stringify(entry) + "\n", "utf8");
}

/**
 * Record that `slot` became the active account, resolving its identity from the
 * store. `source` says which path moved it. Returns the entry written, or null
 * when the slot has no identity (nothing worth attributing to).
 *
 * Best-effort by contract: every caller sits on a hot path (a click, an auto
 * tick) that must not fail because a log write did. Errors are swallowed here
 * so callers can `void recordSwap(...)` without a catch.
 */
export async function recordSwap(slot, source, { now = Date.now, root, path } = {}) {
  try {
    const store = root ?? backupRoot();
    // Trust the store's own idea of who is active over a caller-supplied slot
    // when that slot is missing or malformed — after a switch, sequence.json's
    // activeAccountNumber is the authoritative new slot, so the auto tick can
    // record without threading the number through cswap's JSON.
    let n = Number(slot);
    if (!Number.isInteger(n) || n <= 0) n = await currentActiveSlot(store);
    if (!n) return null;
    const id = await identityForSlot(n, store);
    if (!id) return null;
    const entry = { at: now(), slot: n, email: id.email, orgUuid: id.orgUuid, source };
    await appendSwap(entry, path ?? swapLogPath());
    return entry;
  } catch {
    return null;
  }
}

/**
 * Seed an anchor for the currently-active account, once, if the log does not
 * already end on that account. Called at boot so a deck that never swaps still
 * attributes its work to the account it launched on, and so the very first
 * upgrade writes a "tracked since" point.
 *
 * Deduped against the last entry's `(email, orgUuid)`: a restart on the same
 * account adds nothing, but a manual switch made while the deck was down (so no
 * line was written for it) is still captured here on the next boot.
 */
export async function seedActive({ now = Date.now, root, path } = {}) {
  try {
    const logPath = path ?? swapLogPath();
    const slot = await currentActiveSlot(root ?? backupRoot());
    if (!slot) return null;
    const id = await identityForSlot(slot, root ?? backupRoot());
    if (!id) return null;
    const entries = await readSwapLog(logPath);
    const last = entries[entries.length - 1];
    if (last && last.email === id.email && last.orgUuid === id.orgUuid) return null;
    const entry = { at: now(), slot, email: id.email, orgUuid: id.orgUuid, source: "start" };
    await appendSwap(entry, logPath);
    return entry;
  } catch {
    return null;
  }
}

/**
 * Which account was active at millisecond `ts`: the last entry at or before it.
 * Null when `ts` precedes every entry — that message is from before tracking
 * began and cannot be attributed. `entries` must be sorted oldest-first, as
 * `readSwapLog` returns them.
 */
export function accountAtTime(entries, ts) {
  if (!Array.isArray(entries) || !entries.length) return null;
  if (ts < entries[0].at) return null;
  // Binary search for the rightmost entry with at <= ts.
  let lo = 0, hi = entries.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].at <= ts) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  const e = entries[ans];
  return { email: e.email, orgUuid: e.orgUuid, slot: e.slot };
}

/** The earliest instant the log covers — what the report shows as "tracked
 *  since". Null on an empty log. */
export function trackedSince(entries) {
  return Array.isArray(entries) && entries.length ? entries[0].at : null;
}
