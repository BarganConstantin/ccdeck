// The relay sends the panel whole characters, however tmux cut them.
//
// tmux control mode reports a pane's output as `%output` lines, and a line
// can end inside a UTF-8 character: tmux cuts where its read of the pane
// ended. The relay (terminal-bridge.mjs) sends each line as one binary frame,
// and the panel writes each frame to xterm.js on its own. xterm.js joins a
// character cut across two writes, except right after a 0x80 continuation
// byte — so "—" cut as E2 80 | 94 never appears, and neither do "…", "’",
// "”" or a four-byte character cut after an 80. Measured on tmux 3.8: a few
// percent of the lines of punctuation-heavy output end inside a character.
//
// So the relay holds back the bytes at the end of a frame that begin a
// character the frame does not finish — at most three — and sends them in
// front of the next frame of the same stream. Everything here is played
// through terminalBridge itself, with a stand-in tmux client whose output the
// test controls, and judged only on what the panel receives:
//
//   - the frames, concatenated, are the pane's bytes, in order, unchanged —
//     less an unfinished character still held when its stream broke off;
//   - every frame ends on a character boundary, unless the bytes there can
//     never finish one (malformed input), which goes out as it is, at once;
//   - never more than three bytes held, and never an empty frame;
//   - written one frame per write to xterm.js, they draw what the whole input
//     written at once draws. These comparisons need @xterm/headless (not a
//     dependency of the deck; CCDECK_TEST_XTERM or this checkout), and
//     without it the byte checks above are what runs — no skip gate, as in
//     tmux-control-tmux.test.ts.
//
// The stream breaks — a %pause, a seed, output let go behind a congested
// socket or past the ack window, the end, a new socket — each say what
// happens to a character that was half sent when they came.
// terminal-utf8-tmux.test.ts does the same on a real tmux.
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
// @ts-expect-error — plain .mjs server module, no types
import * as tb from "../../server/terminal-bridge.mjs";
// @ts-expect-error — plain .mjs test kit, no types
import * as kit from "./utf8-frames-kit.mjs";

const X = kit.headlessXterm();
const { hex, toHex } = kit;
const bytes = (s: string) => Buffer.from(s, "utf8");
const total = (frames: Buffer[]) => frames.reduce((n, f) => n + f.length, 0);

/** `frames` played through a fresh relay after its first seed. */
async function play(frames: Buffer[]) {
  const r = await kit.openRelay(tb.terminalBridge);
  const from = r.mark();
  // What the relay had not sent after each frame: never more than three.
  let fed = 0;
  let sent = 0;
  let seen = from;
  let heldMost = 0;
  for (const f of frames) {
    r.control().emit("output", Buffer.from(f));
    fed += f.length;
    for (; seen < r.conn.sent.length; seen++) if (r.conn.sent[seen].type === "binary") sent += r.conn.sent[seen].data.length;
    heldMost = Math.max(heldMost, fed - sent);
  }
  return { out: r.conn.binaries(from) as Buffer[], heldMost, relay: r, from };
}

/** The checks every stream of valid UTF-8 must pass, cut however it was cut. */
async function expectWholeCharacters(input: Buffer, frames: Buffer[], label: string) {
  const { out, heldMost } = await play(frames);
  expect(Buffer.concat(out).equals(input), `${label}: the bytes, in order, unchanged`).toBe(true);
  expect(kit.framesNotOnBoundary(out), `${label}: frames that end inside a character`).toBe(0);
  expect(out.filter(f => f.length === 0), `${label}: empty frames`).toEqual([]);
  expect(heldMost, `${label}: bytes held at once`).toBeLessThanOrEqual(3);
  if (X) {
    for (const graphemes of [false, true]) {
      const shown = await kit.screenOf(X, out, { graphemes });
      const whole = await kit.screenOf(X, [input], { graphemes });
      expect(shown, `${label}: the screen${graphemes ? " (graphemes addon)" : ""}`).toBe(whole);
    }
  }
  return out;
}

const CHARACTERS: [string, string][] = [
  ["em dash", "—"], ["ellipsis", "…"], ["right single quote", "’"], ["right double quote", "”"],
  ["e acute", "é"], ["euro", "€"], ["CJK", "世"], ["e and a combining acute", "é"],
  ["rocket (F0 9F 9A 80)", "🚀"], ["mahjong tile (F0 9F 80 80)", "🀀"], ["ASCII", "x"],
];

describe("whole characters on the wire, however tmux cut the line", () => {
  it("a character cut at every byte offset arrives whole: —, …, ’, ”, é, €, 世, a combining mark, 4-byte characters, ASCII", async () => {
    for (const [name, ch] of CHARACTERS) {
      const input = bytes(`A${ch}B`);
      for (let k = 1; k < input.length; k++) {
        await expectWholeCharacters(input, [input.subarray(0, k), input.subarray(k)], `${name} cut at ${k}`);
      }
    }
  });

  it("the same, cut at every pair of offsets into three frames", async () => {
    for (const [name, ch] of CHARACTERS) {
      const input = bytes(`${ch}${ch}`);
      for (let i = 1; i < input.length; i++) {
        for (let j = i + 1; j < input.length; j++) {
          await expectWholeCharacters(input, [input.subarray(0, i), input.subarray(i, j), input.subarray(j)], `${name}x2 cut at ${i},${j}`);
        }
      }
    }
  });

  it("one byte per frame: each character goes out as one frame once its last byte is in, and a lead byte alone sends nothing", async () => {
    const text = "a—b…c’d”e é€世🚀🀀 é x\r\n";
    const input = bytes(text);
    const out = await expectWholeCharacters(input, [...input].map(b => Buffer.from([b])), "bytewise");
    expect(out.map(toHex)).toEqual([...text].map(c => toHex(bytes(c))));
  });

  it("the contract's vectors: the frames the panel gets, and what is held when the input runs out", async () => {
    // [name, frames out]; held is 0 except where the input ends inside a character.
    const expected: Record<string, string[]> = {
      "ascii": ["41 42 43", "44"],
      "emdash-whole": ["41 E2 80 94 42"],
      "emdash-cut-1": ["41", "E2 80 94 42"],
      "emdash-cut-2": ["41", "E2 80 94 42"],
      "ellipsis-cut-2": ["41", "E2 80 A6 42"],
      "rsquo-cut-2": ["E2 80 99"],
      "rdquo-cut-2": ["E2 80 9D 20 41"],
      "emdash-bytewise": ["E2 80 94"],
      "combining-cut-in-mark": ["65", "CC 81 42"],
      "combining-cut-before-mark": ["65", "CC 81"],
      "rocket-bytewise": ["F0 9F 9A 80"],
      "mahjong-cut-3": ["F0 9F 80 80 41"],
      "mahjong-cut-2": ["F0 9F 80 80 41"],
      "mixed-bytewise": ["61", "E2 80 94", "62", "E2 80 A6", "63", "E2 80 99", "64", "E2 80 9D", "65"],
      "cjk-cut": ["E4 B8 96"],
      "euro-cut": ["E2 82 AC"],
      "sgr-around": ["1B 5B 33 31 6D", "E2 80 94 1B 5B 30 6D"],
      "bad-lone-cont": ["41 80 42"],
      "bad-trunc-then-ascii": ["41", "E2 80 41"],
      "bad-overlong": ["C0 80 41"],
      "bad-f5": ["F5 80 80 80 41"],
      "bad-surrogate": ["ED A0", "80 41"],
      "bad-e0-low": ["E0 80", "80 41"],
      "end-incomplete": ["41"],
    };
    expect(kit.VECTORS.map((v: any[]) => v[0]).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, frames, opts] of kit.VECTORS) {
      const input = frames.map(hex);
      const r = await kit.playVector(tb.terminalBridge, input, opts ?? {});
      expect(r.framesOut.map(toHex), name).toEqual(expected[name]);
      expect(r.held, `${name}: held when the input ran out`).toBe(name === "end-incomplete" ? 2 : 0);
      if (opts?.end) {
        expect(r.lost, `${name}: the unfinished character goes with its stream`).toBe(2);
        expect(r.after.at(-1)).toBe("exit");
      }
      if (X) {
        const shown = await kit.screenOf(X, r.framesOut);
        expect(shown, `${name}: the screen`).toBe(await kit.screenOf(X, [Buffer.concat(input)]));
      }
    }
  });

  it("punctuation-heavy text cut by a seeded generator: the contract's heavy vector and three more seeds", async () => {
    const runs = [
      { seed: 42, repeat: 3000, max: 2048 },
      { seed: 7, repeat: 400, max: 16 },
      { seed: 1234, repeat: 400, max: 5 },
      { seed: 99_999, repeat: 400, max: 300 },
    ];
    for (const run of runs) {
      const frames: Buffer[] = kit.heavyFrames(run);
      const input = Buffer.concat(frames);
      expect(kit.framesNotOnBoundary(frames), `seed ${run.seed}: the input really is cut inside characters`).toBeGreaterThan(0);
      const { out, heldMost } = await play(frames);
      expect(Buffer.concat(out).equals(input), `seed ${run.seed}: the bytes`).toBe(true);
      expect(kit.framesNotOnBoundary(out), `seed ${run.seed}: frames that end inside a character`).toBe(0);
      expect(out.filter(f => f.length === 0)).toEqual([]);
      expect(heldMost).toBeLessThanOrEqual(3);
      if (X) {
        // Every line, scrollback included: a character lost anywhere shows.
        const opts = { scrollback: run.repeat + 100 };
        expect(await kit.screenOf(X, out, opts), `seed ${run.seed}: the screen`).toBe(await kit.screenOf(X, [input], opts));
      }
    }
  });
});

describe("bytes that can never finish a character go out as they are, at once", () => {
  it("lone continuations, truncated leads, overlongs, F5..FF, surrogates, out-of-range: unchanged, and held only while they could still finish", async () => {
    const cases: [string, string[], string[]][] = [
      ["a lone continuation", ["41 80 42"], ["41 80 42"]],
      ["a lone continuation at a frame's end", ["41 80", "42"], ["41 80", "42"]],
      ["three continuations after a whole character", ["E2 80 94 80 80 80", "41"], ["E2 80 94 80 80 80", "41"]],
      ["a truncated lead, then ASCII", ["41 E2 80", "41"], ["41", "E2 80 41"]],
      ["a truncated lead, then a whole character", ["E2", "E2 80 94"], ["E2 E2 80 94"]],
      ["a truncated lead inside a frame", ["E2 E2 80", "94"], ["E2", "E2 80 94"]],
      ["a truncated four-byte lead, then ASCII", ["F0 9F 9A", "41"], ["F0 9F 9A 41"]],
      ["an overlong C0 80", ["C0 80 41"], ["C0 80 41"]],
      ["C0 at a frame's end", ["C0", "80 41"], ["C0", "80 41"]],
      ["C1 at a frame's end", ["C1", "BF"], ["C1", "BF"]],
      ["F5 and its continuations", ["F5 80 80 80 41"], ["F5 80 80 80 41"]],
      ["F5 at a frame's end", ["F5", "80"], ["F5", "80"]],
      ["FF", ["FF", "41"], ["FF", "41"]],
      ["a surrogate ED A0 80, cut", ["ED A0", "80 41"], ["ED A0", "80 41"]],
      ["ED, then a byte that makes it a surrogate", ["ED", "A0 80"], ["ED A0 80"]],
      ["an overlong E0 80 80, cut", ["E0 80", "80 41"], ["E0 80", "80 41"]],
      ["E0, then a byte that makes it overlong", ["E0", "80"], ["E0 80"]],
      ["an overlong F0 80 80 80, cut", ["F0 80", "80 80"], ["F0 80", "80 80"]],
      ["past U+10FFFF: F4 90, cut", ["F4 90", "80 80"], ["F4 90", "80 80"]],
    ];
    for (const [name, frames, want] of cases) {
      const input = frames.map(hex);
      const { out } = await play(input);
      expect(out.map(toHex), name).toEqual(want);
      expect(Buffer.concat(out).equals(Buffer.concat(input)), `${name}: unchanged`).toBe(true);
    }
  });

  it("every byte value alone in a frame: held only if it can begin a character (C2..F4), else sent at once", async () => {
    for (let b = 0; b < 256; b++) {
      const { out } = await play([Buffer.from([b]), hex("41")]);
      const canBegin = b >= 0xc2 && b <= 0xf4;
      const label = `byte ${toHex([b])}`;
      expect(out.map(toHex), label).toEqual(canBegin ? [`${toHex([b])} 41`] : [toHex([b]), "41"]);
    }
  });
});

describe("a character half sent when the stream breaks", () => {
  /** Every frame after `from` as the panel sees it: text by its `t`, binary as hex. */
  const wire = (conn: any, from: number) => conn.sent.slice(from).map((s: any) => (s.type === "text" ? s.msg.t : toHex(s.data)));
  const RIS = "1B 63";
  const resets = (conn: any) => conn.sent.filter((s: any) => s.type === "text" && s.msg.t === "reset").length;

  it("a %pause: the reseed's reset and seed go out with nothing of the old stream before or after them", async () => {
    const { relay, from } = await play([hex("41 E2 80")]);
    relay.control().emit("reseed");
    await kit.settleUntil(() => resets(relay.conn) === 2);
    relay.control().emit("output", hex("94 42"));
    // The new stream starts where the new capture ended; the 94 that would
    // have finished the old character is the new stream's own byte, and goes
    // out as it came (a seed that cut a write is out of this file's scope).
    expect(wire(relay.conn, from)).toEqual(["41", "reset", RIS, "94 42"]);
  });

  it("a seed whose last bytes begin a character: the seed goes out without them, and the next frame finishes it", async () => {
    // tmux-control appends the output that arrived just past a capture's
    // boundary to the seed, so a seed can end inside a character too.
    const r = await kit.openRelay(tb.terminalBridge);
    r.control().seedBytes = (n: number) => (n === 2 ? hex("1B 63 41 E2 80") : hex(RIS));
    const from = r.mark();
    r.control().emit("reseed");
    await kit.settleUntil(() => resets(r.conn) === 2);
    r.control().emit("output", hex("94 42"));
    expect(wire(r.conn, from)).toEqual(["reset", "1B 63 41", "E2 80 94 42"]);
    if (X) expect(await kit.screenOf(X, r.conn.binaries(from))).toBe(await kit.screenOf(X, [hex("1B 63 41 E2 80 94 42")]));
  });

  it("another reseed while a seed's unfinished character is held: it goes with that seed's stream", async () => {
    const r = await kit.openRelay(tb.terminalBridge);
    r.control().seedBytes = (n: number) => (n === 2 ? hex("1B 63 E2 80") : hex(RIS));
    const from = r.mark();
    r.control().emit("reseed");
    await kit.settleUntil(() => resets(r.conn) === 2);
    r.control().emit("reseed");
    await kit.settleUntil(() => resets(r.conn) === 3);
    r.control().emit("output", hex("94 42"));
    expect(wire(r.conn, from)).toEqual(["reset", RIS, "reset", RIS, "94 42"]);
  });

  it("a seed that went stale while it was captured is never sent, nor anything it began", async () => {
    const r = await kit.openRelay(tb.terminalBridge);
    r.control().seedBytes = (n: number) => (n === 2 ? hex("1B 63 41 E2 80") : hex(RIS));
    r.control().duringSeed = (n: number) => { if (n === 2) r.control().emit("reseed"); };
    const from = r.mark();
    r.control().emit("reseed");
    await kit.settleUntil(() => r.control().seeds === 3 && resets(r.conn) === 2);
    r.control().emit("output", hex("94 42"));
    expect(wire(r.conn, from)).toEqual(["reset", RIS, "94 42"]);
  });

  it("a socket that falls behind: the output is let go, the pending character with it, and the reseed's stream starts clean", async () => {
    const { relay, from } = await play([hex("41 E2 80")]);
    relay.conn.bufferedAmount = tb.HIGH_WATER_BYTES + 1;
    relay.control().emit("output", hex("94 42"));
    relay.control().emit("output", hex("43 E2"));
    relay.conn.bufferedAmount = 0;
    relay.socket.emit("drain");
    await kit.settleUntil(() => resets(relay.conn) === 2);
    relay.control().emit("output", hex("44"));
    expect(wire(relay.conn, from)).toEqual(["41", "reset", RIS, "44"]);
  });

  it("output let go past the ack window: the same, and the window counts the bytes on the wire, not the ones held", async () => {
    const r = await kit.openRelay(tb.terminalBridge, { ackWindow: 3 });
    const from = r.mark();
    const seedBytes = total(r.conn.binaries());
    r.text({ t: "ack", bytes: seedBytes });
    r.control().emit("output", hex("E2 80")); // held: nothing on the wire, nothing in flight
    r.control().emit("output", hex("94")); // E2 80 94 goes out: 3 in flight, not over the window
    expect(wire(r.conn, from)).toEqual(["E2 80 94"]);
    r.control().emit("output", hex("41 E2 80")); // 3 in flight, not over: 41 goes, E2 80 held
    r.control().emit("output", hex("94")); // 4 in flight: over the window, let go, and E2 80 with it
    r.control().emit("output", hex("42"));
    expect(wire(r.conn, from)).toEqual(["E2 80 94", "41"]);
    // The panel says it parsed exactly what was on the wire: believed, the
    // stream is caught up, and a seed is asked for.
    r.text({ t: "ack", bytes: seedBytes + 4 });
    await kit.settleUntil(() => resets(r.conn) === 2);
    expect(r.control().seeds).toBe(2);
    r.control().emit("output", hex("43"));
    expect(wire(r.conn, from)).toEqual(["E2 80 94", "41", "reset", RIS, "43"]);
  });

  it("believes an ack of exactly the bytes on the wire after a character was held, and not one byte more", async () => {
    const r = await kit.openRelay(tb.terminalBridge, { ackWindow: 2 });
    const from = r.mark();
    const seedBytes = total(r.conn.binaries());
    r.text({ t: "ack", bytes: seedBytes });
    r.control().emit("output", hex("41 42 E2 80")); // 41 42 on the wire, E2 80 held
    r.control().emit("output", hex("43")); // not over the window yet (2): E2 80 43 goes, 5 in flight
    r.control().emit("output", hex("44")); // over: let go
    expect(wire(r.conn, from)).toEqual(["41 42", "E2 80 43"]);
    r.text({ t: "ack", bytes: seedBytes + 6 }); // one past the wire: not believed, no reseed
    await kit.settleUntil(() => r.control().seeds === 2, 20);
    expect(r.control().seeds).toBe(1);
    r.text({ t: "ack", bytes: seedBytes + 5 });
    await kit.settleUntil(() => r.control().seeds === 2);
    expect(r.control().seeds).toBe(2);
  });

  it("a pane size between the halves of a character: the size goes out in its place, the character after it, whole", async () => {
    const { relay, from } = await play([hex("41 E2 80")]);
    relay.control().emit("size", { cols: 100, rows: 30 });
    relay.control().emit("output", hex("94 42"));
    expect(wire(relay.conn, from)).toEqual(["41", "size", "E2 80 94 42"]);
  });

  it("the end of the session, a detach, an error: the exit goes out and the unfinished character never does", async () => {
    for (const reason of ["ended", "detached", "error"]) {
      const { relay, from } = await play([hex("41 E2 80")]);
      relay.control().emit("exit", { reason });
      await kit.settleUntil(() => relay.conn.closes.length > 0);
      expect(wire(relay.conn, from), reason).toEqual(["41", "exit"]);
    }
  });

  it("the deck shutting down, or the socket going away: nothing more, and nothing held is sent", async () => {
    const a = await play([hex("41 E2 80")]);
    a.relay.handle.shutdown("server-shutdown");
    a.relay.control().emit("output", hex("94"));
    expect(wire(a.relay.conn, a.from)).toEqual(["41", "exit"]);
    const b = await play([hex("41 E2 80")]);
    b.relay.handle.closed(1006, "");
    b.relay.control().emit("output", hex("94"));
    expect(wire(b.relay.conn, b.from)).toEqual(["41"]);
  });

  it("a reconnect: the new socket's stream owes nothing to the old one's pending character", async () => {
    // Two sockets on one pane, one after the other: each relay holds only
    // what its own stream began.
    const old = await play([hex("41 E2 80")]);
    old.relay.handle.closed(1006, "");
    const next = await kit.openRelay(tb.terminalBridge);
    const from = next.mark();
    next.control().emit("output", hex("94 42"));
    expect(wire(next.conn, from)).toEqual(["94 42"]);
    expect(wire(old.relay.conn, old.from)).toEqual(["41"]);
  });

  it("a pane that dies before the panel has a frame: its last frame is sent without an unfinished character, then the exit", async () => {
    const conn = new kit.RecordingConn();
    let control: any;
    tb.terminalBridge({
      conn, socket: new EventEmitter(), debounceMs: 5,
      binding: { kind: "A", tmux: "/bin/tmux", socket: { name: "ccdeck-test-utf8" }, target: "%4", pane: "%4" },
      open: (o: any) => (control = new kit.StandInControl(o)),
    });
    control.seedBytes = () => hex("1B 63 41 E2 80");
    control.emit("exit", { reason: "ended" });
    await kit.settleUntil(() => conn.closes.length > 0);
    expect(conn.sent.map((s: any) => (s.type === "text" ? s.msg.t : toHex(s.data)))).toEqual(["hello", "reset", "1B 63 41", "exit"]);
  });
});
