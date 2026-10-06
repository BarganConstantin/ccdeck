// The card's elapsed clock stays on one line at every card width.
//
// Past a hundred minutes it read "104m 54s", eight characters, and on a card
// already at its widest beside the context donut the header had no room for
// them: the clock broke between its two words, took a second line, and the
// card grew 13px taller while a session ran. Now the clock is never cut and
// never wraps, a hundred minutes and up read as hours and minutes the way the
// session list prints an hour, and its box keeps one width while the digits
// tick, so a card does not change size as the minutes turn over.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { elapsed } from "../duration";
import { cascade, el, selects } from "./sheet-cascade";

const list = readFileSync(fileURLToPath(new URL("../components/SessionList.tsx", import.meta.url)), "utf8");
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("the elapsed clock past a hundred minutes", () => {
  it("keeps minutes and seconds up to 99m 59s", () => {
    expect(elapsed(0, undefined, 59 * MIN + 59_000)).toBe("59m 59s");
    expect(elapsed(0, undefined, 75 * MIN + 12_000)).toBe("75m 12s");
    expect(elapsed(0, undefined, 100 * MIN - 1)).toBe("99m 59s");
  });

  it("reads hours and minutes from 100 minutes on", () => {
    expect(elapsed(0, undefined, 100 * MIN)).toBe("1h 40m");
    expect(elapsed(0, undefined, 104 * MIN + 54_000)).toBe("1h 44m");
    expect(elapsed(0, undefined, 2 * HOUR + 5 * MIN + 59_000)).toBe("2h 5m");
    expect(elapsed(0, undefined, 10 * HOUR)).toBe("10h 0m");
    expect(elapsed(0, undefined, 100 * HOUR - 1)).toBe("99h 59m");
    // A finished session's clock stops where it ended, in the same words.
    expect(elapsed(1_000, 1_000 + 3 * HOUR + 7 * MIN, 9 * HOUR)).toBe("3h 7m");
  });

  it("reads what the session's row in the list reads, from 100 minutes on", () => {
    // SessionList's elapsedShort, restated, so the comparison is against the
    // row's formula and not the function under test. Below a hundred minutes
    // the card keeps its seconds and the row does not, as before.
    const row = (ms: number) => { const m = Math.floor(ms / MIN); return `${Math.floor(m / 60)}h ${m % 60}m`; };
    const moved: number[] = [];
    for (let ms = 100 * MIN; ms < 100 * HOUR; ms += 7_919) if (elapsed(0, undefined, ms) !== row(ms)) moved.push(ms);
    expect(moved).toEqual([]);
    expect(list).toMatch(/return `\$\{h\}h \$\{m % 60\}m`;/);
  });

  it("is seven characters at most for every span under a hundred hours", () => {
    let widest = "";
    for (let s = 0; s < 100 * 3600; s++) {
      const t = elapsed(0, undefined, s * 1000);
      if (t.length > widest.length) widest = t;
    }
    expect(widest.length).toBe(7);
  });
});

describe("the card's clock box", () => {
  /** The card's header, down to the clock, on the full card. */
  const TIME = [
    el("html", [], { states: ["root"] }), el("body"), el("div", ["app"]),
    el("main", ["canvas-wrap"], { attrs: { "data-lod": "detail" } }), el("div", ["react-flow"]),
    el("div", ["react-flow__node", "react-flow__node-agent"]), el("div", ["agent-node", "state-active"]),
    el("div", ["head"]), el("div", ["head-right"]), el("div", ["time"]),
  ];
  const got = (prop: string, width: number) => cascade(s => selects(s, TIME), prop, width);

  for (const width of [1440, 390]) {
    it(`never wraps, never shrinks, and keeps seven digits' width at ${width}px`, () => {
      expect(got("white-space", width)).toBe("nowrap");
      expect(got("flex", width)).toBe("none");
      // Seven characters of a monospaced face with tabular figures: every
      // reading below a hundred hours fits it, so the label beside it keeps
      // one width while the clock counts.
      expect(got("min-width", width)).toBe("7ch");
      expect(got("text-align", width)).toBe("right");
      expect(got("font-variant-numeric", width)).toBe("tabular-nums");
      expect(got("font-family", width)).toBe("var(--font-mono)");
    });
  }
});
