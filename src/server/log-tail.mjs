// Reading a log backwards, because only its end is ever kept.
//
// #742. The event log is replayed before the port opens, and the replay parsed
// every line in it from the beginning — 12,079 lines and 31 MB on the machine
// this was measured on, 690ms of JSON.parse, growing with every session until
// rotation cuts it at 50 MB. The ring it fills holds MAX_BUFFER = 2000 events.
// So roughly five sixths of that work was parsing events that were evicted by
// the ones parsed after them, on the critical path of a boot, every time.
//
// Reading from the end fixes the asymmetry rather than the constant: the loop
// stops as soon as the ring is full, so the cost becomes a property of the ring
// instead of a property of how long the user has been running the deck. When
// the ring cannot be filled — a young log, or a workspace-scoped deck whose
// events are a thin slice of a shared one — it reads all the way back to the
// start and costs exactly what the forward read did. There is no case where
// this is slower and no case where it sees less.
//
// Bytes, not characters. Lines are split on 0x0A and decoded one at a time,
// which is safe in UTF-8 because no byte of a multi-byte sequence can be 0x0A —
// a chunk boundary landing inside a three-byte character joins back together
// before anything is decoded. Decoding the chunk first and splitting the string
// is what would corrupt it, and it is the obvious way to write this.
import { open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/** One line out of a buffer, minus the carriage return a CRLF file leaves on
 *  the end of it. Sliced before decoding — see the note about 0x0A above. */
function line(buf, from, to) {
  const end = to > from && buf[to - 1] === 0x0D ? to - 1 : to;
  return buf.subarray(from, end).toString("utf8");
}

/** How much is read at a time. One megabyte holds about 400 events at the size
 *  this log's lines actually run to, so a full ring is usually five reads. */
export const CHUNK_BYTES = 1 << 20;

/**
 * The file's lines, newest first, as an async iterable.
 *
 * Stops reading the moment the consumer stops asking — that is the whole point,
 * and it is why this is a generator rather than a function returning an array.
 * A `break` in the caller closes the handle through the generator's `finally`.
 *
 * Lines are yielded WITHOUT their newline, and the sequence is exactly the
 * reverse of what `readline` yields reading the same file forwards — empty
 * lines included, and a trailing newline at EOF is a line terminator rather
 * than an empty line after it. A CRLF file reads the same as it does forwards,
 * because the carriage return is stripped here too. That equivalence is the
 * contract, and it is what the round-trip case in the test file checks against
 * readline itself rather than against a hand-written expectation.
 *
 * The ONE difference: `readline` also breaks on a lone carriage return, for the
 * sake of files written by software that predates OS X. Walking those backwards
 * would mean scanning every byte of every chunk instead of asking Buffer for
 * the next 0x0A, and nothing that writes a line into this deck's log has
 * produced one since 2001. A file full of lone carriage returns reads here as a
 * single very long line, which JSON.parse then declines — one skipped line,
 * counted and reported, rather than a wrong answer.
 */
export async function* linesFromEnd(filePath, { chunkBytes = CHUNK_BYTES, openFile = open } = {}) {
  const fh = await openFile(filePath, "r");
  try {
    const { size } = await fh.stat();
    let pos = size;
    // The bytes at the front of what has been read that have no newline before
    // them yet: the first line of the chunk, which may continue into the chunk
    // that comes before it. Carried, never yielded, until a newline turns up or
    // the start of the file does.
    let carry = Buffer.alloc(0);
    // The newline that ends the last line is a terminator, not the start of an
    // empty line after it. Trimmed once, on the chunk that holds EOF.
    let atEof = true;

    while (pos > 0) {
      const len = Math.min(chunkBytes, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      // Node reads short at the end of a file and at a pipe; a regular file
      // opened for reading at a known offset does not, but the loop is written
      // to survive it rather than to assume it.
      let got = 0;
      while (got < len) {
        const { bytesRead } = await fh.read(buf, got, len - got, pos + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      const hay = carry.length ? Buffer.concat([buf.subarray(0, got), carry]) : buf.subarray(0, got);

      // Walk the newlines from the end. `end` is one past the last byte of the
      // line being cut; every cut is a complete line, because everything to its
      // right has already been yielded.
      let end = hay.length;
      if (atEof && end > 0 && hay[end - 1] === 0x0A) end--;
      atEof = false;
      while (end > 0) {
        const nl = hay.lastIndexOf(0x0A, end - 1);
        if (nl === -1) break;
        yield line(hay, nl + 1, end);
        end = nl;
      }
      carry = hay.subarray(0, end);
    }

    // Whatever is left has the start of the file in front of it, so it is a
    // whole line — and an EMPTY one is still a line, which is why this is not
    // conditional on `carry.length`. A file that opens with a newline opens
    // with an empty line, and reading it forwards says so.
    if (size > 0) yield line(carry, 0, carry.length);
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * The same file, the ordinary way round.
 *
 * Here rather than at the one call site so the two readers sit together and a
 * reader of either finds the other: replayLog picks between them per boot, on
 * whether its scope predicate can be fed a log backwards, and a pair of
 * functions in one file is what makes that choice legible.
 *
 * Streams, so a scoped deck on a 50 MB log holds one line at a time exactly as
 * it did before any of this.
 */
export async function* linesFromStart(filePath) {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input });
  try {
    for await (const line of rl) yield line;
  } finally {
    // Both, and the stream second. `rl.close()` stops the interface and leaves
    // the descriptor under it open, which is fine for the one caller here
    // because it reads to the end — and is a leak the day somebody breaks out
    // of this loop the way the backwards reader is designed to be broken out of.
    rl.close();
    input.destroy();
  }
}
