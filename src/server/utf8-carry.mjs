// Whole UTF-8 characters at the edges of a byte stream cut into frames.
//
// WHY. tmux control mode reports what a pane writes as `%output` lines, and a
// line ends where tmux's read of the pane ended, which can be inside a
// character: on tmux 3.8 and 3.4 alike, punctuation-heavy output has lines
// that stop after the first one or two bytes of a "—", "…", "’" or "”"
// (terminal-utf8-tmux.test.ts counts them). The relay sends each line as one
// binary frame, and the panel writes each frame to xterm.js on its own.
// xterm.js keeps the bytes of a character a write left unfinished and joins
// them to the next write — except when the bytes it kept end in the
// continuation byte 0x80: it counts what it kept by reading up to the first
// byte whose low six bits are zero, so it loses that byte, and with it the
// character. E2 80 | 94 never shows its "—", nor E2 80 | A6 its "…", nor
// F0 9F 80 | 80 its four-byte character.
//
// WHAT. A frame is sent without the bytes at its end that begin a character
// the frame does not finish — at most three, since no character is longer
// than four — and those bytes go out in front of the next frame. Nothing is
// ever changed, replaced or reordered: every byte goes out once, in order.
// Only bytes that more bytes could still turn into a character are held, by
// the well-formed table (Unicode, Table 3-7; E0 needs A0..BF next, ED
// 80..9F, F0 90..BF, F4 80..8F). Bytes that can never finish one — a lone
// continuation, C0, C1, F5..FF, the start of a surrogate or of an overlong
// form — are malformed already and go out as they are, in the frame they came
// in; so do held bytes as soon as the next frame shows they cannot finish.
//
// Held bytes belong to the stream they came from. When the stream breaks off,
// the caller drops them (drop()); terminal-bridge.mjs says at each break why.
//
// INSIDE ONE WRITE, the same loss. xterm.js 6.0 decodes a write longer than
// 131072 bytes (MAX_PARSEBUFFER_LENGTH in its InputHandler) in pieces of that
// size, keeping across a piece edge exactly what it keeps across two writes —
// so a character cut by a piece edge right after a 0x80 is lost the same way.
// A seed with two thousand lines of coloured history is 200 to 400 KB, one
// frame and one write: a "—" at byte 131070 of it never showed. A frame cannot
// be cut where it suits (the seed is ONE frame after `reset`), so
// padPieceEdges moves the character instead: 0xFF bytes in front of it, as
// many as it takes for the character to begin at the edge. No character
// begins or continues with 0xFF, and xterm.js's decoder skips it: it draws
// nothing and moves nothing.
//
// Pure: no I/O, no timers. A frame that ends on a character boundary, which is
// nearly every frame, is handed back as it came, without a copy; so is a frame
// no longer than one piece.

/** The length of the character a lead byte begins: 1 for ASCII, 2 to 4, or 0
 *  for a byte no character begins with (a continuation, C0, C1, F5..FF). */
function sequenceLength(lead) {
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

/** Whether `second` may follow `lead` in a well-formed character. */
function secondFits(lead, second) {
  const lo = lead === 0xe0 ? 0xa0 : lead === 0xf0 ? 0x90 : 0x80;
  const hi = lead === 0xed ? 0x9f : lead === 0xf4 ? 0x8f : 0xbf;
  return second >= lo && second <= hi;
}

/**
 * How many bytes at the end of `bytes` begin a character that more bytes could
 * still finish: 0 to 3. 0 when the end is a character boundary, and when the
 * bytes there can never finish a character (they are malformed already).
 */
export function unfinishedTail(bytes) {
  const n = bytes.length;
  // Back over continuation bytes to the byte that began the last character,
  // looking no further than three: a fourth would make a whole character.
  for (let k = 1; k <= 3 && k <= n; k++) {
    const lead = bytes[n - k];
    if ((lead & 0xc0) === 0x80) continue;
    if (sequenceLength(lead) <= k) return 0;
    // The continuations so far are well formed if the second one is: the
    // table narrows only the second byte, and the loop has seen that the
    // others are 80..BF.
    if (k >= 2 && !secondFits(lead, bytes[n - k + 1])) return 0;
    return k;
  }
  return 0;
}

const EMPTY = Buffer.alloc(0);

const asBuffer = (bytes) => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));

/** The pieces xterm.js 6.0 decodes one long write in (MAX_PARSEBUFFER_LENGTH). */
export const XTERM_PIECE = 131072;

/** The filler: a byte no character begins or continues with, which xterm.js's
 *  decoder skips without drawing anything. */
export const FILLER = 0xff;

/**
 * `bytes` as one write may carry them: with FILLER in front of every character
 * that a multiple of `piece` would otherwise cut, so that it begins at that
 * edge instead. A character here is a lead byte and the continuation bytes
 * after it that it asks for, well formed or not — one write of the same bytes
 * keeps them together too. At most three filler bytes an edge. Answers `bytes`
 * itself, uncopied, when no edge cuts a character, and always for a write no
 * longer than one piece.
 */
export function padPieceEdges(bytes, piece = XTERM_PIECE) {
  // A piece must hold any character whole, and the filler of the edge before.
  if (!Number.isSafeInteger(piece) || piece < 8) throw new RangeError("a piece is at least 8 bytes");
  const buf = asBuffer(bytes);
  if (buf.length <= piece) return buf;
  const parts = [];
  let from = 0;
  let added = 0;
  // `edge` counts in the padded write; `at` is the input byte that lands on it.
  for (let edge = piece; edge - added < buf.length; edge += piece) {
    const at = edge - added;
    if ((buf[at] & 0xc0) !== 0x80) continue;
    // Back over the continuations to the byte that began this character.
    for (let k = 1; k <= 3; k++) {
      const lead = buf[at - k];
      if ((lead & 0xc0) === 0x80) continue;
      if (sequenceLength(lead) > k) {
        parts.push(buf.subarray(from, at - k), Buffer.alloc(k, FILLER));
        from = at - k;
        added += k;
      }
      break;
    }
  }
  if (!added) return buf;
  parts.push(buf.subarray(from));
  return Buffer.concat(parts);
}

/**
 * One stream's carry: frame(bytes) answers the bytes to send for a frame —
 * what was held, then the frame, less an unfinished character at its end,
 * which is held instead. The answer may be empty (all of it is held): send
 * nothing then. drop() forgets what is held and answers how many bytes that
 * was; `held` is how many are held now (0 to 3).
 */
export function utf8Carry() {
  let held = EMPTY;
  return {
    frame(bytes) {
      const buf = asBuffer(bytes);
      const all = held.length ? Buffer.concat([held, buf]) : buf;
      const keep = unfinishedTail(all);
      // A copy of what is kept: the frame's memory is the caller's.
      held = keep ? Buffer.from(all.subarray(all.length - keep)) : EMPTY;
      return keep ? all.subarray(0, all.length - keep) : all;
    },
    drop() {
      const n = held.length;
      held = EMPTY;
      return n;
    },
    get held() { return held.length; },
  };
}
