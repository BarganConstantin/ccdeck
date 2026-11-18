// seed-boundary.mjs on its own: what a seed taken at a byte of the pane's
// output hands on so that an emulator the seed reset reads the rest as
// tmux's parser does — the pen, the sequence the output stopped inside, the
// first bytes of a character. tmux-control-tmux.test.ts plays it on a real
// tmux ("hands a seed taken inside ..."); this file pins the rules byte by
// byte, and then checks them against xterm.js itself: an emulator that loses
// its parser and its pen at any byte of a stream and is handed tail() there
// must draw the rest exactly as one that lost nothing.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { seedBoundary, sgrSets, PENDING_MAX, PEN_MAX } from "../../server/seed-boundary.mjs";
// @ts-expect-error — plain .mjs test kit, no types
import * as kit from "./utf8-frames-kit.mjs";

const X = kit.headlessXterm();
const { hex } = kit;
const u = (s: string) => Buffer.from(s, "utf8");

/** The tail after `writes`, each a feed() of its own. */
function tailAfter(...writes: (string | Buffer)[]) {
  const t = seedBoundary();
  for (const w of writes) t.feed(typeof w === "string" ? u(w) : w);
  return t.tail();
}
const shown = (b: Buffer) => JSON.stringify(b.toString("latin1"));

describe("sgrSets", () => {
  const sets = (s: string) => sgrSets(s) as number;

  it("has each parameter set its attributes whole, and a reset all of them", () => {
    expect(sets("0")).toBe(sets(""));
    for (const p of ["1", "2", "3", "4", "4:3", "4:0", "21", "22", "23", "24", "5", "25", "7", "27", "8", "28", "9", "29",
      "53", "55", "31", "39", "41", "49", "94", "104", "38;5;1", "48;2;1;2;3", "58;5;3", "59"]) {
      expect(sets(p), p).toBeGreaterThan(0);
      expect(sets(p) & ~sets("0"), p).toBe(0);
    }
    // The pairs that set the same attribute, and those that do not.
    expect(sets("1")).not.toBe(sets("2"));
    expect(sets("22")).toBe(sets("1") | sets("2"));
    for (const [a, b] of [["4", "24"], ["4:3", "21"], ["5", "25"], ["7", "27"], ["8", "28"], ["9", "29"], ["53", "55"],
      ["31", "39"], ["38;5;9", "97"], ["41", "49"], ["48;5;9", "107"], ["58;5;3", "59"]]) {
      expect(sets(a), `${a} and ${b}`).toBe(sets(b));
    }
  });

  it("reads a 38, 48 or 58 as xterm.js does: the colour's own parameters, and only modes 2 and 5 set it", () => {
    expect(sets("38;5;1;1")).toBe(sets("31") | sets("1"));
    expect(sets("38;2;1;2;3;3")).toBe(sets("31") | sets("3"));
    expect(sets("38:2::1:2:3;4")).toBe(sets("31") | sets("4"));
    expect(sets("38:5:200;7")).toBe(sets("31") | sets("7"));
    expect(sets("48;5")).toBe(sets("41"));
    // A mode xterm.js does not draw leaves the colour as it was.
    expect(sets("38;9;1")).toBe(0);
    expect(sets("38")).toBe(0);
  });

  it("is -1 for a parameter xterm.js does not read, and for more than 32 of them", () => {
    for (const p of ["6", "10", "26", "50", "73", "1;6"]) expect(sets(p), p).toBe(-1);
    expect(sets(Array(33).fill("1").join(";"))).toBe(-1);
    expect(sets(Array(32).fill("1").join(";"))).toBe(sets("1"));
  });
});

describe("seedBoundary: the pen", () => {
  it("is nothing at rest with the default pen", () => {
    expect(tailAfter("plain text\r\n", "\x1b[2J\x1b[H more").length).toBe(0);
  });

  it("is the SGRs since the pen was last reset", () => {
    expect(shown(tailAfter("\x1b[1m\x1b[38;5;126mAB"))).toBe(shown(u("\x1b[1m\x1b[38;5;126m")));
    expect(tailAfter("\x1b[1m\x1b[31mA\x1b[0mB").length).toBe(0);
    expect(tailAfter("\x1b[1m\x1b[31mA\x1b[mB").length).toBe(0);
    expect(tailAfter("\x1b[1m\x1b[31mA\x1b[;mB").length).toBe(0);
    expect(shown(tailAfter("\x1b[1m\x1b[0;32mA"))).toBe(shown(u("\x1b[0;32m")));
    expect(shown(tailAfter("\x1b[1m\x1b[32;0;4mA"))).toBe(shown(u("\x1b[32;0;4m")));
  });

  it("drops an SGR whose every attribute a later one sets again, so a long run stays short", () => {
    let s = "";
    for (let i = 0; i < 400; i++) s += `\x1b[3${i % 8}m${i}\x1b[4${(i * 3) % 8}m`;
    const t = tailAfter(s, "\x1b[1m");
    expect(t.length).toBeLessThan(300);
    const text = t.toString("latin1");
    expect(text.endsWith("\x1b[1m")).toBe(true);
    expect(text.lastIndexOf("\x1b[37m")).toBeGreaterThan(text.lastIndexOf("\x1b[30m"));
    expect(text).toContain("\x1b[45m");
  });

  it("keeps an SGR it cannot read until a reset, and presumes the default pen past PEN_MAX", () => {
    let s = "\x1b[6m";
    for (let i = 0; i < 100; i++) s += `\x1b[3${i % 8}m`;
    expect(tailAfter(s).toString("latin1").startsWith("\x1b[6m")).toBe(true);
    expect(tailAfter(s, "\x1b[0m").length).toBe(0);
    expect(tailAfter("\x1b[6m".repeat(3000)).length).toBeLessThanOrEqual(PEN_MAX);
  });

  it("keeps a copy at a DECSC for the screen it is on, and puts it back at a DECRC", () => {
    expect(shown(tailAfter("\x1b[31m\x1b7\x1b[32mA\x1b8"))).toBe(shown(u("\x1b[31m")));
    expect(shown(tailAfter("\x1b[31m\x1b[s\x1b[0;33m\x1b[u"))).toBe(shown(u("\x1b[31m")));
    expect(shown(tailAfter("\x1b[31m\x1b[?1048h\x1b[0m\x1b[?1048l"))).toBe(shown(u("\x1b[31m")));
    expect(shown(tailAfter("\x1b[31m\x1b[?1049h\x1b[34m\x1b7\x1b[35m\x1b[?1049l"))).toBe(shown(u("\x1b[31m")));
    // The alternate screen's copy is its own.
    expect(shown(tailAfter("\x1b[31m\x1b7\x1b[?1047h\x1b[34m\x1b8"))).toBe("\"\"");
    expect(tailAfter("\x1b[31m\x1b8").length).toBe(0);
    // A reset forgets the copies too.
    expect(tailAfter("\x1b[31m\x1b7\x1b[!p\x1b8").length).toBe(0);
    expect(tailAfter("\x1b[31m\x1b7\x1bc\x1b8").length).toBe(0);
  });
});

describe("seedBoundary: the rest", () => {
  it("is the sequence the output stopped inside, from its ESC, after the pen", () => {
    for (const s of ["\x1b", "\x1b[", "\x1b[38;5;2", "\x1b[?10", "\x1b[>", "\x1b]0;tit", "\x1b]52;c;QUJD", "\x1bP$q", "\x1bP1;2|ab",
      "\x1b(", "\x1b_apc", "\x1b[1 "]) {
      expect(shown(tailAfter("text", s)), JSON.stringify(s)).toBe(shown(u(s)));
    }
    expect(shown(tailAfter("\x1b[31mA\x1b[1"))).toBe(shown(u("\x1b[31m\x1b[1")));
    expect(shown(tailAfter("\x1b[38;5", ";2"))).toBe(shown(u("\x1b[38;5;2")));
  });

  it("leaves out the C0 controls in it that took effect already", () => {
    expect(shown(tailAfter("\x1b[38\r;5\n;2"))).toBe(shown(u("\x1b[38;5;2")));
    expect(shown(tailAfter("\x1b\x08[3"))).toBe(shown(u("\x1b[3")));
    expect(shown(tailAfter("\x1b]0;a\x0eb"))).toBe(shown(u("\x1b]0;ab")));
    // A DCS's passthrough data keeps them: they are its data, not controls.
    expect(shown(tailAfter("\x1bPq#0\r#1"))).toBe(shown(u("\x1bPq#0\r#1")));
  });

  it("is nothing once the sequence is finished, cancelled or broken off", () => {
    for (const s of ["\x1b[2J\x1b[H", "\x1b]0;t\x07", "\x1b]0;t\x1b\\", "\x1bP$qm\x1b\\", "\x1b[3\x18", "\x1b[3\x1a", "\x1b(B", "\x1b7",
      "\x1b[3\u0085", "\x1b]0;t\u009c", "\x1b[3世"]) {
      expect(tailAfter(s).length, JSON.stringify(s)).toBe(0);
    }
  });

  it("reads 8-bit C1 introducers, and hands them on as they came", () => {
    expect(shown(tailAfter("\u009b3"))).toBe(shown(u("\u009b3")));
    expect(shown(tailAfter("\u009b31mA"))).toBe(shown(u("\x1b[31m")));
    expect(shown(tailAfter("\u009d0;t"))).toBe(shown(u("\u009d0;t")));
  });

  it("ends with the first bytes of a character the output stopped inside", () => {
    expect(tailAfter(hex("41 E4 B8")).equals(hex("E4 B8"))).toBe(true);
    expect(tailAfter(hex("41 F0 9F 9A")).equals(hex("F0 9F 9A"))).toBe(true);
    expect(tailAfter(u("\x1b[31m"), hex("41 C3")).equals(Buffer.concat([u("\x1b[31m"), hex("C3")]))).toBe(true);
    expect(tailAfter(u("\x1b]0;"), hex("E4 B8")).equals(Buffer.concat([u("\x1b]0;"), hex("E4 B8")]))).toBe(true);
    // Bytes that can never finish a character are not handed on.
    expect(tailAfter(hex("41 E0 80")).length).toBe(0);
    expect(tailAfter(hex("41 ED A0")).length).toBe(0);
  });

  it("takes a byte order mark as xterm.js does: nothing, not even the end of a sequence", () => {
    expect(shown(tailAfter("\x1b[3﻿1"))).toBe(shown(u("\x1b[31")));
  });

  it("hands on no sequence longer than PENDING_MAX, and the pen all the same", () => {
    const long = `\x1b]52;c;${"A".repeat(PENDING_MAX)}`;
    expect(shown(tailAfter("\x1b[31m", long))).toBe(shown(u("\x1b[31m")));
    expect(shown(tailAfter("\x1b[31m", long, "\x07\x1b[4"))).toBe(shown(u("\x1b[31m\x1b[4")));
  });

  it("is the same however the output was cut into writes", () => {
    const s = u("\x1b[1;38;5;200mAB\x1b]0;ti\x07世\x1b[4:3m\x1b[48;2;1;2;3mx\x1b[?1049h\x1b[0;7m\x1b7\x1b[2m\x1b8\x1b[38;5;1");
    const whole = tailAfter(s, hex("E4 B8"));
    for (let a = 0; a <= s.length; a++) {
      for (let b = a; b <= s.length; b += 3) {
        const t = tailAfter(s.subarray(0, a), s.subarray(a, b), s.subarray(b), hex("E4"), hex("B8"));
        if (!t.equals(whole)) expect(shown(t), `cut at ${a} and ${b}`).toBe(shown(whole));
      }
    }
  });
});

describe("seedBoundary: lose() and presume()", () => {
  it("after lose(), presumes the default pen and hands nothing on until an ESC, CAN, SUB or C1 says where the parser is", () => {
    const t = seedBoundary();
    t.feed(u("\x1b[31m\x1b7\x1b[38;5"));
    t.lose();
    expect(t.tail().length).toBe(0);
    t.feed(u(";1mABC"));
    t.feed(hex("E4 B8"));
    expect(t.tail().length).toBe(0);
    t.feed(u("\x1b[3"));
    expect(shown(t.tail())).toBe(shown(u("\x1b[3")));
    t.feed(u("2mX\x1b8"));
    expect(t.tail().length).toBe(0);
    t.feed(u("\x1b[33m"));
    expect(shown(t.tail())).toBe(shown(u("\x1b[33m")));
    for (const placer of ["\x18", "\x1a", "\u0085"]) {
      const v = seedBoundary();
      v.lose();
      v.feed(u(`${placer}AB`));
      v.feed(hex("E4 B8"));
      expect(v.tail().equals(hex("E4 B8")), JSON.stringify(placer)).toBe(true);
    }
  });

  it("after presume(), takes the parser as at rest and keeps the pen it read", () => {
    const t = seedBoundary();
    t.lose();
    t.feed(u("\x1b[32m"));
    t.feed(u("x\x1b[1;2"));
    t.presume();
    expect(shown(t.tail())).toBe(shown(u("\x1b[32m")));
    t.feed(u("\x1b[4"));
    expect(shown(t.tail())).toBe(shown(u("\x1b[32m\x1b[4")));
  });
});

// ── against xterm.js ────────────────────────────────────────────────────────
//
// A stands for the emulator that read everything: one write of the stream.
// B for the one a seed reset at byte k: it read the stream up to k, then lost
// its parser state, the half character and its pen — a CAN and an SGR 0 do
// exactly that and nothing else — then got tail() and the rest. Every other
// thing a seed would also reset (the screen, the cursor, the modes) B keeps,
// so a difference between them can only be one tail() failed to hand on.

/** mulberry32: a fixed sequence for a fixed seed. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A stream that is hard on a parser and a pen. "pen" has every SGR the
 * tracker reads, underline styles and colours too; "saves" has DECSC/DECRC
 * and the screens that save, and no underline at all: xterm.js keeps the
 * current underline style and colour across a DECRC, which the tracker
 * does not follow. No combining marks either: a cut between a character and
 * its mark is lost to any seed (both in seed-boundary.mjs, WHAT IT DOES NOT
 * HAND ON).
 */
function stream(family: "pen" | "saves", seed: number, tokens = 90): Buffer {
  const r = rng(seed);
  const n = (k: number) => Math.floor(r() * k);
  const pick = <T,>(xs: T[]) => xs[n(xs.length)];
  const colour = () => pick([
    () => `3${n(8)}`, () => `4${n(8)}`, () => `9${n(8)}`, () => `10${n(8)}`, () => "39", () => "49",
    () => `38;5;${n(256)}`, () => `48;5;${n(256)}`, () => `38;2;${n(256)};${n(256)};${n(256)}`,
    () => `48:2::${n(256)}:${n(256)}:${n(256)}`, () => `38:5:${n(256)}`, () => "38;9;1",
  ])();
  const flags = ["0", "", "1", "2", "3", "5", "7", "8", "9", "22", "23", "25", "27", "28", "29", "53", "55", "6"];
  const underline = ["4", "4:3", "4:0", "21", "24", "59", `58;5;${n(256)}`, `58:2::1:${n(256)}:3`];
  const param = () => (r() < 0.45 ? colour() : family === "pen" && r() < 0.3 ? pick(underline) : pick(flags));
  const sgr = () => `\x1b[${Array.from({ length: 1 + n(3) }, param).join(";")}m`;
  const text = () => Array.from({ length: 1 + n(4) }, () => pick(["a", "Z", "0", " ", "é", "世", "🚀", "─", "ﬁ"])).join("");
  const common: (() => string)[] = [
    sgr, sgr, sgr, text, text, text,
    () => `\x1b[${1 + n(6)};${1 + n(20)}H`, () => "\r\n", () => "\x1b[K",
    () => "\x1b]0;a title\x07", () => "\x1b]2;t\x1b\\", () => "\x1bP$qm\x1b\\",
    () => `\x1b[3\r${n(8)}m`, () => "\x1b[3\x18", () => `\u009b${n(8) + 30}m`,
    () => pick(["\x1b(0", "\x1b(B"]), () => "\x1b[?1047h", () => "\x1b[?1047l", () => "\x1b[!p",
  ];
  const saves: (() => string)[] = [
    () => "\x1b7", () => "\x1b8", () => "\x1b[s", () => "\x1b[u", () => "\x1b[?1048h", () => "\x1b[?1048l",
    () => "\x1b[?1049h", () => "\x1b[?1049l",
  ];
  const all = family === "saves" ? [...common, ...saves, ...saves] : common;
  let s = "";
  for (let i = 0; i < tokens; i++) s += pick(all)();
  return u(s);
}

const COLS = 20;
const ROWS = 6;

/** Every cell of both screens as xterm.js draws it, and the cursor. */
async function drawn(data: Buffer) {
  const t = kit.makeTerminal(X, { cols: COLS, rows: ROWS, scrollback: 0 });
  await kit.writeTo(t, Uint8Array.from(data));
  const cell = t.buffer.active.getNullCell();
  const out: string[] = [`active ${t.buffer.active.type} cursor ${t.buffer.active.cursorX},${t.buffer.active.cursorY}`];
  for (const buf of [t.buffer.normal, t.buffer.alternate]) {
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y);
      for (let x = 0; line && x < line.length; x++) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c: any = line.getCell(x, cell);
        out.push(`${buf.type} ${x},${y} ${JSON.stringify(c.getChars())} w${c.getWidth()}`
          + ` fg${c.getFgColorMode()}:${c.getFgColor()} bg${c.getBgColorMode()}:${c.getBgColor()}`
          + ` ${[c.isBold(), c.isDim(), c.isItalic(), c.isUnderline(), c.isBlink(), c.isInverse(), c.isInvisible(),
            c.isStrikethrough(), c.isOverline()].map(Boolean).map(Number).join("")}`
          + ` ul${c.getUnderlineStyle()}:${c.getUnderlineColorMode()}:${c.getUnderlineColor()}`);
      }
    }
  }
  t.dispose();
  return out;
}

/** The tail at byte k, fed in pieces of a length chosen by `r`. */
function tailAt(s: Buffer, k: number, r: () => number) {
  const t = seedBoundary();
  for (let i = 0; i < k;) {
    const j = Math.min(k, i + 1 + Math.floor(r() * 40));
    t.feed(s.subarray(i, j));
    i = j;
  }
  return t.tail();
}

describe("seedBoundary against xterm.js", () => {
  for (const family of ["pen", "saves"] as const) {
    it(`hands on what a cut at any byte took from the emulator (${family})`, async () => {
      if (!kit.needed("@xterm/headless", X)) return;
      let compared = 0;
      for (let seed = 1; seed <= 10; seed++) {
        const s = stream(family, seed * 7919);
        const whole = await drawn(s);
        const r = rng(seed);
        // Every byte of the first stream; about 60 of each of the others.
        const cuts = seed === 1 ? [...Array(s.length + 1).keys()] : Array.from({ length: 60 }, () => Math.floor(r() * (s.length + 1)));
        for (const k of cuts) {
          const tail = tailAt(s, k, r);
          const cut = await drawn(Buffer.concat([s.subarray(0, k), u("\x18\x1b[0m"), tail, s.subarray(k)]));
          compared++;
          if (cut.join("\n") === whole.join("\n")) continue;
          const at = whole.findIndex((line, i) => line !== cut[i]);
          expect(`${cut[at]}`, `stream ${seed}, cut at byte ${k} of ${s.length}: ${shown(s.subarray(Math.max(0, k - 24), k))} | `
            + `${shown(s.subarray(k, k + 24))}; tail ${shown(tail)}`).toBe(`${whole[at]}`);
        }
      }
      expect(compared).toBeGreaterThan(1000);
    }, 120_000);
  }
});
