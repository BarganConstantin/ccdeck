// The events.jsonl this deck keeps: where it is, whether this deck is the one
// that writes a given session to it, who else shares it, when it rolls over,
// and whether it is being written at all.
//
// These lived in src/server/index.mjs — the path and the election near the top,
// the rotation after them, and the writability probe beside the Restart gate
// that reads it. Every one of them is a question about the same file and none
// of them touches the ring, the SSE fan-out or the scanners, so they moved
// together, with `persistPath` itself. That variable is assigned in one place,
// openEventLog, and read everywhere else through eventLogPath(); the bodies
// that moved read it directly, as they always did.
import { mkdir, open, stat, unlink } from "node:fs/promises";
import { resolve, dirname as pdirname } from "node:path";
import { PRODUCT } from "./brand.mjs";
import { appendFailureStats, appendsLanded, flushAppends } from "./log-writer.mjs";
import { electWriters, foldsCase } from "./log-election.mjs";
// Every deck registered right now that proved it is the deck its record
// describes — the group logSharing counts. See live-decks.mjs.
import { readLiveDecks } from "./live-decks.mjs";

let persistPath = null;             // absolute path to events.jsonl, or null

/** The log this deck was told to keep, resolved, or null when it keeps none.
 *  Read through here by everything but the code that owns the file;
 *  openEventLog is the one writer. */
function eventLogPath() {
  return persistPath;
}

// ─── Which deck records which session ─────────────────────────────────────
// The hook posts an event to every deck whose workspace matches, and by
// default all of them append to one events.jsonl — so each event landed in
// that file once per running deck, and every later replay of it ingested each
// tool call that many times. The hook now elects one writer per log file and
// marks the request to the rest `?persist=0`. That flag covers the hook event
// itself; this map carries it to the ModelObserved/UsageObserved/
// ContextObserved events a deck derives from the same session's transcript,
// which every deck reads for itself and would otherwise duplicate exactly the
// same way. A session is recorded unless we have been told someone else owns
// it, so a lone deck — and a deck the hook is too old to flag — still writes
// everything.
//
// THIS COVERS THE CLAUDE SIDE ONLY, and that is worth stating because reading it
// as the general answer is what produced #447. The only thing that ever fills
// the set is noteLogWriter, called from handleEventIngest — a hook POST. Codex
// events are read off the rollout files inside this process and never reach an
// HTTP handler, and Codex hooks are not installed any more, so a Codex session
// id cannot get in here and writesLogFor answers "mine" for every one of them on
// every deck. The Codex half is decided by writesCodexLog in the watcher's scan
// loop instead, and every event derived from a rollout — including the memory
// scan's ContextObserved — has to carry that verdict explicitly.
const foreignSessions = new Set();  // session ids another deck is logging
const MAX_FOREIGN_SESSIONS = 512;   // bound: insertion order = oldest first

function noteLogWriter(payload, mine) {
  const sid = payload && typeof payload === "object" ? payload.session_id : null;
  if (typeof sid !== "string" || sid === "") return;
  // Delete either way: on re-add it moves the id back to the young end, so the
  // eviction below drops sessions that stopped being posted, not busy ones.
  foreignSessions.delete(sid);
  if (mine) return;
  foreignSessions.add(sid);
  if (foreignSessions.size > MAX_FOREIGN_SESSIONS) {
    foreignSessions.delete(foreignSessions.values().next().value);
  }
}

/**
 * Is this deck the one that writes this payload's session to the log? Every
 * event goes through here on its way to disk, including the ones this deck
 * derives from a transcript on its own — that is the point of remembering the
 * session rather than only honouring the flag on the event that carried it.
 */
export function writesLogFor(payload) {
  const sid = payload && typeof payload === "object" ? payload.session_id : null;
  return typeof sid !== "string" || sid === "" || !foreignSessions.has(sid);
}

/**
 * Who else is holding the log this deck would empty, and whose it is to empty.
 *
 * `events.jsonl` is one file several decks share — that is the whole reason the
 * election above exists — and `POST /api/clear` truncated it from whichever deck
 * happened to be asked. So Clear on a deck scoped to one tree deleted the
 * machine-wide deck's weeks of history, and told nobody: the other deck goes on
 * serving what is still in its ring, so the damage only shows up the next time
 * it boots and replays a file that is now empty (#698). Measured on macOS 15 /
 * Node 22.14: 1407 bytes and five lines before, 134 bytes after — and the 134
 * were the clearing deck's own `__clear` marker, appended to a log it writes
 * nothing else to.
 *
 * The rule this establishes is the one the rest of the file already runs on: a
 * deck may empty the log it WRITES. Ownership is electWriters — the same
 * election, over the same discovery records, that decides which deck appends a
 * line — so the process that truncates the file is the process that fills it,
 * which is also the only way the two operations are ordered on any platform. A
 * deck that is not the elected writer clears its own canvas and leaves the file
 * to the deck that owns it; the confirmation says so before the user presses
 * anything, and says how many decks share the file when the answer is "yours to
 * empty". Nothing here decides the copy — `GET /api/clear` hands these facts to
 * the dialog, which is the half that keeps the user from destroying history they
 * were never told about.
 *
 * Deliberately NOT a scope test. Whether this deck was started with
 * `--workspace` has nothing to do with who owns a file: two machine-wide decks
 * share one log exactly as a scoped one shares it with a machine-wide one, and
 * the harm is the same in both directions.
 *
 * Fail-safe matches writesCodexLog's, for the same reason: with no discovery
 * record of our own — the window before the first heartbeat writes it, or a deck
 * that cannot write one at all — nobody can elect us and we keep what a lone
 * deck does. The COUNT is still every deck sharing the file, so even inside that
 * window the confirmation warns rather than guessing quietly.
 */
export async function logSharing() {
  if (!persistPath) return { path: null, decks: 1, mine: true, owner: null };
  const fold = s => (foldsCase() ? s.toLowerCase() : s);
  const here = fold(persistPath);
  const sameLog = d => typeof d.persist === "string" && d.persist !== "" && fold(d.persist) === here;

  let live = [];
  try { live = await readLiveDecks(); } catch { /* unreadable dir — treated as "alone" below */ }
  const group = live.filter(sameLog);
  const self = group.find(d => d.pid === process.pid) ?? null;
  if (!self) return { path: persistPath, decks: Math.max(group.length + 1, 1), mine: true, owner: null };

  const writers = electWriters(group);
  const mine = writers.has(self);
  // One log path, so the election normally returns exactly one deck. It can
  // return more only when two decks spell the same file differently on a
  // case-sensitive platform, which `sameLog` folded together and electWriters
  // did not — the lowest port of them is the one to name, and `mine` above is
  // the election's own answer either way.
  const owner = mine
    ? self
    : [...writers].sort((a, b) => a.port - b.port || a.pid - b.pid)[0] ?? null;
  return { path: persistPath, decks: group.length, mine, owner };
}

// ─── Persistence rotation ─────────────────────────────────────────────────
// 24/7 dev servers used to grow events.jsonl unbounded — saw it hit GBs
// across weeks. We rotate when the file passes ROTATE_AT_BYTES, archiving
// the previous file to .1 and starting fresh. Last-event-id replay still
// covers the in-memory ring buffer, which is bounded by MAX_BUFFER events AND
// by MAX_BUFFER_CHARS — so how far back a replay reaches depends on how large
// the traffic has been, not on the count alone.
const ROTATE_AT_BYTES = 50 * 1024 * 1024;
let lastRotateCheckAt = 0;
let rotateInProgress = false;
/** Bytes handed to appendLogLine since the last time we looked at the file.
 *
 *  THE 30-SECOND CLOCK MADE THE THRESHOLD ADVISORY. The stat was throttled to
 *  once per 30s and this function has one caller — the push path — so the
 *  overshoot was exactly `30s x the ingest byte rate`, which is unbounded in
 *  throughput rather than merely loose. Measured, on a log doing 10.5 MB/s:
 *
 *    t=6s  log=51393249      <- 50 MB crossed
 *    t=30s log=306262048
 *    t=31s log=0  log1=316750478   <- rotation fires, 302 MB, 25s late
 *
 *  and at higher rates 1,199 MB and 2,579 MB with ZERO rotations — 51x the
 *  cap, 604 MB on disk across the two generations for a documented 50 MB.
 *
 *  Counting what we hand the appender costs one addition per event and removes
 *  the dependency on throughput: the check now happens when enough has been
 *  written to be worth a stat, whatever the clock says. The clock stays as a
 *  FLOOR for the idle case, where nothing is being written and a periodic look
 *  is the only way to notice a file that grew by some other route.
 *
 *  Deliberately a lower bound on the real file: it counts bytes queued, not
 *  bytes landed, and it is reset on every look rather than on a successful
 *  rotation — so a stat that finds the file still under the threshold has
 *  already paid for itself and does not need to re-count what it just saw. */
let bytesSinceRotateCheck = 0;
/** Enough written to be worth a stat, whatever the clock says. A fifth of the
 *  threshold, so the worst overshoot is bounded at ~20% rather than by rate. */
const ROTATE_CHECK_EVERY_BYTES = Math.floor(ROTATE_AT_BYTES / 5);
/** And a floor for the idle case, where nothing is being written and a
 *  periodic look is the only way to notice a file that grew by some other
 *  route — another deck appending to a log they share, say. */
const ROTATE_CHECK_EVERY_MS = 30_000;
/**
 * Whether it is worth asking the filesystem how big the log is.
 *
 * Pure, and exported, for the reason mayReadAccounts and maySelfPoll are: this
 * is the rule, and a rule whose only observable failure is a file quietly
 * reaching gigabytes belongs somewhere a test can point at it. Rotation had no
 * test of any kind.
 */
export function rotateCheckDue({ now, lastCheckAt, bytesSince }) {
  return now - lastCheckAt >= ROTATE_CHECK_EVERY_MS
    || bytesSince >= ROTATE_CHECK_EVERY_BYTES;
}

async function maybeRotatePersistFile(wroteBytes = 0) {
  if (!persistPath) return;
  bytesSinceRotateCheck += wroteBytes;
  const now = Date.now();
  if (!rotateCheckDue({ now, lastCheckAt: lastRotateCheckAt, bytesSince: bytesSinceRotateCheck })) return;
  lastRotateCheckAt = now;
  bytesSinceRotateCheck = 0;
  if (rotateInProgress) return;
  rotateInProgress = true;
  try {
    const s = await stat(persistPath).catch(() => null);
    if (!s || s.size < ROTATE_AT_BYTES) return;
    // ONLY THE DECK THAT WRITES THIS LOG MAY MOVE IT, the same gate `/api/clear`
    // already keeps and for the same reason. Two decks appending to one log is
    // explicitly permitted as the fail-safe — log-election.mjs says "a line
    // written twice is recoverable" — so both cross 50 MB and both rotate. If
    // B's stat lands before A's rename, B's `unlink` deletes the archive A has
    // just made and B's `rename` moves the new, near-empty live file into its
    // place: one generation of history destroyed by a deck that was only
    // housekeeping. The append path was made multi-writer safe; this one was
    // not. Ownership is electWriters, so nothing new gets to disagree with it.
    const sharing = await logSharing();
    if (!sharing.mine) return;
    // Roll events.jsonl → events.jsonl.1 (replacing any previous .1).
    const oldPath = persistPath + ".1";
    // LET THE QUEUE DRAIN FIRST. Appends are ordered behind a promise chain
    // inside log-writer.mjs and a descriptor opened before the rename completes
    // into the RENAMED inode, so the line being appended at the moment of a
    // rotation lands in the archive rather than the live log — measured, a
    // 24 MB line in events.jsonl.1 and a 65-byte live file. See flushAppends.
    await flushAppends(persistPath);
    try { await unlink(oldPath); } catch {}
    const { rename } = await import("node:fs/promises");
    await rename(persistPath, oldPath);
    console.log(`${PRODUCT}: rotated ${persistPath} (${(s.size / 1024 / 1024).toFixed(0)}MB → ${oldPath})`);
  } catch (err) {
    console.error(`${PRODUCT}: persist rotation failed:`, err && err.message ? err.message : err);
  } finally {
    rotateInProgress = false;
  }
}

// A log that cannot be written is no log wearing a different hat. The Restart
// gate — `_canRestart` in index.mjs — was a test of CONFIGURATION alone,
// `_onRestart != null && persist != null`, so a deck whose `--history` named a
// read-only volume, a full one, or a removable drive that was later unmounted
// answered `canRestart: true` while not one event reached disk. Measured: 10 of
// 10 posts acknowledged, no file on disk, `canRestart: true`. The press then
// lands on replayLog's `if (!existsSync(filePath)) return 0` and takes the
// whole session history with it — which is precisely the loss the flag exists
// to prevent.
let _persistWritable = false;
// How many lines had landed on `persistPath` when the probe answered. Read by
// logWritableNow and nothing else; see appendsLanded.
let _landedAtProbe = 0;

/**
 * Is the log this deck was told to keep being written, on the newest evidence?
 *
 * `_persistWritable` answered this alone, and it is the boot probe's answer:
 * nothing after the boot could change it. The gate it fed had a closing edge —
 * a failing append opens an episode, and an episode shut the gate — and no
 * opening one. MEASURED on a sandboxed deck (#1130), a log whose parent was a
 * file at boot and a directory a moment later, which is what a mount that
 * comes up late or a permission that is fixed leaves behind: a line on disk,
 * the failure count at 0, and `canRestart` false for the life of the process.
 *
 * The appender is the evidence, and it already produces it: every line either
 * lands or fails, and log-writer counts both. So the answer is whichever of the
 * two sources spoke LAST. An open failure episode means the newest append
 * failed, whatever came before it. Otherwise a line landed since the probe
 * means the newest evidence is a write that worked, whatever the probe said;
 * and with neither, the probe is still the newest thing anyone knows.
 *
 * No syscall is added anywhere for it. The probe stays the one at boot, the
 * episode is the one #1062 keeps, and what an event pays is one counter
 * increment in the landing handler (append-failures.mjs), beside the episode
 * lookup that handler already makes.
 */
function logWritableNow() {
  if (!persistPath) return false;
  if (appendFailureStats(persistPath).failing > 0) return false;
  return _persistWritable || appendsLanded(persistPath) > _landedAtProbe;
}

/**
 * Is the log this deck was told to keep actually writable?
 *
 * One `open(path, "a")` and one close — the same pair every append pays, asked
 * once at boot so the answer is known before the first event rather than after
 * the first silent loss. It CREATES the file, which is what an append would do
 * anyway and what makes the probe honest about the directory as well as the
 * file: EROFS, EACCES and ENOENT all surface here.
 */
async function probeLogWritable(path) {
  let handle = null;
  try {
    handle = await open(path, "a");
    return true;
  } catch (err) {
    console.error(`${PRODUCT}: the event log ${path} is not writable (${err && err.message ? err.message : err}) — Restart is disabled until an event reaches it, because it would replay a log this deck is not filling`);
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Point the deck at the log it was told to keep, and probe it once.
 *
 * Lifted out of startServer, which calls it once per boot, before the replay.
 * A boot with no log leaves `persistPath` as it was and only resets the probe,
 * which is what startServer always did: the path is assigned when there is one
 * and never cleared.
 */
async function openEventLog(persist) {
  _persistWritable = false;
  if (!persist) return;
  persistPath = resolve(persist);
  try { await mkdir(pdirname(persistPath), { recursive: true }); } catch {}
  // Asked before the first event, so a log that cannot be written is a fact
  // the deck states rather than one the user discovers by pressing Restart.
  // The mkdir above is inside a bare try/catch, so its failure is already
  // swallowed once by the time we get here — see _persistWritable.
  _persistWritable = await probeLogWritable(persistPath);
  // Taken the moment the probe answers, so that a line landing from here on
  // is evidence newer than it. See logWritableNow.
  _landedAtProbe = appendsLanded(persistPath);
}

// What index.mjs calls besides the three exported above. Listed rather than
// marked at each declaration, so the declarations read as they did where they
// came from.
export { eventLogPath, logWritableNow, maybeRotatePersistFile, noteLogWriter, openEventLog };
