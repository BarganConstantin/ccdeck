// Reading the event log from its end, and the boot that stops paying for its
// beginning (#742).
//
// The replay runs before the port opens and used to parse the whole log from
// the front — 12,079 lines and 31 MB on the machine this was measured on,
// 690ms of JSON.parse, growing with every session until rotation cuts it at
// 50 MB — to fill a ring that holds MAX_BUFFER = 2000 events. Roughly five
// sixths of that work fed the eviction loop.
//
// Two claims, and this file is split along them:
//
//   1. `linesFromEnd` yields exactly what `readline` yields, reversed. That is
//      asserted against readline itself rather than against a hand-written
//      expectation, because the whole risk of reading a file backwards is the
//      edge you did not think of — a chunk boundary inside a three-byte
//      character, a file that does not end in a newline, one that begins with
//      one, one whose single line is longer than a chunk.
//
//   2. The replay stops as soon as the ring is full, and what ends up in the
//      ring is what a forward replay left there. The observable for "stopped"
//      is damage: unparseable lines are put in the OLD end of a log longer than
//      the ring, and a reader that reached them would have counted them.
import { describe, it, expect, afterAll } from "vitest";
import { createReadStream, mkdtempSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-expect-error — a plain .mjs module, no types
const { linesFromEnd, CHUNK_BYTES } = await import("../../server/log-tail.mjs");

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-log-tail-"));
afterAll(() => { rmTempDir(DIR); });

let n = 0;
function fileWith(body: string): string {
  const f = join(DIR, `f${n++}.log`);
  writeFileSync(f, body);
  return f;
}

/** What `readline` makes of the same file, which is the definition this is
 *  held to — the replay it replaced used exactly this. */
async function forwards(file: string): Promise<string[]> {
  const out: string[] = [];
  for await (const line of createInterface({ input: createReadStream(file) })) out.push(line);
  return out;
}

async function backwards(file: string, chunkBytes?: number): Promise<string[]> {
  const out: string[] = [];
  for await (const line of linesFromEnd(file, chunkBytes ? { chunkBytes } : {})) out.push(line);
  return out;
}

describe("linesFromEnd is readline, reversed", () => {
  // Every chunk size from "smaller than one character" up. One byte is not a
  // realistic setting; it is the setting under which every boundary bug that
  // exists happens on every line.
  const CHUNKS = [1, 2, 3, 5, 8, 64, 4096, CHUNK_BYTES];

  const CASES: Array<[string, string]> = [
    ["three lines, trailing newline", "a\nb\nc\n"],
    ["three lines, no trailing newline", "a\nb\nc"],
    ["an empty file", ""],
    ["one newline and nothing else", "\n"],
    ["a file that opens with a blank line", "\na\n"],
    ["a blank line in the middle", "a\n\nb\n"],
    ["one line, no newline at all", "solo"],
    // 0x0A cannot occur inside a UTF-8 multi-byte sequence, which is why lines
    // are cut as bytes and decoded one at a time. Decoding the chunk first and
    // splitting the string is the obvious way to write this and is wrong.
    ["multi-byte characters", "日本語テキスト\nЯндекс Музыка\n🙂🙂🙂\n"],
    ["a line longer than any chunk", `${"x".repeat(5000)}\n${"y".repeat(3000)}\n`],
    // The deck writes \n, but a log that has been through a Windows editor has
    // not. readline strips the carriage return; so does this.
    ["CRLF", "a\r\nb\r\nc\r\n"],
    ["CRLF without a final newline", "a\r\nb"],
    ["JSON lines, which is what this is actually for",
      `{"seq":1,"payload":{"cwd":"/a"}}\n{"seq":2,"payload":{"cwd":"/b"}}\n`],
  ];

  for (const [what, body] of CASES) {
    it(`agrees with readline on ${what}`, async () => {
      const f = fileWith(body);
      const expected = [...await forwards(f)].reverse();
      for (const chunk of CHUNKS) {
        expect(await backwards(f, chunk), `chunk size ${chunk}`).toEqual(expected);
      }
    });
  }

  it("does not treat a lone carriage return as a line break, and says so", async () => {
    // The one place this deliberately differs from readline. Walking those
    // backwards means scanning every byte rather than asking Buffer for the
    // next 0x0A, and nothing has written a Mac-classic line ending into this
    // log since 2001. The consequence is bounded and legible: one very long
    // line that JSON.parse declines, counted and reported as unreadable.
    const f = fileWith("a\rb\rc");
    expect(await backwards(f, 4)).toEqual(["a\rb\rc"]);
    expect(await forwards(f)).toEqual(["a", "b", "c"]);
  });
});

describe("linesFromEnd stops when the caller does", () => {
  it("reads only as far back as it is asked to", async () => {
    // The property the whole change rests on. A `break` in the consumer has to
    // end the read, not merely end the loop — an async generator that had
    // already buffered the file would give the right answer and none of the
    // speed.
    const lines = Array.from({ length: 20_000 }, (_, i) => `line-${i}`);
    const f = fileWith(lines.join("\n") + "\n");

    const seen: string[] = [];
    for await (const line of linesFromEnd(f, { chunkBytes: 512 })) {
      seen.push(line as string);
      if (seen.length === 3) break;
    }
    expect(seen).toEqual(["line-19999", "line-19998", "line-19997"]);
  });

  it("closes the file it opened, however the loop ended", async () => {
    // A generator abandoned mid-read runs its `finally`, and a boot that leaked
    // a descriptor per replay would be a slow leak nobody would connect to
    // this. Counted through the handle the module is given.
    let opened = 0;
    let closed = 0;
    const realOpen = (await import("node:fs/promises")).open;
    const openFile = async (p: string, flags: string) => {
      opened++;
      const fh = await realOpen(p, flags);
      return {
        stat: () => fh.stat(),
        read: (...a: unknown[]) => (fh.read as any)(...a),
        close: async () => { closed++; return fh.close(); },
      };
    };

    const f = fileWith(Array.from({ length: 500 }, (_, i) => `n${i}`).join("\n") + "\n");
    for await (const line of linesFromEnd(f, { chunkBytes: 64, openFile })) {
      if (String(line).endsWith("495")) break;
    }
    expect([opened, closed]).toEqual([1, 1]);

    // And on the ordinary path, where the loop runs out rather than breaking.
    for await (const _ of linesFromEnd(f, { chunkBytes: 64, openFile })) { /* all of it */ }
    expect([opened, closed]).toEqual([2, 2]);
  });
});
