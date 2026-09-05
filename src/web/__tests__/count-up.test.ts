// A figure that arrives at its new value instead of teleporting to it.
//
// The Usage panel re-reads its numbers on a timer, so a total can change while
// somebody is looking straight at it. Replaced in one frame, $170 → $269 says
// only "this is different now": no direction, no sense of how much, and no
// signal at all if the eye was a few pixels away.
//
// The rules that keep it from becoming noise are the point of this file: no
// count on the first paint, none between two different quantities, none for a
// change too small to read, and none at all under reduced motion.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { countTo, frameValue, worthCounting, COUNT_MS } from "../count-up";

const panel = readFileSync(fileURLToPath(new URL("../components/UsagePanel.tsx", import.meta.url)), "utf8");

/** A clock and a frame pump the test drives by hand: real rAF in a node
 *  environment would either not exist or run on a timer nobody can step. */
function harness() {
  let t = 0;
  const queue: Array<(ms: number) => void> = [];
  const frames: number[] = [];
  const deps = {
    now: () => t,
    raf: (cb: (ms: number) => void) => { queue.push(cb); return queue.length; },
    cancel: () => { queue.length = 0; },
    reducedMotion: () => false,
    hidden: () => false,
  };
  const pump = (ms: number) => {
    t += ms;
    const due = queue.splice(0, queue.length);
    for (const cb of due) cb(t);
  };
  return { deps, frames, pump, at: () => t };
}

describe("what is worth counting", () => {
  it("ignores a change under one unit, or under half a percent", () => {
    // $269.10 → $269.40 is motion for its own sake, and so is 1.000M → 1.004M.
    expect(worthCounting(269.1, 269.4)).toBe(false);
    expect(worthCounting(1_000_000, 1_004_000)).toBe(false);
    expect(worthCounting(5, 5)).toBe(false);
  });

  it("counts a change a reader would notice", () => {
    expect(worthCounting(170, 269)).toBe(true);
    expect(worthCounting(269, 170)).toBe(true);           // down as well as up
    expect(worthCounting(0, 12)).toBe(true);
  });

  it("refuses anything that is not a pair of finite numbers", () => {
    expect(worthCounting(NaN, 10)).toBe(false);
    expect(worthCounting(10, Infinity)).toBe(false);
  });
});

describe("the curve", () => {
  it("starts at the old value and lands exactly on the new one", () => {
    // Landing EXACTLY matters more than the shape: a counter that stops at
    // $268.97 has told the reader something false.
    expect(frameValue(170, 269, 0)).toBe(170);
    expect(frameValue(170, 269, COUNT_MS)).toBe(269);
    expect(frameValue(170, 269, COUNT_MS * 10)).toBe(269);
  });

  it("eases out — most of the distance is covered early", () => {
    // The property that makes it read as arriving rather than as loading.
    const half = frameValue(0, 100, COUNT_MS / 2);
    expect(half).toBeGreaterThan(90);
    expect(half).toBeLessThan(100);
  });

  it("is monotonic, so a number never goes backwards on its way up", () => {
    let prev = -Infinity;
    for (let ms = 0; ms <= COUNT_MS; ms += COUNT_MS / 20) {
      const v = frameValue(10, 500, ms);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe("driving a count", () => {
  it("emits frames and finishes on the value", () => {
    const h = harness();
    const seen: number[] = [];
    countTo(0, 100, v => seen.push(v), h.deps);
    for (let i = 0; i < 30 && seen.at(-1) !== 100; i++) h.pump(30);
    expect(seen.length).toBeGreaterThan(3);
    expect(seen.at(-1)).toBe(100);
    // And it never overshot: no frame past the target.
    for (const v of seen) expect(v).toBeLessThanOrEqual(100);
  });

  it("retargets from where the number IS, not from where the last count began", () => {
    // A value that changes twice in a second must not jump backwards to catch
    // up. The second count starts at whatever frame the first had reached.
    const h = harness();
    const seen: number[] = [];
    const stop = countTo(0, 100, v => seen.push(v), h.deps);
    h.pump(60);
    const mid = seen.at(-1)!;
    expect(mid).toBeGreaterThan(0);
    stop();
    const second: number[] = [];
    countTo(mid, 200, v => second.push(v), h.deps);
    h.pump(30);
    expect(second[0]).toBeGreaterThanOrEqual(mid);
  });

  it("does not animate under reduced motion — it lands, once", () => {
    const h = harness();
    const seen: number[] = [];
    countTo(0, 100, v => seen.push(v), { ...h.deps, reducedMotion: () => true });
    expect(seen).toEqual([100]);
  });

  it("lands immediately in a background tab, where rAF never fires", () => {
    // A count started in a hidden tab would emit no frames at all and leave the
    // OLD number on screen until the tab came forward — the one state this
    // exists to prevent. Nobody is watching the motion there either way.
    const h = harness();
    const seen: number[] = [];
    countTo(0, 100, v => seen.push(v), { ...h.deps, hidden: () => true });
    expect(seen).toEqual([100]);
  });

  it("does not animate a change too small to read", () => {
    const h = harness();
    const seen: number[] = [];
    countTo(269.1, 269.4, v => seen.push(v), h.deps);
    expect(seen).toEqual([269.4]);
  });

  it("stops when told to, and emits nothing after", () => {
    const h = harness();
    const seen: number[] = [];
    const stop = countTo(0, 100, v => seen.push(v), h.deps);
    h.pump(30);
    const after = seen.length;
    stop();
    h.pump(300);
    expect(seen.length).toBe(after);
  });
});

describe("what the panel counts, and what it leaves alone", () => {
  it("counts the five aggregates at the top", () => {
    for (const name of ["shownCost", "shownIn", "shownOut", "shownCacheR", "shownCacheC"]) {
      // The declarations are column-aligned, so the match allows the padding.
      expect(panel, name).toMatch(new RegExp(`const ${name}\\s+= useCountUp\\(`));
    }
    expect(panel).toContain("{fmtCost(shownCost)}");
    expect(panel).toContain("{fmtTokens(shownIn)}");
  });

  it("leaves the tables alone", () => {
    // Twelve rows counting at once is a slot machine. The rows still render
    // their true value directly.
    expect(panel).toContain("<td className=\"up-num\">{fmtTokens(m.tokens)}</td>");
    expect(panel).toMatch(/<span className="up-session-tokens">\{fmtTokens\(s\.tokens\)\}<\/span>/);
  });

  it("snaps when the number changes meaning rather than value", () => {
    // "today $269" and "all time $12.4k" are different quantities; counting
    // between them would be theatre. The key carries the period, and the hook
    // sets the value directly when it moves.
    expect(panel).toContain('const countKey = fromRange ? `range:${shownPeriod ?? period}` : "board";');
    expect(panel).toContain("const meaningChanged = keyRef.current !== key;");
    expect(panel).toContain("if (firstRef.current || meaningChanged) {");
  });

  it("gates the cache figures on the true value, not the counted one", () => {
    // A strip that appeared and vanished as a count crossed zero would flicker.
    expect(panel).toContain("{(fromRange ? rangeSum.cacheReadTokens : totalTokens.cacheReadTokens) > 0 && <span className=\"up-tok\"><span className=\"up-k\">cache r</span>{fmtTokens(shownCacheR)}</span>}");
  });
});
