// utf8-carry.mjs on its own: which bytes at a frame's end begin a character
// more bytes could still finish, and the carry that holds them for the next
// frame of the stream; and the filler that keeps a long frame's characters
// whole inside one write. terminal-bridge-utf8.test.ts plays the same rules
// through the relay; this file pins the rules themselves, byte by byte,
// against the well-formed UTF-8 table (Unicode, Table 3-7).
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { unfinishedTail, utf8Carry, padPieceEdges, XTERM_PIECE, FILLER } from "../../server/utf8-carry.mjs";

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ""), "hex");

/** The longest prefix of a well-formed sequence these bytes are, by the
 *  table: the oracle unfinishedTail is checked against. */
function wellFormedPrefix(b: number[]): boolean {
  const [b0, b1, b2] = b;
  const cont = (x: number) => x >= 0x80 && x <= 0xbf;
  const second: [number, number] | null =
    b0 >= 0xc2 && b0 <= 0xdf ? [0x80, 0xbf]
      : b0 === 0xe0 ? [0xa0, 0xbf]
        : (b0 >= 0xe1 && b0 <= 0xec) || b0 === 0xee || b0 === 0xef ? [0x80, 0xbf]
          : b0 === 0xed ? [0x80, 0x9f]
            : b0 === 0xf0 ? [0x90, 0xbf]
              : b0 >= 0xf1 && b0 <= 0xf3 ? [0x80, 0xbf]
                : b0 === 0xf4 ? [0x80, 0x8f] : null;
  if (!second) return false;
  const need = b0 <= 0xdf ? 2 : b0 <= 0xef ? 3 : 4;
  if (b.length >= need) return false; // finished, not a prefix
  if (b.length >= 2 && !(b1 >= second[0] && b1 <= second[1])) return false;
  if (b.length >= 3 && !cont(b2)) return false;
  return true;
}

describe("unfinishedTail", () => {
  it("is 0 for ASCII, whole characters and an empty frame", () => {
    for (const s of ["", "A", "abc", "—", "A—", "é", "世", "🚀", "🀀", "é", "”done”\r\n"]) {
      expect(unfinishedTail(Buffer.from(s, "utf8")), JSON.stringify(s)).toBe(0);
    }
  });

  it("counts the bytes of a character begun but not finished: 1 to 3", () => {
    const cases: [string, number][] = [
      ["41 E2", 1], ["41 E2 80", 2], ["E2 80", 2], ["41 C3", 1], ["65 CC", 1], ["E4 B8", 2],
      ["F0", 1], ["F0 9F", 2], ["F0 9F 9A", 3], ["F0 9F 80", 3], ["41 F4 8F BF", 3], ["E0 A0", 2], ["ED 9F", 2],
    ];
    for (const [h, n] of cases) expect(unfinishedTail(hex(h)), h).toBe(n);
  });

  it("is 0 where the bytes can never finish a character: they are malformed already", () => {
    for (const h of ["80", "41 80", "E2 80 94 80", "80 80 80", "BF BF BF", "C0", "C1", "F5", "FF", "ED A0", "E0 80", "E0 9F",
      "F0 80", "F0 8F", "F4 90", "E2 41", "F0 9F 41"]) {
      expect(unfinishedTail(hex(h)), h).toBe(0);
    }
  });

  it("agrees with the table for every one- and two-byte ending, and every three-byte one by its first two bytes and the class of its third", () => {
    // Every first byte, followed by every second byte, followed by a
    // representative of each class a third byte can be in (an edge of every
    // range the table names, on both sides).
    const thirds = [0x00, 0x41, 0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0, 0xc1, 0xc2, 0xdf, 0xe0, 0xe1, 0xed, 0xef,
      0xf0, 0xf1, 0xf3, 0xf4, 0xf5, 0xff];
    for (let a = 0; a < 256; a++) {
      expect(unfinishedTail(Buffer.from([a])), `${a}`).toBe(wellFormedPrefix([a]) ? 1 : 0);
      for (let b = 0; b < 256; b++) {
        const two = [a, b];
        const want2 = wellFormedPrefix(two) ? 2 : wellFormedPrefix([b]) ? 1 : 0;
        expect(unfinishedTail(Buffer.from(two)), two.join(",")).toBe(want2);
        for (const c of thirds) {
          const three = [a, b, c];
          const want3 = wellFormedPrefix(three) ? 3 : wellFormedPrefix([b, c]) ? 2 : wellFormedPrefix([c]) ? 1 : 0;
          if (unfinishedTail(Buffer.from(three)) !== want3) expect(unfinishedTail(Buffer.from(three)), three.join(",")).toBe(want3);
        }
      }
    }
  });
});

describe("utf8Carry", () => {
  it("holds an unfinished character, at most three bytes, and puts it in front of the next frame", () => {
    const c = utf8Carry();
    expect([...c.frame(hex("41 F0 9F 9A"))]).toEqual([0x41]);
    expect(c.held).toBe(3);
    expect([...c.frame(hex("80 42"))]).toEqual([...hex("F0 9F 9A 80 42")]);
    expect(c.held).toBe(0);
  });

  it("answers an empty frame while all it has is an unfinished character, and never more than three held", () => {
    const c = utf8Carry();
    for (const b of hex("F0 9F 9A")) {
      expect(c.frame(Buffer.from([b])).length).toBe(0);
      expect(c.held).toBeLessThanOrEqual(3);
    }
    expect([...c.frame(hex("80"))]).toEqual([...hex("F0 9F 9A 80")]);
  });

  it("drop() forgets what it held and says how much", () => {
    const c = utf8Carry();
    c.frame(hex("41 E2 80"));
    expect(c.drop()).toBe(2);
    expect(c.held).toBe(0);
    expect([...c.frame(hex("94 42"))]).toEqual([...hex("94 42")]);
    expect(c.drop()).toBe(0);
  });

  it("hands back the frame itself when nothing is held or kept, and keeps its own copy of what it holds", () => {
    const c = utf8Carry();
    const whole = Buffer.from("plain text — whole", "utf8");
    expect(c.frame(whole)).toBe(whole);
    const cut = hex("41 E2 80");
    c.frame(cut);
    cut.fill(0);
    expect([...c.frame(hex("94"))]).toEqual([...hex("E2 80 94")]);
  });

  it("takes a Uint8Array as well as a Buffer", () => {
    const c = utf8Carry();
    expect([...c.frame(Uint8Array.from([0x41, 0xe2]))]).toEqual([0x41]);
    expect([...c.frame(Uint8Array.from([0x80, 0x94]))]).toEqual([0xe2, 0x80, 0x94]);
  });
});

describe("padPieceEdges", () => {
  const lead = (b: number) => (b < 0x80 ? 1 : b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0);
  const isCont = (b: number) => (b & 0xc0) === 0x80;
  const unpad = (b: Buffer) => Buffer.from(b.filter((x) => x !== FILLER));
  const hexList = (b: number[]) => b.map((x) => x.toString(16).padStart(2, "0")).join(" ");

  /** The edges (multiples of `piece` inside `out`) that fall after a
   *  character's lead byte and before the last byte it asks for. */
  function cutEdges(out: Buffer, piece: number): number[] {
    const cut: number[] = [];
    for (let edge = piece; edge < out.length; edge += piece) {
      if (!isCont(out[edge])) continue;
      for (let k = 1; k <= 3 && edge - k >= 0; k++) {
        if (isCont(out[edge - k])) continue;
        if (lead(out[edge - k]) > k) cut.push(edge);
        break;
      }
    }
    return cut;
  }

  /** Every run of filler in `out`: where it ends and how long it is. */
  function fillerRuns(out: Buffer): { end: number; length: number }[] {
    const runs: { end: number; length: number }[] = [];
    for (let i = 0; i < out.length; i++) {
      if (out[i] !== FILLER) continue;
      let j = i;
      while (j < out.length && out[j] === FILLER) j++;
      runs.push({ end: j, length: j - i });
      i = j;
    }
    return runs;
  }

  /** What the padding owes, for an input without 0xFF (so every 0xFF in the
   *  answer is filler): no edge cuts a character, nothing but filler is added,
   *  and each run of filler is one edge's, as short as that edge needs. A run
   *  ends at an edge, right before a lead byte that asks for more bytes than
   *  the run is long, and the bytes after that lead that the run moved across
   *  the edge are its continuations. */
  function expectPadded(input: Buffer, out: Buffer, piece: number, what: string) {
    expect(input.includes(FILLER), what).toBe(false);
    expect(cutEdges(out, piece), what).toEqual([]);
    expect(unpad(out).equals(input), what).toBe(true);
    for (const run of fillerRuns(out)) {
      expect(run.length, what).toBeLessThanOrEqual(3);
      expect(run.end % piece, what).toBe(0);
      expect(lead(out[run.end]), what).toBeGreaterThan(run.length);
      for (let i = 1; i <= run.length; i++) expect(isCont(out[run.end + i]), what).toBe(true);
    }
  }

  /** `size` bytes of ASCII with `ch` laid to begin `cut` bytes before each of `at`. */
  function laid(ch: string, cut: number, at: number[], size: number): Buffer {
    const buf = Buffer.alloc(size, 0x61);
    for (const a of at) Buffer.from(ch, "utf8").copy(buf, a - cut);
    return buf;
  }

  it("is the piece xterm.js 6.0 decodes a long write in, and a filler no character begins or continues with", () => {
    expect(XTERM_PIECE).toBe(131072);
    expect(FILLER).toBe(0xff);
    expect(lead(FILLER)).toBe(0);
    expect(isCont(FILLER)).toBe(false);
  });

  it("hands back a write no longer than one piece, and a longer one no edge cuts, as it came: no copy", () => {
    const short = laid("—", 1, [XTERM_PIECE - 4], XTERM_PIECE);
    expect(padPieceEdges(short)).toBe(short);
    // Sixteen bytes a line, beginning with ASCII: every edge falls on its "x".
    const whole = Buffer.from("x— 🚀 é z\r\n".repeat(30000), "utf8");
    expect(whole.length).toBe(16 * 30000);
    expect(cutEdges(whole, XTERM_PIECE)).toEqual([]);
    expect(padPieceEdges(whole)).toBe(whole);
  });

  it("puts filler in front of each character an edge cuts, as many bytes as the edge has of it, at 131072 and at 262144", () => {
    for (const ch of ["é", "—", "…", "世", "🚀", "𐀀"]) {
      const len = Buffer.byteLength(ch);
      for (let cut = 1; cut < len; cut++) {
        // The second character is laid `cut` bytes further on, where the
        // first edge's filler will have moved it back onto a cut.
        const input = laid(ch, cut, [XTERM_PIECE, 2 * XTERM_PIECE - cut], 3 * XTERM_PIECE);
        expect(cutEdges(input, XTERM_PIECE)[0], `${ch} ${cut}`).toBe(XTERM_PIECE);
        const out = padPieceEdges(input);
        expect(out.length - input.length, `${ch} ${cut}`).toBe(2 * cut);
        for (const edge of [XTERM_PIECE, 2 * XTERM_PIECE]) {
          const want = Buffer.concat([Buffer.alloc(cut, FILLER), Buffer.from(ch)]);
          expect(out.subarray(edge - cut, edge + len).equals(want), `${ch} ${cut} @${edge}`).toBe(true);
        }
        expectPadded(input, out, XTERM_PIECE, `${ch} ${cut}`);
      }
    }
  });

  it("counts each edge in the padded write: the filler of one edge moves what the next edge falls on", () => {
    // "—" begins 1 byte before 131072 and 1 byte before 262144 in the input:
    // the first edge's filler moves the second "—" one byte on, so in the
    // padded write it begins at that edge and needs none.
    const movedOnto = laid("—", 1, [XTERM_PIECE, 2 * XTERM_PIECE], 3 * XTERM_PIECE);
    expect(cutEdges(movedOnto, XTERM_PIECE)).toEqual([XTERM_PIECE, 2 * XTERM_PIECE]);
    const a = padPieceEdges(movedOnto);
    expect(a.length - movedOnto.length).toBe(1);
    expect(a[2 * XTERM_PIECE]).toBe(0xe2);
    expectPadded(movedOnto, a, XTERM_PIECE, "moved onto the edge");
    // A "—" whole in the input, ending at 262144, is moved one byte on to
    // straddle that edge, and is padded there.
    const movedAcross = laid("—", 1, [XTERM_PIECE, 2 * XTERM_PIECE - 2], 3 * XTERM_PIECE);
    expect(cutEdges(movedAcross, XTERM_PIECE)).toEqual([XTERM_PIECE]);
    const b = padPieceEdges(movedAcross);
    expect(b.length - movedAcross.length).toBe(1 + 2);
    expectPadded(movedAcross, b, XTERM_PIECE, "moved across the edge");
  });

  it("leaves bytes no character begins alone: a lone continuation, C0, C1, F5..F8 before an edge", () => {
    for (const before of [[0x80, 0x80, 0x80], [0x41, 0xbf, 0xbf], [0xc0, 0x80, 0x80], [0x41, 0xc1, 0x80], [0x41, 0xf5, 0x80], [0x41, 0x41, 0xf8]]) {
      const input = Buffer.alloc(2 * XTERM_PIECE, 0x61);
      Buffer.from(before).copy(input, XTERM_PIECE - 3);
      input[XTERM_PIECE] = 0x80;
      expect(padPieceEdges(input), hexList(before)).toBe(input);
    }
    // Nor stray continuations after a whole character.
    const input = Buffer.alloc(2 * XTERM_PIECE, 0x61);
    Buffer.from([0xc3, 0xa9, 0x80]).copy(input, XTERM_PIECE - 2);
    expect(padPieceEdges(input)).toBe(input);
  });

  it("keeps a lead byte with the continuations it asks for even where they are malformed, as one write of the same bytes does", () => {
    // E0 80 80 is an overlong form; a write that holds all three bytes keeps
    // them together, so an edge must not part them either.
    const input = Buffer.alloc(2 * XTERM_PIECE, 0x61);
    Buffer.from([0xe0, 0x80, 0x80]).copy(input, XTERM_PIECE - 1);
    const out = padPieceEdges(input);
    expect(out.length - input.length).toBe(1);
    expect([...out.subarray(XTERM_PIECE - 1, XTERM_PIECE + 3)]).toEqual([FILLER, 0xe0, 0x80, 0x80]);
  });

  it("takes a Uint8Array as well as a Buffer, and refuses a piece that cannot hold a character and its filler", () => {
    const input = laid("—", 2, [XTERM_PIECE], 2 * XTERM_PIECE);
    const out = padPieceEdges(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
    expect(out.length - input.length).toBe(2);
    expectPadded(input, Buffer.from(out), XTERM_PIECE, "Uint8Array");
    for (const bad of [0, 7, 7.5, -1, Number.NaN, Infinity]) expect(() => padPieceEdges(input, bad), `${bad}`).toThrow(RangeError);
    expect(() => padPieceEdges(Buffer.alloc(9), 8)).not.toThrow();
  });

  it("keeps every edge whole, adds only filler and only where an edge needs it, over random text and small pieces", () => {
    // A seeded LCG: the same bytes every run. Characters of every length,
    // well formed and not, stray continuations and an escape; never 0xFF.
    let seed = 0x2545f491;
    const next = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8);
    const units = [[0x61], [0x0a], [0xc3, 0xa9], [0xe2, 0x80, 0x94], [0xe2, 0x80, 0xa6], [0xe4, 0xb8, 0x96], [0xf0, 0x9f, 0x9a, 0x80],
      [0xf0, 0x90, 0x80, 0x80], [0x80], [0xbf, 0xbf], [0xe0, 0x80, 0x80], [0xc0, 0x80], [0xf5, 0x80], [0xe2, 0x80], [0x1b, 0x5b, 0x6d]];
    let padded = 0;
    for (const piece of [8, 9, 10, 13, 64]) {
      for (let round = 0; round < 300; round++) {
        const bytes: number[] = [];
        const size = piece + 1 + (next() % (piece * 6));
        while (bytes.length < size) bytes.push(...units[next() % units.length]);
        const input = Buffer.from(bytes);
        const out = padPieceEdges(input, piece);
        if (out !== input) padded++;
        expectPadded(input, out, piece, `piece ${piece} round ${round} ${input.toString("hex")}`);
      }
    }
    // The rounds met the cuts they are here for.
    expect(padded).toBeGreaterThan(500);
  });
});
