// Following an append-only JSONL one bounded chunk at a time: the read that
// hands back only complete lines and moves a cursor past exactly the bytes they
// occupy, and the ceiling on what any one read may allocate.
//
// These lived in src/server/transcript-scan.mjs, which still reads every Claude
// transcript through them, and the Codex side borrowed them from there: the
// rollout watcher tails rollouts with readAppendedLines, and
// codex-enrichment.mjs reads a rollout's head and tail with readByteRange. A
// reader that knows nothing about what either kind of file says is a module of
// its own. The bodies are unchanged, and index.mjs still re-exports
// MAX_SCAN_CHUNK and readAppendedLines.
import { open } from "node:fs/promises";

// ─── Following an append-only JSONL, one bounded chunk at a time ─────────
// The most bytes ONE read of a transcript may allocate, and the ceiling that
// makes the size of the file irrelevant to the size of the allocation.
//
// #674 is what its absence cost. `readByteRange` was called with `to` set to
// `stat().size` on a path that arrives, unvalidated, in the body of a
// credential-free `POST /api/event`, and it answered by allocating the whole of
// it — once as a zero-filled Buffer and again as the string `toString` builds
// from it. Measured here on Node 22.14 / macOS against a real deck on loopback,
// sampling `process.memoryUsage.rss()` every 5 ms:
//
//   400 MB file, one POST:   51MB -> 848MB   (2x: the Buffer and the string)
//   700 MB file, one POST:   52MB -> 753MB   (1x: 700 MB is past V8's ~512 MB
//                                             max string, so `toString` threw
//                                             into scanTranscript's catch and
//                                             only the Buffer was paid for)
//
// Both answered 200. Neither is a one-off: see `readAppendedLines` for the
// second half of that defect, the cursor that could not advance.
//
// 8 MiB is picked against the only measurement that bears on it — the longest
// single line in a real transcript. The note above `maybeResolveSessionName`
// in session-enrichment.mjs measures that at 710 KB in the 46.4 MB session on
// this machine, one big tool result on one line, so the ceiling is about eleven
// times the worst line seen and no real transcript line is ever split by it. Its worst
// case is 8 MiB of Buffer plus up to 8 MiB of string per in-flight scan, which
// is an eighth of the 128 MiB the ring buffer is already allowed to hold.
export const MAX_SCAN_CHUNK = 8 * 1024 * 1024;

const NEWLINE = 0x0a;

/** Up to MAX_SCAN_CHUNK bytes of `path` from `from`, as a Buffer of exactly the
 *  bytes that were read. The cap is here rather than at the call sites so that
 *  no caller — including one added later — can name a range that allocates more
 *  than the ceiling above. */
async function readByteChunk(path, from, to) {
  const len = Math.min(to - from, MAX_SCAN_CHUNK);
  if (len <= 0) return Buffer.alloc(0);
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, from);
    return bytesRead === len ? buf : buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function readByteRange(path, from, to) {
  return (await readByteChunk(path, from, to)).toString("utf8");
}

/**
 * The next batch of COMPLETE lines appended to a JSONL file, and the cursor
 * moved past exactly the bytes they occupy.
 *
 * `cursor` is `{ offset, midLine }` and is written in place; `size` is the
 * caller's `stat()` reading. Returns `{ text, advanced }` where `advanced` is
 * the number of bytes the cursor moved — zero means "nothing complete to fold
 * yet", which is the caller's signal to stop.
 *
 * THE THREE THINGS THIS HAS TO GET RIGHT, and the one it used to get wrong:
 *
 *  1. A partial last line is not an error. A transcript is being appended to
 *     while it is read, so the tail of any chunk that ends at EOF is routinely
 *     half a line. Those bytes stay unread and the cursor does not move —
 *     the next pass sees the whole line once its newline lands.
 *
 *  2. A chunk with no newline in it that DOES NOT end at EOF is a different
 *     thing entirely, and the old code could not tell the two apart: it
 *     returned without advancing in both cases. For any file with no newline in
 *     it — any binary, a sparse file a caller makes for the purpose — that made
 *     the early return permanent, so every later POST re-read the whole file
 *     from byte 0. Measured before the fix, the same 400 MB file: 797 MB on the
 *     first post, 400 MB on the second, 400 MB on the third. Here that case is
 *     what `midLine` names: a full chunk with no line boundary anywhere in it
 *     is a line longer than the ceiling, there is no line there to wait for, so
 *     the cursor walks past it and the fragment that follows is dropped when
 *     the next boundary arrives.
 *
 *  3. The cursor is moved by BYTES, taken from the buffer, never by
 *     `Buffer.byteLength` of the decoded text. Chunking can split a multi-byte
 *     character at the ceiling, and `toString` turns a split character into a
 *     replacement character of a different width — so measuring the advance on
 *     the string would drift the cursor on any transcript containing non-ASCII,
 *     which is most of them. Slicing at the last newline (a byte that cannot be
 *     part of a multi-byte sequence) and advancing by its index is exact.
 */
export async function readAppendedLines(path, cursor, size, chunkMax = MAX_SCAN_CHUNK) {
  const from = cursor.offset;
  const want = Math.min(size - from, chunkMax);
  if (want <= 0) return { text: "", advanced: 0 };
  const buf = await readByteChunk(path, from, from + want);
  if (buf.length === 0) return { text: "", advanced: 0 };

  const lastNl = buf.lastIndexOf(NEWLINE);
  if (lastNl < 0) {
    // Reaching the end of the file with no newline in hand is the ordinary
    // partial last line: wait for its newline. (1) above. The test is where the
    // read STOPPED, not how much was asked for, because `readByteChunk` clamps
    // to MAX_SCAN_CHUNK and a short read is normally that clamp rather than the
    // end of anything.
    if (from + buf.length >= size) return { text: "", advanced: 0 };
    // A chunk with no line boundary in it, and more file after it. (2).
    cursor.offset = from + buf.length;
    cursor.midLine = true;
    return { text: "", advanced: buf.length };
  }

  const advanced = lastNl + 1;            // (3): bytes, up to and including the \n
  let text = buf.toString("utf8", 0, lastNl);
  if (cursor.midLine) {
    // This chunk opens in the middle of a line we already walked past, so
    // everything up to the first boundary is the tail of it and folding it
    // would fold a fragment. Only the lines after it are whole.
    const nl = text.indexOf("\n");
    text = nl < 0 ? "" : text.slice(nl + 1);
    cursor.midLine = false;
  }
  cursor.offset = from + advanced;
  return { text, advanced };
}

// What the Codex side calls besides the two exported above. Listed rather than
// marked, so the declaration reads as it did where it came from.
export { readByteRange };
