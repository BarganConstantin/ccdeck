// utf8-carry.mjs on its own: which bytes at a frame's end begin a character
// more bytes could still finish, and the carry that holds them for the next
// frame of the stream. terminal-bridge-utf8.test.ts plays the same rule
// through the relay; this file pins the rule itself, byte by byte, against
// the well-formed UTF-8 table (Unicode, Table 3-7).
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { unfinishedTail, utf8Carry } from "../../server/utf8-carry.mjs";

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
