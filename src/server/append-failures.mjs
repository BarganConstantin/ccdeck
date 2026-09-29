// What the events log's append queue failed to write (#991), and how many lines
// have landed on each log in this process (#1130) — the two halves of the
// evidence event-log.mjs reads to say whether the log is being kept.
//
// Moved out of log-writer.mjs unchanged. appendLogLine reports every write
// that settles here, landed (noteAppendLanded) or not (noteAppendFailed);
// log-writer.mjs re-exports appendFailureStats and appendsLanded, which is
// where /api/health and event-log.mjs import them.
import { PRODUCT } from "./brand.mjs";

// ─── What the queue failed to write ───────────────────────────────────────
//
// `.catch(() => {})` was the only handler anywhere on this path, and a failed
// `open(filePath, "a")` was indistinguishable from a successful append from
// every vantage point in the process. MEASURED, on a sandboxed deck whose
// `--history` names a file inside a directory the user cannot write:
//
//   POST /api/event acknowledged: 10 of 10
//   log file on disk?             false
//   /api/health mentions the log? false
//   /api/version canRestart:      true
//
// Ten events the deck told the hook it had recorded, nothing on disk, nothing
// said on any console, and the Restart button still offering itself. That last
// line is the one that costs: the button exists precisely BECAUSE a restart
// without a log wipes the canvas irrecoverably, and it was gating on whether a
// log had been CONFIGURED rather than on whether one was being written. The
// press then lands on `replayLog`'s `if (!existsSync(filePath)) return 0` and
// the whole session history is gone.
//
// Who gets there without trying: `--history` accepts any path — a read-only or
// full volume, a removable drive unmounted while the deck runs, a directory
// whose permissions changed under it. `openEventLog` (event-log.mjs) even
// creates the parent inside a bare `try {} catch {}`, so the failure is already
// swallowed once before the first line is ever written.
//
// So the chain counts what it could not write, and says so once. The numbers
// are what make the loss observable without watching a canvas come back empty,
// for the same reason `eventBufferStats` exists in event-ring.mjs.
let failedLines = 0;
let failedChars = 0;
/**
 * The paths currently inside an EPISODE of failing, and how many lines each
 * episode has lost so far: path -> { lines }.
 *
 * An episode rather than a one-shot flag, because the interesting failures are
 * transient — a volume that fills and is emptied, a drive that is unplugged and
 * returns — and a path complained about once and never again would report the
 * first outage of a long-lived deck and stay silent through every later one.
 * The episode closes on the next append to that path that LANDS, which is the
 * only evidence available that the condition is over.
 */
const failingPaths = new Map();

/**
 * How many lines have LANDED on each path in this process: path -> count.
 *
 * The other half of the evidence `failingPaths` holds, and the half the restart
 * gate was missing (#1130). An open episode says the newest append to a path
 * failed. Nothing said the opposite — that one has succeeded SINCE some moment
 * — because a path that never failed has no episode to close, and a log that
 * could not be opened at boot and could be a minute later never failed an
 * append at all: its first one simply landed. A count answers that by being
 * compared with itself. event-log.mjs reads it once, when its boot probe
 * answers, and again whenever it asks; any difference is a line that reached
 * the disk after the probe spoke.
 *
 * One number per path this process has ever appended to, which on a deck is
 * one. Never deleted, unlike the entries in log-writer.mjs's appendTails,
 * because a count that went back to zero would read as "nothing has landed" to
 * whoever took a reading before it did.
 */
const landedLines = new Map();

/**
 * What the appender has failed to write, and whether it is failing now.
 *
 * Exported for the reason `eventBufferStats` and `MAX_BUFFER_CHARS` are: a loss
 * whose only observable effect is a canvas that comes back empty after a
 * restart is a loss no test can assert. `failing` is the number of paths inside
 * an open failure episode — this process appends to exactly one log, so on a
 * deck it is 0 or 1, and 1 means the log being drawn is not the log being kept.
 *
 * `failedLines` / `failedChars` are cumulative for the life of the process and
 * count lines that were ATTEMPTED and did not land. A line the queue refused
 * to accept in the first place is a different number and belongs beside this
 * one rather than tangled into it.
 *
 * `filePath` NARROWS `failing` to one log, and a caller deciding what to do
 * about its own log has to pass it. A process can outlive the log it was
 * started with — `startServer` may be called again with a different `--history`
 * on a restart, and the suite does exactly that — so an unscoped count would
 * let a path that failed and was abandoned veto a deck whose current log is
 * perfectly writable.
 *
 * @param {string|null} [filePath] the log to ask about; omit for every path
 */
export function appendFailureStats(filePath = null) {
  const failing = filePath == null ? failingPaths.size : (failingPaths.has(filePath) ? 1 : 0);
  return { failedLines, failedChars, failing };
}

/**
 * How many lines have landed on one log in this process. See landedLines.
 *
 * A separate export rather than a fourth field of appendFailureStats, because
 * that object is spread whole into `/api/health`, an open route that keeps to
 * the smallest set of facts answering its question, and a running count of
 * successful writes is not one of them.
 *
 * @param {string} filePath the log to ask about
 * @returns {number}
 */
export function appendsLanded(filePath) {
  return landedLines.get(filePath) ?? 0;
}

/**
 * One append landed. Counted whatever came before it — see landedLines — and
 * if this path was failing, that is the end of the episode and the size of the
 * hole it left is worth one line.
 */
export function noteAppendLanded(filePath) {
  landedLines.set(filePath, (landedLines.get(filePath) ?? 0) + 1);
  const episode = failingPaths.get(filePath);
  if (!episode) return;
  failingPaths.delete(filePath);
  console.error(`${PRODUCT}: writing ${filePath} works again — ${episode.lines} event(s) were dropped while it did not, and are not in the log`);
}

/**
 * One append did not land. Count it, and open an episode if this is the first.
 *
 * ONE LINE PER EPISODE, not one per failure. A read-only log fails on every
 * event the deck draws, so per-failure this would be thousands of lines onto
 * the terminal the deck paints its own banner over — which is its own version
 * of the problem being fixed.
 */
export function noteAppendFailed(filePath, line, err) {
  failedLines++;
  failedChars += typeof line === "string" ? line.length : 0;
  const episode = failingPaths.get(filePath);
  if (episode) { episode.lines++; return; }
  failingPaths.set(filePath, { lines: 1 });
  const why = err && err.message ? err.message : String(err);
  console.error(`${PRODUCT}: cannot write the event log ${filePath} (${why}) — events are being drawn but not recorded, and a restart will not bring them back`);
}
