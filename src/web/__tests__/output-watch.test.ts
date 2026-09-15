// The watch that sees a session working between its tool calls.
//
// The hooks fire at boundaries and nothing fires while the model is producing.
// Measured on this machine's transcripts over six hours: 86 minutes in 648
// thinking blocks, 16.5% of all measured time and more than the time spent
// inside tool calls, with nothing drawn for any of it — so a working card and a
// dead one looked the same. The transcript is where that time is recorded, one
// JSON line per content block as the block completes, each with its own stamp.
//
// These drive the watch against a filesystem that is being written to while it
// reads: a file that grows mid-line, one that is truncated, one that is
// replaced under the same name, one that vanishes, and a multi-byte character
// split across two ticks. None of those are hypothetical — a transcript is
// appended to by another process the whole time this runs.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { blockKindOf, blockTimeOf, blocksIn, createOutputWatch } from "../../server/output-watch.mjs";

const T0 = Date.parse("2026-09-12T19:04:40.038Z");
const iso = (ms: number) => new Date(ms).toISOString();

const rec = (kind: string, at: number) => JSON.stringify({
  type: "assistant",
  timestamp: iso(at),
  message: { content: [{ type: kind }] },
});

/** A fake file the test can grow, shrink and delete under the watch. */
function fakeFs() {
  const files = new Map<string, Buffer>();
  return {
    files,
    put(path: string, text: string) { files.set(path, Buffer.from(text, "utf8")); },
    append(path: string, text: string) {
      files.set(path, Buffer.concat([files.get(path) ?? Buffer.alloc(0), Buffer.from(text, "utf8")]));
    },
    remove(path: string) { files.delete(path); },
    io: {
      async stat(path: string) {
        const b = files.get(path);
        if (!b) throw new Error("ENOENT");
        return { size: b.length };
      },
      async open(path: string) {
        const b = files.get(path);
        if (!b) throw new Error("ENOENT");
        return {
          async read(buf: Buffer, off: number, len: number, pos: number) {
            const slice = b.subarray(pos, pos + len);
            slice.copy(buf, off);
            return { bytesRead: slice.length };
          },
          async close() {},
        };
      },
    },
  };
}

describe("reading one transcript line", () => {
  it("names the block an assistant record carries", () => {
    expect(blockKindOf(rec("thinking", T0))).toBe("thinking");
    expect(blockKindOf(rec("text", T0))).toBe("text");
    expect(blockKindOf(rec("tool_use", T0))).toBe("tool_use");
  });

  it("prefers the reasoning over what the reasoning produced", () => {
    // One record can carry both. The interesting half is that the model was
    // thinking, not the mechanical call that came out of it.
    const both = JSON.stringify({
      type: "assistant", timestamp: iso(T0),
      message: { content: [{ type: "thinking" }, { type: "tool_use" }] },
    });
    expect(blockKindOf(both)).toBe("thinking");
  });

  it("says nothing for a tool answering, which is not the model producing", () => {
    const result = JSON.stringify({
      type: "user", timestamp: iso(T0),
      message: { content: [{ type: "tool_result" }] },
    });
    expect(blockKindOf(result)).toBeNull();
  });

  it("says nothing rather than throwing on a line that is still being written", () => {
    // The ordinary case, not an error: the file is appended to while this reads.
    expect(blockKindOf('{"type":"assistant","messa')).toBeNull();
    expect(blockKindOf("")).toBeNull();
    expect(blockKindOf("null")).toBeNull();
    expect(blockKindOf('{"type":"assistant"}')).toBeNull();
  });

  it("dates a block by its own stamp and never by the clock here", () => {
    // The deck may be reading a block that landed while it was busy. Dating it
    // `now` would report old work as having just happened.
    expect(blockTimeOf(rec("thinking", T0))).toBe(T0);
    expect(blockTimeOf('{"type":"assistant","timestamp":"not a date"}')).toBeNull();
    expect(blockTimeOf("{")).toBeNull();
  });

  it("takes EVERY block out of a chunk, oldest first", () => {
    // Not the newest. Consecutive blocks land 1.4s and 2.7s apart on this
    // machine, so a thinking block and the tool call it produced arrive inside
    // one 1500ms tick more often than not — and keeping only the last meant the
    // canvas saw `tool_use` forever and `thinking` never, which is the one
    // thing this watch exists to show.
    const chunk = [rec("thinking", T0), rec("text", T0 + 1000), rec("tool_use", T0 + 3000)].join("\n");
    expect(blocksIn(chunk)).toEqual([
      { kind: "thinking", at: T0 },
      { kind: "text", at: T0 + 1000 },
      { kind: "tool_use", at: T0 + 3000 },
    ]);
  });

  it("finds nothing in a chunk that carries no production", () => {
    expect(blocksIn('{"type":"user"}\n{"type":"user"}')).toEqual([]);
    expect(blocksIn("")).toEqual([]);
  });
});

describe("the watch across ticks", () => {
  it("reports nothing the first time it sees a file", async () => {
    // Everything already in it happened before the deck looked. Replaying it
    // would report a morning's thinking as having just occurred.
    const fs = fakeFs();
    fs.put("/t.jsonl", rec("thinking", T0) + "\n");
    const w = createOutputWatch(fs.io);
    w.note("s1", "/t.jsonl");
    expect(await w.poll(["s1"])).toEqual([]);
  });

  it("reports the block that lands after that", async () => {
    const fs = fakeFs();
    fs.put("/t.jsonl", rec("text", T0) + "\n");
    const w = createOutputWatch(fs.io);
    w.note("s1", "/t.jsonl");
    await w.poll(["s1"]);
    fs.append("/t.jsonl", rec("thinking", T0 + 2000) + "\n");
    expect(await w.poll(["s1"])).toEqual([{ sid: "s1", kind: "thinking", at: T0 + 2000 }]);
  });

  it("reports every block a single tick picked up, oldest first", async () => {
    // The regression this file was written after: blocks land 1.4s and 2.7s
    // apart and the poll runs at 1500ms, so a thinking block and the tool call
    // it produced arrive together more often than not. Keeping only the newest
    // showed `tool_use` forever and `thinking` never — confirmed on the live
    // deck before it was fixed — and marked one unit of work where three
    // happened.
    const fs = fakeFs();
    fs.put("/t.jsonl", rec("text", T0) + "\n");
    const w = createOutputWatch(fs.io);
    w.note("s1", "/t.jsonl");
    await w.poll(["s1"]);
    fs.append("/t.jsonl",
      rec("thinking", T0 + 1000) + "\n" + rec("text", T0 + 2400) + "\n" + rec("tool_use", T0 + 5100) + "\n");
    expect(await w.poll(["s1"])).toEqual([
      { sid: "s1", kind: "thinking", at: T0 + 1000 },
      { sid: "s1", kind: "text", at: T0 + 2400 },
      { sid: "s1", kind: "tool_use", at: T0 + 5100 },
    ]);
  });

  it("stays quiet on a tick where nothing was written", async () => {
    const fs = fakeFs();
    fs.put("/t.jsonl", rec("text", T0) + "\n");
    const w = createOutputWatch(fs.io);
    w.note("s1", "/t.jsonl");
    await w.poll(["s1"]);
    expect(await w.poll(["s1"])).toEqual([]);
    expect(await w.poll(["s1"])).toEqual([]);
  });

  it("reads only what is new, never the file again", async () => {
    // The question each tick asks is one bit. These files run to megabytes.
    const fs = fakeFs();
    fs.put("/t.jsonl", rec("text", T0) + "\n");
    let opened = 0;
    const io = { ...fs.io, open: async (p: string) => { opened++; return fs.io.open(p); } };
    const w = createOutputWatch(io);
    w.note("s1", "/t.jsonl");
    await w.poll(["s1"]);
    expect(opened, "a first sight is a stat and nothing more").toBe(0);
    await w.poll(["s1"]);
    expect(opened, "a file that did not move is not opened").toBe(0);
    fs.append("/t.jsonl", rec("thinking", T0 + 1000) + "\n");
    await w.poll(["s1"]);
    expect(opened).toBe(1);
  });

  it("waits for a line that arrives in two pieces rather than dropping it", async () => {
    const fs = fakeFs();
    fs.put("/t.jsonl", rec("text", T0) + "\n");
    const w = createOutputWatch(fs.io);
    w.note("s1", "/t.jsonl");
    await w.poll(["s1"]);
    const whole = rec("thinking", T0 + 5000);
    fs.append("/t.jsonl", whole.slice(0, 20));
    expect(await w.poll(["s1"]), "half a line says nothing").toEqual([]);
    fs.append("/t.jsonl", whole.slice(20) + "\n");
    expect(await w.poll(["s1"]), "and the whole of it is read once it lands")
      .toEqual([{ sid: "s1", kind: "thinking", at: T0 + 5000 }]);
  });

  it("keeps a multi-byte character whole across the seam", async () => {
    const fs = fakeFs();
    fs.put("/t.jsonl", rec("text", T0) + "\n");
    const w = createOutputWatch(fs.io);
    w.note("s1", "/t.jsonl");
    await w.poll(["s1"]);
    const line = JSON.stringify({
      type: "assistant", timestamp: iso(T0 + 1000),
      message: { content: [{ type: "thinking", thinking: "măsurători — ✓ 日本語" }] },
    });
    const bytes = Buffer.from(line + "\n", "utf8");
    // Split inside a multi-byte sequence on purpose.
    const cut = 40;
    fs.files.set("/t.jsonl", Buffer.concat([
      Buffer.from(rec("text", T0) + "\n", "utf8"), bytes.subarray(0, cut),
    ]));
    await w.poll(["s1"]);
    fs.files.set("/t.jsonl", Buffer.concat([
      Buffer.from(rec("text", T0) + "\n", "utf8"), bytes,
    ]));
    expect(await w.poll(["s1"])).toEqual([{ sid: "s1", kind: "thinking", at: T0 + 1000 }]);
  });

  it("starts again at the end when the file is truncated under it", async () => {
    // Seeking to the old offset in a shorter file returns whatever now lives
    // at that byte, which is not the record that was there.
    const fs = fakeFs();
    fs.put("/t.jsonl", rec("text", T0) + "\n" + rec("text", T0 + 1) + "\n");
    const w = createOutputWatch(fs.io);
    w.note("s1", "/t.jsonl");
    await w.poll(["s1"]);
    fs.put("/t.jsonl", "");
    expect(await w.poll(["s1"])).toEqual([]);
    fs.append("/t.jsonl", rec("thinking", T0 + 9000) + "\n");
    expect(await w.poll(["s1"])).toEqual([{ sid: "s1", kind: "thinking", at: T0 + 9000 }]);
  });

  it("skips to the end rather than reading a file that jumped", async () => {
    const fs = fakeFs();
    fs.put("/t.jsonl", rec("text", T0) + "\n");
    const w = createOutputWatch(fs.io);
    w.note("s1", "/t.jsonl");
    await w.poll(["s1"]);
    // Bigger than MAX_TAIL_BYTES: a session that was quiet while the deck was
    // not watching. The next block to land is seen normally.
    fs.append("/t.jsonl", "x".repeat(300 * 1024) + "\n");
    expect(await w.poll(["s1"])).toEqual([]);
    fs.append("/t.jsonl", rec("thinking", T0 + 2000) + "\n");
    expect(await w.poll(["s1"])).toEqual([{ sid: "s1", kind: "thinking", at: T0 + 2000 }]);
  });

  it("says nothing about a file that has gone", async () => {
    const fs = fakeFs();
    fs.put("/t.jsonl", rec("text", T0) + "\n");
    const w = createOutputWatch(fs.io);
    w.note("s1", "/t.jsonl");
    await w.poll(["s1"]);
    fs.remove("/t.jsonl");
    expect(await w.poll(["s1"])).toEqual([]);
  });

  it("looks at the sessions it is given and at no others", async () => {
    const fs = fakeFs();
    fs.put("/a.jsonl", rec("text", T0) + "\n");
    fs.put("/b.jsonl", rec("text", T0) + "\n");
    const w = createOutputWatch(fs.io);
    w.note("a", "/a.jsonl");
    w.note("b", "/b.jsonl");
    await w.poll(["a", "b"]);
    fs.append("/a.jsonl", rec("thinking", T0 + 1000) + "\n");
    fs.append("/b.jsonl", rec("thinking", T0 + 1000) + "\n");
    expect(await w.poll(["a"])).toEqual([{ sid: "a", kind: "thinking", at: T0 + 1000 }]);
    // b moved too, and is reported only once somebody asks about b.
    expect(await w.poll(["b"])).toEqual([{ sid: "b", kind: "thinking", at: T0 + 1000 }]);
  });

  it("follows a session whose transcript path changes", async () => {
    const fs = fakeFs();
    fs.put("/old.jsonl", rec("text", T0) + "\n");
    fs.put("/new.jsonl", rec("text", T0) + "\n");
    const w = createOutputWatch(fs.io);
    w.note("s1", "/old.jsonl");
    await w.poll(["s1"]);
    w.note("s1", "/new.jsonl");
    expect(await w.poll(["s1"]), "a file it has not seen starts at that file's end").toEqual([]);
    fs.append("/new.jsonl", rec("thinking", T0 + 1000) + "\n");
    expect(await w.poll(["s1"])).toEqual([{ sid: "s1", kind: "thinking", at: T0 + 1000 }]);
  });

  it("forgets a session on request, and holds nothing after a clear", async () => {
    const fs = fakeFs();
    fs.put("/t.jsonl", rec("text", T0) + "\n");
    const w = createOutputWatch(fs.io);
    w.note("s1", "/t.jsonl");
    expect(w.size()).toBe(1);
    w.forget("s1");
    expect(w.size()).toBe(0);
    expect(await w.poll(["s1"])).toEqual([]);
    w.note("s2", "/t.jsonl");
    w.clear();
    expect(w.size()).toBe(0);
  });

  it("ignores a note with nothing in it", () => {
    const w = createOutputWatch(fakeFs().io);
    w.note("", "/t.jsonl");
    w.note("s1", "");
    expect(w.size()).toBe(0);
  });
});

describe("a tick that starts before the last one finished (#1089)", () => {
  /** The fake file system, with its FIRST read held until the test lets it go
   *  and a signal the moment it is being held. That is the exact interleave the
   *  issue measured: the first tick has taken its offset and not yet written
   *  the new one back. Timed ticks would only find it on a slow enough disk. */
  function heldFirstRead() {
    const fs = fakeFs();
    let letGo!: () => void;
    const held = new Promise<void>(r => { letGo = r; });
    let entered!: () => void;
    const inside = new Promise<void>(r => { entered = r; });
    let reads = 0;
    const io = {
      stat: fs.io.stat,
      async open(path: string) {
        const h = await fs.io.open(path);
        return {
          async read(buf: Buffer, off: number, len: number, pos: number) {
            if (reads++ === 0) { entered(); await held; }
            return h.read(buf, off, len, pos);
          },
          close: h.close,
        };
      },
    };
    return { fs, io, inside, letGo };
  }

  it("reports the block once, not once per tick", async () => {
    const { fs, io, inside, letGo } = heldFirstRead();
    fs.put("/t.jsonl", "");
    const w = createOutputWatch(io);
    w.note("s1", "/t.jsonl");
    await w.poll(["s1"]);                                  // first sight: the end
    fs.append("/t.jsonl", rec("text", T0) + "\n");

    const first = w.poll(["s1"]);
    await inside;
    const second = await w.poll(["s1"]);
    letGo();
    const reported = [...(await first), ...second];
    // Two here is two OutputObserved for one block, persisted, and drawn onto
    // the activity chart again after every restart.
    expect(reported).toEqual([{ sid: "s1", kind: "text", at: T0 }]);
  });

  it("lets the next tick in once the first is done, and loses nothing that landed meanwhile", async () => {
    const { fs, io, inside, letGo } = heldFirstRead();
    fs.put("/t.jsonl", "");
    const w = createOutputWatch(io);
    w.note("s1", "/t.jsonl");
    await w.poll(["s1"]);
    fs.append("/t.jsonl", rec("text", T0) + "\n");

    const first = w.poll(["s1"]);
    await inside;
    // Lands while the first tick is still reading, past the size it stat'ed.
    fs.append("/t.jsonl", rec("thinking", T0 + 1000) + "\n");
    expect(await w.poll(["s1"])).toEqual([]);
    letGo();
    expect(await first).toEqual([{ sid: "s1", kind: "text", at: T0 }]);
    expect(await w.poll(["s1"])).toEqual([{ sid: "s1", kind: "thinking", at: T0 + 1000 }]);
  });
});

describe("what the watch remembers about a file (#1089)", () => {
  it("keeps no size of its own, because every decision is made from the stat it just took", () => {
    // An absence, so it can only be read off the source. `entry.size` was
    // written on four paths through a tick and read on none: every truncation
    // and ceiling test compares the size `stat` just returned against the
    // offset, and the map never leaves the closure, so nothing outside could
    // have been reading it either. A field like that invites the next change to
    // trust it, and it was never kept in step with anything.
    const src = readFileSync(new URL("../../server/output-watch.mjs", import.meta.url), "utf8");
    expect(src).not.toMatch(/entry\.size\b/);
    expect(src).not.toMatch(/size:\s*null/);
  });
});
