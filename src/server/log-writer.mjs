// Appending to the events log that several decks may share: one whole line per
// write(2), in the order pushEvent produced them, behind a queue that is
// bounded and counts what it refused and what failed to land — and the drain,
// the flush and the Clear that take their turn on that same queue.
//
// Which deck writes a given line is decided before any of this, by the
// election in log-election.mjs, which used to sit at the top of this file.
import { open, truncate, unlink } from "node:fs/promises";
import { PRODUCT } from "./brand.mjs";

// ─── Appending one whole line ─────────────────────────────────────────────
//
// The election in log-election.mjs decides WHICH deck writes a line. This
// decides HOW, and the two are answers to the same question: the log is one
// file that several processes append to, so a line that arrives in pieces is a
// line another writer can land inside.
//
// What was wrong. events.jsonl was appended with `fsPromises.appendFile`, which
// is not one write(2). Node's writeFileHandle loops over the payload in chunks
// of kWriteFileMaxChunkSize — 512 KiB — awaiting each one, so any line longer
// than 524288 bytes became two or more separate appends with the event loop
// free in between. Measured here, on Node 26 / macOS 15 / APFS, by watching the
// file grow while one 5 MiB appendFile was in flight: it arrived in exactly ten
// steps of 524288 bytes. A single handle.write of the same payload arrived in
// one step of 5242880.
//
// That is reachable in ordinary use. `POST /api/event` accepts a body up to
// 5,000,000 characters, and a PostToolUse carrying a large Read or Bash
// response is routinely a good fraction of that. The event that gets spliced
// into the middle is nearly always this deck's own: pushEvent kicks off
// maybeResolveUsage / maybeResolveModel / maybeResolveContext on the same call,
// and each of those pushes its own event a moment later. Reproduced at 8/8 runs
// with one 1 MiB line and eight small ones issued in one tick, and 4/4 runs
// across two processes appending 3 MiB lines to one file.
//
// The damage is silent and doubled: the oversized event is torn into two
// unparseable halves AND the small event that landed between them is swallowed
// inside one of those halves, so a boot replay loses both.
//
// What this does instead: exactly one write(2) per line, on a descriptor opened
// O_APPEND. That is the primitive the atomicity rests on, so it is worth
// stating exactly what each platform promises.
//
//   Linux — a write to a regular file holds the inode's i_rwsem for the whole
//   call, so one write(2) is atomic against every other writer regardless of
//   size, up to MAX_RW_COUNT (~2 GiB) after which the call returns short.
//   O_APPEND additionally makes the seek-to-end and the write one step, which
//   is what stops two processes overwriting each other's tail.
//
//   macOS — measured, not assumed, because the guarantee is not written down as
//   plainly: single writes of 1 MiB and 5 MiB in-process, and 3 MiB from two
//   processes at once, produced no torn line in any run, while appendFile of
//   the same payloads tore in every run.
//
//   Windows — libuv issues the append as a WriteFile at the documented
//   end-of-file offset on a handle opened FILE_APPEND_DATA, which NTFS serialises
//   per call. This is the platform where the Codex rollout watcher is the only
//   capture path there is, so it is also the platform with the most decks
//   sharing one log.
//
// Where the guarantee does NOT hold: any filesystem that can return a short
// write — NFS and some network/FUSE mounts under memory pressure, and any
// platform once the payload passes its per-call ceiling. The loop below then
// issues a second write for the remainder, and another writer can land between
// them. Nothing available in userland fixes that, so the answer is the reader:
// replayLog skips a line it cannot parse, counts it, and says so, rather than
// stopping at it. A torn line costs one event, not the rest of the file.
//
// Why not cap or drop oversized events instead. The 5 MB ceiling is already the
// cap, and it is enforced where it belongs — at ingest, with a 413 the poster
// can see. Refusing to persist an event the deck is happily drawing would make
// the canvas and its own replay disagree, which is the bug this fixes wearing a
// different hat.
//
// Why the file is opened per line rather than kept open. maybeRotatePersistFile
// renames events.jsonl to events.jsonl.1 at 50 MB and `/api/clear` truncates it
// to zero; a descriptor held across either would go on filling the file nobody
// reads any more. Opening per line is also exactly the syscall count appendFile
// already paid — open, write, close — minus the extra writes.
const appendTails = new Map();

/** The step the next one queued for this log starts behind: the last one
 *  queued, or nothing when its queue is empty. */
function tailOf(filePath) {
  return appendTails.get(filePath) ?? Promise.resolve();
}

/**
 * Make `tail` the step the next one queued for this log starts behind, and
 * drop it from the map once it settles.
 *
 * Dropped so a process that writes to several logs over its life does not hold
 * a promise per path it has finished with. Only the tail installed here is
 * cleared: if another step chained on in the meantime the map already points
 * at that one, and deleting it would let the next line race the one still in
 * flight.
 */
function installTail(filePath, tail) {
  appendTails.set(filePath, tail);
  tail.then(() => { if (appendTails.get(filePath) === tail) appendTails.delete(filePath); });
}

// ─── What the queue is allowed to weigh ───────────────────────────────────
//
// The chain above ORDERS appends. Nothing bounded them. Every line handed over
// is retained by the closure that will eventually write it, and the only brake
// on how many of those exist at once is how fast write(2) returns — while
// pushEvent hands them over fire-and-forget and answers `{ok:true, seq}` on the
// next statement, so `POST /api/event` admits lines as fast as a socket can
// deliver them.
//
// MEASURED (Linux 7.0 / Node 24.21 / ext4 on NVMe), eight sockets posting 1 MB
// `tool_response` bodies to a sandboxed deck for four seconds, sampled twice a
// second:
//
//   t=1.0s  log_MB=19    rss_MB=881
//   t=2.5s  log_MB=51    rss_MB=1741
//   t=4.1s  log_MB=85    rss_MB=2260   <- ingest stops; 1540 MB acknowledged
//   t=5.5s  log_MB=1135  rss_MB=935
//   t=6.0s  log_MB=1540  rss_MB=546    <- queue finally drained
//
// 85 MB on disk against 1540 MB the deck had said it had: 1455 MB of serialized
// lines held in the heap, and an RSS peak of 2260 MB — 17x MAX_BUFFER_CHARS,
// the budget the ring beside this keeps exactly. The disk is not the amplifier;
// the event loop is. Ingest and the writer share it, so the log grew at 21 MB/s
// while the posting continued and at 800 MB/s the instant it stopped.
//
// The same burst under `--max-old-space-size=1024`:
//
//   FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
//   [deck exited code=null sig=SIGABRT]   3.2s in, 50 MB written
//
// That abort is not catchable, so the SSE stream, the hook ingest and the log
// stop together — and `/api/event` is a deliberate OPEN_MUTATION, so this is a
// few hundred unauthenticated posts from any local process ending the deck.
// It is the failure MAX_BUFFER_CHARS was added to close (#625), reached through
// the door beside the one it guards (#1030).
//
// Who gets there without trying: `--history` accepts any path. The 40 events/s
// of 1 MB that is trivial on NVMe is roughly 30 MB/s of pure accumulation on a
// 5-10 MB/s network mount or a slow external drive, where the queue's only
// brake is that much slower than the traffic filling it.

/**
 * The ceiling on pending append bytes, and the ring's sibling on purpose.
 *
 * 128 MiB, the same number and the same three readings that pick
 * MAX_BUFFER_CHARS in ring-bounds.mjs:
 *
 *   - It is 26 times the largest single line ingest can produce (5,000,000
 *     characters plus the deck's envelope), so a burst of maximum-size tool
 *     responses — eight subagents each returning a big Read — is queued whole
 *     rather than shed.
 *   - It is thirteen times a completely full 2000-event ring of ordinary
 *     traffic. The mean serialized event is about 5 KB, so the ~26,000 lines
 *     this holds are far more than any honest burst produces: ordinary traffic
 *     never meets this bound at all.
 *   - Its worst case is a bounded fraction of the heap, and a bounded ADDITION
 *     to the ring's. 128 MiB of charged characters is at most 256 MiB retained
 *     — a two-byte string costs twice what it is charged, the same 2x
 *     MAX_CLIENT_BUFFER_BYTES' note describes — so the ring's 320 MiB and this
 *     together are about 576 MiB of the 2 GB heap an 8 GB laptop picks, against
 *     the 2260 MB one four-second burst reached with no bound here at all.
 *
 * CHARGED IN CHARACTERS, not in UTF-8 bytes, and the unit is deliberate. These
 * lines are already serialized, so `line.length` is the size of the thing being
 * retained and costs nothing to read; `Buffer.byteLength` would be a second
 * full scan of a five-megabyte string on the hottest path in the process for a
 * number that is FURTHER from the retained heap, not closer — JSON.stringify
 * leaves non-ASCII unescaped, so a CJK line is two bytes of heap per character
 * and three bytes of UTF-8.
 *
 * Deliberately NOT summed into MAX_BUFFER_CHARS, which #1030 raises as an
 * option. The two hold different things — the ring holds parsed payloads
 * charged by payloadChars' walk, this holds their serialization — so one
 * counter would be adding two units; and eviction cannot free a queued line
 * anyway, so a shared budget would answer a slow disk by collapsing the replay
 * depth of the ring, which is the one part of this that was never broken.
 */
export const MAX_PENDING_APPEND_CHARS = 128 * 1024 * 1024;

// What has been accepted and not yet written, what has been refused because of
// it, and whether we are inside an episode of refusing. These move with the
// chain in appendLogLine and nowhere else, through takeCharge, noteRefused and
// releaseCharge below — the same rule `bufferedChars` and `events` keep in
// event-ring.mjs, and for the same reason: a total that names lines the queue
// no longer holds is a permanent debt against the budget.
let pendingLines = 0;
let pendingChars = 0;
let droppedLines = 0;
let droppedChars = 0;
let dropEpisodes = 0;
// Reset at the start of each episode, so the line printed when the queue
// drains describes THAT burst rather than the life of the process.
let episodeLines = 0;
let episodeChars = 0;
let shedding = false;

/**
 * What the append queue holds right now, and what it has refused.
 *
 * Exported for exactly the reason eventBufferStats and MAX_BUFFER_CHARS are —
 * "a bound whose only observable failure is the process running out of memory
 * is a bound no test can assert". With this, the bound is observable without
 * watching a process die, and so is the loss it trades for.
 *
 * `droppedLines` / `droppedChars` are cumulative for the life of the process.
 * They count lines that were never ATTEMPTED; an append that was attempted and
 * failed is a different number, which #991 is open about and which belongs
 * beside these rather than tangled into them.
 */
export function appendQueueStats() {
  return { pendingLines, pendingChars, droppedLines, droppedChars, dropEpisodes };
}

const mb = chars => `${(chars / 1024 / 1024).toFixed(0)}MB`;

/**
 * Would a line of `charged` characters be refused at the door right now?
 *
 * The queue always accepts a line when it is EMPTY, whatever that line
 * weighs. Ingest admits 5,000,000 characters and a Codex rollout line read
 * off disk has no length bound at all, so refusing an oversized line outright
 * would mean a deck that silently never records its largest events — and the
 * ring one file over makes the same exception for the same reason ("a single
 * event is allowed to be larger than the entire budget"). So the true ceiling
 * is MAX_PENDING_APPEND_CHARS plus one line, stated here rather than
 * pretended away.
 */
function queueIsFull(charged) {
  return pendingLines > 0 && pendingChars + charged > MAX_PENDING_APPEND_CHARS;
}

/** One line accepted: charge it until releaseCharge gives the charge back. */
function takeCharge(charged) {
  pendingLines++;
  pendingChars += charged;
}

/** One line refused at the door: count it, and open an episode if this is the
 *  first refusal since the queue last drained. */
function noteRefused(filePath, charged) {
  droppedLines++;
  droppedChars += charged;
  episodeLines++;
  episodeChars += charged;
  if (!shedding) {
    shedding = true;
    dropEpisodes++;
    // One line, at the start of the episode. Per refusal it would be
    // thousands of lines onto the terminal the deck paints over, which is its
    // own version of the problem being fixed.
    console.error(`${PRODUCT}: the log append queue is full (${mb(pendingChars)} waiting for ${filePath}) — dropping events until it drains`);
  }
}

/**
 * One line has left the queue. Give its charge back, and close the episode if
 * that was the last of them.
 *
 * The episode ends when the queue is EMPTY rather than the moment it dips back
 * under the bound, because it dips under the bound once per completed write:
 * keyed on the bound this would print a pair of lines per event for the length
 * of the burst. Empty is also the honest boundary for the number being
 * reported — while anything is still queued the next line can still be refused,
 * and the total would have to be retracted.
 */
function releaseCharge(charged) {
  pendingLines--;
  pendingChars -= charged;
  if (pendingLines > 0 || !shedding) return;
  console.error(`${PRODUCT}: the log append queue drained — ${episodeLines} event(s) (${mb(episodeChars)}) were dropped and are not in the log`);
  shedding = false;
  episodeLines = 0;
  episodeChars = 0;
}

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
 * one. Never deleted, unlike the entries in appendTails, because a count that
 * went back to zero would read as "nothing has landed" to whoever took a
 * reading before it did.
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
function noteAppendLanded(filePath) {
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
function noteAppendFailed(filePath, line, err) {
  failedLines++;
  failedChars += typeof line === "string" ? line.length : 0;
  const episode = failingPaths.get(filePath);
  if (episode) { episode.lines++; return; }
  failingPaths.set(filePath, { lines: 1 });
  const why = err && err.message ? err.message : String(err);
  console.error(`${PRODUCT}: cannot write the event log ${filePath} (${why}) — events are being drawn but not recorded, and a restart will not bring them back`);
}

/**
 * Append one already-serialized line to the shared log, whole.
 *
 * Appends are serialized per file behind a promise chain. That is not what
 * makes them atomic — the single write(2) below is — but it keeps the order the
 * lines land in equal to the order pushEvent produced them, which is the order
 * a replay reads them back in, and it keeps this process to one open descriptor
 * on the log no matter how many events arrive in one tick.
 *
 * Never rejects. This is called fire-and-forget from the hottest path in the
 * process, and a rejection nobody awaits is a dead deck; a line that could not
 * be written is a line lost, which the caller could not have done anything
 * about anyway. The chain deliberately continues past a failure — one ENOSPC
 * must not stop every later event from being recorded once space is back.
 *
 * BOUNDED, by MAX_PENDING_APPEND_CHARS above. Past it the line is refused at
 * the door, counted, and reported once per episode.
 *
 * Refused at the door, and not evicted from the middle of the queue, which is
 * the other shape #1030 offers. A line that has been accepted has been charged,
 * chained and ordered, and the exit drain promises to deliver it; un-accepting
 * one later would make the only promise this module makes about the queue
 * conditional and racy, and the head of the queue is in any case the line
 * currently inside write(2), which cannot be recalled. The door is the one
 * point where nothing has been promised yet.
 *
 * Not backpressure either — no awaiting the drain before the POST is answered.
 * Three of pushEvent's four callers have no HTTP peer to make wait (Codex
 * rollout lines read off disk, the boot replay, the synthetic events the
 * transcript scanners emit), and making the ingest route wait on the filesystem
 * is the exact shape the fire-and-forget call exists to avoid.
 *
 * @param {string} filePath absolute path to the log
 * @param {string} line     the line to append, INCLUDING its trailing newline
 */
export function appendLogLine(filePath, line) {
  const charged = typeof line === "string" ? line.length : 0;
  if (queueIsFull(charged)) {
    noteRefused(filePath, charged);
    // Resolved rather than rejected, and resolved rather than the tail: the
    // contract every caller has is "never rejects, never makes you wait".
    return Promise.resolve();
  }
  takeCharge(charged);
  const tail = tailOf(filePath)
    .then(() => writeWholeLine(filePath, line))
    // Counted, and reported once per episode — see noteAppendFailed. The order
    // of these four steps is the whole of the union between the append-queue
    // ceiling (#1030) and the failure counter (#991), and each link needs the
    // one before it:
    //
    //   * the failure handler comes BEFORE the `catch`, or the rejection has
    //     already been swallowed by the time anything could count it;
    //   * the `catch` stays, because the map cleanup in installTail chains a
    //     bare `.then` on this tail and "never rejects" is the contract every
    //     caller of this function has — neither handler above may be what
    //     breaks it;
    //   * `finally` comes LAST, so the charge is given back whether the write
    //     landed, failed, or a handler here threw on its way past. It would run
    //     on a rejection anyway; what the ordering buys is that it cannot be
    //     skipped by anything the two lines above do.
    .then(() => noteAppendLanded(filePath), err => noteAppendFailed(filePath, line, err))
    .catch(() => {})
    // The charge is released when the line is written or has failed trying —
    // which is the moment the closure holding it becomes collectable, and so
    // the moment the heap it was standing for is actually back.
    .finally(() => releaseCharge(charged));
  installTail(filePath, tail);
  return tail;
}

/**
 * `drained` — a promise that answers true once what it waits for has landed —
 * or false at `ms`, whichever comes first: the bound drainAppends and
 * flushAppends below both keep. The bell is unref'd, so a wait still running
 * never holds the process open by itself, and it is cleared either way.
 */
function withinDeadline(drained, ms) {
  let bell;
  const deadline = new Promise(resolve => {
    bell = setTimeout(() => resolve(false), ms);
    bell.unref?.();
  });
  return Promise.race([drained, deadline]).finally(() => clearTimeout(bell));
}

/**
 * Wait for every queued append to land, bounded.
 *
 * The deck answers `{ok:true, seq}` before the line reaches disk — pushEvent
 * calls appendLogLine fire-and-forget, and the 200 goes out on the next
 * statement. That is the right shape for the hook, which holds a 1.9s cap and
 * must not wait on a filesystem. It is the wrong shape for an exit: shutdown
 * waited for the listener to drain and for nothing else, so a backlog was
 * abandoned. Measured on a sandboxed deck, 40 concurrent posts then SIGTERM:
 *
 *   acknowledged 200: 40 of 40
 *   lines written:    12
 *
 * Twenty-eight events the deck had told the hook were recorded. The twelve
 * that landed were whole — the single write(2) holds — so this is the queue
 * being dropped, not a torn line.
 *
 * The restart path is the one that costs most: the replacement deck rebuilds
 * its canvas from events.jsonl before it binds, so the sessions and tool calls
 * in the dropped tail leave the board permanently.
 *
 * BOUNDED, because a wedged filesystem must not hold the exit hostage — the
 * whole point of the fire-and-forget shape is that no caller waits on the disk
 * indefinitely, and that has to stay true of the last caller too. A deadline
 * reached is the old behaviour, which is no worse than before.
 */
export function drainAppends(ms = 3000) {
  const pending = [...appendTails.values()];
  if (!pending.length) return Promise.resolve(true);
  // `catch` on each: a failed append has already been swallowed by the chain,
  // and a rejection here would skip the rest of the drain.
  return withinDeadline(
    Promise.all(pending.map(p => Promise.resolve(p).catch(() => {}))).then(() => true),
    ms,
  );
}

/**
 * Wait for everything queued for one log to land, bounded.
 *
 * `appendTails` is this module's alone: pushEvent calls appendLogLine
 * fire-and-forget and the 200 goes out on the next statement, so nothing
 * outside here could see the queue, let alone wait on it. The two operations
 * that MOVE the file out from under it consulted neither.
 *
 * MEASURED, on a sandboxed deck — one 3 MB PostToolUse on the wire with eight
 * small envelopes queued behind it, then `POST /api/clear`:
 *
 *   POST /api/clear answered:       {"ok":true,"log":"cleared", ...}
 *   file right after the truncate:  0 bytes
 *   file 2.5s after the Clear:      564 bytes, 3 line(s)
 *   sessions surviving the Clear:   before-clear
 *
 * The ring was emptied, the file was truncated, `__clear` went out over SSE and
 * the canvas was blank — and then the queue drained into the now-empty file.
 * The next restart replays those lines, so sessions the user explicitly and
 * irreversibly cleared come back. That is #698's residue by a different route,
 * and it survives the ownership gate that fixed #698 because it happens on the
 * deck that DOES own the file.
 *
 * And the rename, with one 24 MB line and one small line queued, the rename
 * performed while the chain was still running:
 *
 *   events.jsonl    size: 65
 *   events.jsonl.1  size: 25165897
 *
 * A descriptor opened before the rename completes into the renamed inode, so
 * the line being appended lands in the archive rather than the live log.
 *
 * BOUNDED, for the reason the fire-and-forget shape exists at all: no caller
 * may wait on the disk indefinitely, and that has to stay true of a caller that
 * is answering an HTTP request. A deadline reached is the old behaviour, which
 * is no worse than before.
 *
 * THE SIBLING OF drainAppends ABOVE, and deliberately not folded into it. That
 * one is the exit's: every path, once, on the way out. This one is asked of a
 * single log by two operations that are about to MOVE it, and it is asked while
 * the deck goes on running — so the paths it must not wait for are the other
 * logs a long-lived process has written, which drainAppends is right to include
 * and this one would be wrong to.
 *
 * @param {string} filePath the log to wait on
 * @param {number} [ms]     how long to wait before giving up
 * @returns {Promise<boolean>} whether the queue actually drained
 */
export function flushAppends(filePath, ms = 3000) {
  const tail = appendTails.get(filePath);
  if (!tail) return Promise.resolve(true);
  // The tail never rejects — appendLogLine's own catch sees to that — but a
  // rejection here would reach a caller that was promised a boolean, so it is
  // handled rather than assumed away.
  return withinDeadline(Promise.resolve(tail).then(() => true, () => true), ms);
}

/**
 * Empty one log IN ITS TURN on the queue, and its older generations with it.
 *
 * `/api/clear` waited for the queue and then truncated beside it (#1005), and
 * beside was the flaw. `flushAppends` waits for the tail as it stood when it
 * was called, so a line queued while the Clear was waiting went on behind that
 * tail, and nothing ordered it against the truncate — two separate operations
 * on the threadpool. MEASURED on a sandboxed deck (#1130), a session still
 * posting while Clear was pressed, five runs: 4, 5, 3, 3 and 2 events left in
 * the file that the Clear had taken off the board, every one of which the next
 * boot replays.
 *
 * So the truncate is chained on the tail exactly as a line would be, and the
 * chain orders it the way it already orders lines. Every line queued before
 * this call is written before the truncate and erased by it. Every line queued
 * after it cannot so much as open the file until the truncate has settled,
 * because each step on the chain starts only when the one before it has, and
 * the chain is the only way this process writes to the log. That is the whole
 * of what a Clear needs, and none of it depends on timing.
 *
 * WRITTEN AND ERASED, NOT SKIPPED. A generation stamped on each line and
 * compared when its turn comes would spare the lines queued before the Clear
 * their writes, and it is the other shape #1130 offers. It is not what makes
 * this correct: without the truncate on the chain, a line queued after the
 * Clear would still be free to land before the truncate and be erased by it;
 * with the truncate on the chain, it is an optimisation — one that would reach
 * into appendLogLine's four ordered steps, whose order is load-bearing and
 * says so, to save the writes of a burst that is about to be erased anyway.
 *
 * `archives` go in the same turn and AFTER the truncate, and the order is what
 * makes this safe beside a rotation, which moves the live log into the archive
 * with an unlink and a rename of its own and queues behind nothing. However its
 * two steps interleave with these two, what this removes is the previous
 * archive, or the file the truncate has just emptied, or the live log the
 * rename moved there before the truncate could reach it — never a pre-Clear
 * generation left standing. Removing the archive first would leave exactly
 * that, if the rename fell between the two.
 *
 * Never rejects, like every other call into this queue. A file that is not
 * there is already empty. A truncate that fails for any other reason leaves the
 * file as it was — the ring is emptied either way, and the older generations
 * are still removed — and that failure is written into `outcome`, because the
 * caller is about to tell somebody the history is gone (#1140). It used to be
 * swallowed here and nowhere read it back, so a Clear on a read-only volume
 * answered "cleared" over a log the next boot replayed in full.
 *
 * BOUNDED, by flushAppends and for its reason: the caller is answering an HTTP
 * request. A deadline reached leaves the turn on the chain, where it is still
 * in order; only the answer goes out first — and `outcome.error` is then still
 * undefined, which means "not known yet" rather than "worked".
 *
 * THE ARCHIVE'S REMOVAL IS REPORTED TOO. An archive still there after a Clear is
 * the whole history again at the next boot — the replay falls back to it once
 * the live log is empty (#1130) — so a Clear that emptied the live file but could
 * not remove the archive has not done what it says. This used to swallow that
 * unlink's error the way it once swallowed the truncate's. A missing archive
 * counts as removed, as a missing log counts as empty.
 *
 * @param {string}   filePath   the log to empty
 * @param {string[]} [archives] older generations of it, removed in the same turn
 * @param {number}   [ms]       how long to wait for the turn to be over
 * @param {{ error?: Error | null, archiveError?: Error | null }} [outcome]
 *        filled in when the turn runs: `error` is the truncate's failure, or null
 *        once the file is empty; `archiveError` is the first archive that could
 *        not be removed, or null once none is left
 * @returns {Promise<boolean>} whether it was over before the deadline
 */
export function emptyLog(filePath, archives = [], ms = 3000, outcome = {}) {
  const turn = tailOf(filePath)
    .then(() => truncate(filePath, 0))
    .then(
      () => { outcome.error = null; },
      err => { outcome.error = err?.code === "ENOENT" ? null : (err ?? new Error("truncate failed")); },
    )
    .then(async () => {
      let first = null;
      for (const older of archives) {
        try { await unlink(older); }
        catch (err) { if (err?.code !== "ENOENT" && !first) first = err ?? new Error("unlink failed"); }
      }
      outcome.archiveError = first;
    })
    .catch(() => {});
  installTail(filePath, turn);
  return flushAppends(filePath, ms);
}

/**
 * One line, one write(2). The loop exists only for the short-write case
 * described above; on every filesystem that does not do that it runs once.
 *
 * `position` is left null on purpose. That is what makes libuv issue write(2)
 * rather than pwrite(2), and pwrite is the version that does not honour
 * O_APPEND on every platform — it would write at an offset computed before the
 * other writer moved the end of the file.
 */
async function writeWholeLine(filePath, line) {
  // Encoded up front so the short-write loop can count bytes rather than UTF-16
  // units. A multi-byte character split across two chunks would otherwise be
  // resumed mid-sequence and the line would be mojibake even without a race.
  const buf = Buffer.from(line, "utf8");
  const handle = await open(filePath, "a");
  try {
    let written = 0;
    while (written < buf.byteLength) {
      const { bytesWritten } = await handle.write(buf, written, buf.byteLength - written, null);
      // A write that reports no progress would spin this loop forever inside a
      // promise nobody is watching. Give up on the line instead.
      if (bytesWritten <= 0) throw new Error(`append made no progress at ${written}/${buf.byteLength} bytes`);
      written += bytesWritten;
    }
  } finally {
    await handle.close();
  }
}
