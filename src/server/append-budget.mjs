// What the events log's append queue is allowed to weigh (#1030): the ceiling
// on lines accepted and not yet written, the charge each line carries until
// its write settles, and what the queue refused at the door because of it.
//
// Moved out of log-writer.mjs unchanged. appendLogLine asks queueIsFull at the
// door, then either counts a refusal (noteRefused) or takes the line's charge
// (takeCharge) and gives it back once the write has landed or failed
// (releaseCharge). log-writer.mjs re-exports MAX_PENDING_APPEND_CHARS and
// appendQueueStats, which is where the suite reaches them.
import { PRODUCT } from "./brand.mjs";

// ─── What the queue is allowed to weigh ───────────────────────────────────
//
// The chain in log-writer.mjs ORDERS appends. Nothing bounded them. Every line
// handed over is retained by the closure that will eventually write it, and
// the only brake on how many of those exist at once is how fast write(2)
// returns — while pushEvent hands them over fire-and-forget and answers
// `{ok:true, seq}` on the next statement, so `POST /api/event` admits lines as
// fast as a socket can deliver them.
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
export function queueIsFull(charged) {
  return pendingLines > 0 && pendingChars + charged > MAX_PENDING_APPEND_CHARS;
}

/** One line accepted: charge it until releaseCharge gives the charge back. */
export function takeCharge(charged) {
  pendingLines++;
  pendingChars += charged;
}

/** One line refused at the door: count it, and open an episode if this is the
 *  first refusal since the queue last drained. */
export function noteRefused(filePath, charged) {
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
export function releaseCharge(charged) {
  pendingLines--;
  pendingChars -= charged;
  if (pendingLines > 0 || !shedding) return;
  console.error(`${PRODUCT}: the log append queue drained — ${episodeLines} event(s) (${mb(episodeChars)}) were dropped and are not in the log`);
  shedding = false;
  episodeLines = 0;
  episodeChars = 0;
}
