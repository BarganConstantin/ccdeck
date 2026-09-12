// What a session is producing between its tool calls.
//
// THE HOLE THIS FILLS. The hooks fire at boundaries — a prompt goes in, a tool
// starts, a tool ends, a turn ends — and nothing at all fires while the model
// is working. Measured on this machine's transcripts over six hours: 86 minutes
// in 648 thinking blocks, 16.5% of all measured time and MORE than the time
// spent inside tool calls, with nothing drawn for any of it. A card that is
// working looks exactly like a card that has died, and the only way to tell
// them apart was to wait and see whether anything ever appeared.
//
// WHAT THE TRANSCRIPT KNOWS THAT THE HOOKS DO NOT. Claude Code appends one JSON
// line per content block as that block completes, each with its own timestamp:
//
//     assistant  19:04:40.038  thinking
//     assistant  19:04:41.446  text
//     assistant  19:04:44.174  tool_use
//
// So the file advances DURING a turn, at a measured median of 4.1s between
// blocks, and the deck already knows where that file is — every Claude hook
// payload carries `transcript_path` and four scanners already read it. What
// none of them do is look BETWEEN events, which is the only place this signal
// lives.
//
// WHY THIS IS A STAT AND NOT A READ. The transcripts here run to megabytes and
// the question being asked each tick is one bit: did it grow. So the poll stats
// and nothing else, and only a file that moved is opened — and then only from
// the byte where the last read stopped, never from the beginning. A session
// that is quiet costs one `stat` per tick and no bytes at all.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not claim to know what the model is
// doing NOW. A block is written when it FINISHES, so the honest statement is
// "this session completed a thinking block 2 seconds ago" — and 2.1s is the
// measured median for what follows one, with 99% landing inside 25.5s. The
// freshness judgement belongs to the reader, which is why this emits a
// timestamp and a kind and no verdict.
import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

/** Read no more than this from one file in one tick.
 *
 *  A tail is normally a few kilobytes — one block. This is the ceiling for the
 *  case that is not normal: a session that was quiet while the deck was not
 *  watching, or a file replaced under the same name. Past it the watch skips
 *  to the end rather than reading megabytes to answer a one-bit question; the
 *  next block to land is then seen normally. */
const MAX_TAIL_BYTES = 256 * 1024;

/** The block kinds worth telling apart, in the order a tie is broken.
 *
 *  One assistant record can carry several blocks — a thinking block and the
 *  tool call it produced arrive together often enough to matter — and the
 *  interesting one is the one that says the model was REASONING rather than
 *  the mechanical result of it. */
const KIND_ORDER = ["thinking", "tool_use", "text"];

/**
 * What one transcript line says was produced, or null for a line that says
 * nothing about production.
 *
 * A `user` record carrying a tool_result is the tool answering, not the model
 * producing, and counting it would make every tool call look like generation.
 * Anything unparseable is null rather than a throw: this reads a file that is
 * being appended to, and a torn final line is the ordinary case, not an error.
 */
export function blockKindOf(line) {
  if (!line) return null;
  let rec;
  try { rec = JSON.parse(line); } catch { return null; }
  if (!rec || rec.type !== "assistant") return null;
  const content = rec.message?.content;
  if (!Array.isArray(content)) return null;
  const types = new Set(content.map(b => b?.type));
  for (const kind of KIND_ORDER) if (types.has(kind)) return kind;
  return null;
}

/** When that line says it happened, or null. Its own stamp rather than the
 *  clock here: the deck may be reading a block that landed while it was busy,
 *  and dating it `now` would report work as having just happened when it did
 *  not. */
export function blockTimeOf(line) {
  if (!line) return null;
  let rec;
  try { rec = JSON.parse(line); } catch { return null; }
  const t = rec?.timestamp ? Date.parse(rec.timestamp) : NaN;
  return Number.isFinite(t) ? t : null;
}

/**
 * EVERY block in a chunk of whole-ish lines, oldest first.
 *
 *  Not the newest one. This took only the last block and lost the interesting
 *  half of nearly every turn: measured on this machine, consecutive blocks land
 *  1.4s and 2.7s apart, so a `thinking` and the `tool_use` it produced arrive
 *  inside one 1500ms tick more often than not — and reporting only the newest
 *  meant the canvas saw `tool_use` forever and `thinking` never, which is the
 *  one thing this whole watch exists to show. Confirmed on the live deck: two
 *  ticks, two events, both `tool_use`, no thinking at all.
 *
 *  It also undercounted. Each block is a unit of work the model finished and
 *  the activity chart marks one per block, so folding three into one drew a
 *  third of the movement that happened.
 */
export function blocksIn(chunk) {
  const out = [];
  for (const line of chunk.split("\n")) {
    const kind = blockKindOf(line);
    if (kind) out.push({ kind, at: blockTimeOf(line) });
  }
  return out;
}

/**
 * The watch.
 *
 * `io` is injectable so the whole of this can be tested without a filesystem,
 * and so the suite can drive a file that grows, shrinks, vanishes and comes
 * back without arranging any of that for real.
 */
export function createOutputWatch(io = {}) {
  const statFile = io.stat ?? (p => stat(p));
  const openFile = io.open ?? (p => open(p, "r"));
  /** sid -> { path, offset, size } — where this session's file is and how far
   *  into it the watch has already looked. */
  const seen = new Map();

  /** Remember where a session's transcript is. Called for every hook payload
   *  that carries one, which is every Claude hook: the path is free there and
   *  there is nowhere else to learn it. A path that changes for a session
   *  replaces the entry and restarts at that file's end — see `note`. */
  function note(sid, path) {
    if (!sid || !path) return;
    const prev = seen.get(sid);
    if (prev && prev.path === path) return;
    // Start at the END of a file the watch has not seen before. Everything
    // already in it happened before the deck looked, and replaying it would
    // report a morning's thinking as having just occurred.
    seen.set(sid, { path, offset: null, size: null });
  }

  function forget(sid) { seen.delete(sid); }

  /** For the suite, and for the one place the server clears everything. */
  function clear() { seen.clear(); }
  function size() { return seen.size; }

  /**
   * One tick. Stats each named session's file, reads only what is new, and
   * answers with EVERY block that landed in it, oldest first — see blocksIn
   * for why the newest alone was the wrong answer.
   *
   * Sessions the caller believes are live, and no others: a finished session's
   * file can still be appended to by a later turn, and the deck has its own
   * rules about what counts as live. This asks no questions about that.
   */
  async function poll(liveSids) {
    const out = [];
    for (const sid of liveSids) {
      const entry = seen.get(sid);
      if (!entry) continue;
      let st;
      try { st = await statFile(entry.path); } catch { continue; }
      const size = Number(st?.size ?? 0);
      // First sight: record where the end is and report nothing. The file's
      // whole history is older than this deck's interest in it.
      if (entry.offset == null) { entry.offset = size; entry.size = size; continue; }
      // TRUNCATED OR REPLACED. A file that is now shorter than the byte this
      // watch was going to read from is not the file it was reading; seeking to
      // the old offset would return whatever now lives there. Start again at
      // the new end rather than guessing which bytes are which.
      if (size < entry.offset) { entry.offset = size; entry.size = size; continue; }
      if (size === entry.offset) continue;
      // Past the ceiling, skip to the end. See MAX_TAIL_BYTES.
      if (size - entry.offset > MAX_TAIL_BYTES) { entry.offset = size; entry.size = size; continue; }

      const from = entry.offset;
      const want = size - from;
      let fd;
      let text = "";
      try {
        fd = await openFile(entry.path);
        const buf = Buffer.allocUnsafe(want);
        const { bytesRead } = await fd.read(buf, 0, want, from);
        // A decoder rather than toString, because a tail can begin or end in
        // the middle of a UTF-8 sequence and a replacement character in the
        // middle of a JSON string breaks the parse for a whole block.
        const dec = new StringDecoder("utf8");
        text = dec.write(buf.subarray(0, Math.max(0, bytesRead))) + dec.end();
        entry.offset = from + Math.max(0, bytesRead);
        entry.size = size;
      } catch {
        continue;
      } finally {
        // Awaited, for the reason codex-usage.mjs gives: a close scheduled and
        // abandoned leaves a handle open, and on Windows a file with a handle
        // on it cannot be deleted.
        await fd?.close().catch(() => {});
      }

      // A tail that ends mid-line is the ordinary case — the file is being
      // appended to while this reads it. Rewind the offset to the start of the
      // torn line so the next tick sees it whole rather than dropping it.
      const lastNl = text.lastIndexOf("\n");
      if (lastNl < 0) {
        // No complete line at all yet. Give the bytes back and wait.
        entry.offset = from;
        continue;
      }
      if (lastNl < text.length - 1) {
        entry.offset -= Buffer.byteLength(text.slice(lastNl + 1), "utf8");
        text = text.slice(0, lastNl);
      }

      // Oldest first, so a reader that refuses to move backwards accepts the
      // whole run rather than only its last member.
      for (const b of blocksIn(text)) out.push({ sid, kind: b.kind, at: b.at });
    }
    return out;
  }

  return { note, forget, clear, size, poll };
}
