// #823: quota pace said "6% ahead" in amber when the reader was over-spending.
//
// "Ahead" is how plain English says winning, and on this line it meant the
// opposite: burning the window faster than it lasts. The amber was the only
// part telling the truth, and the reader took the word over the colour. The
// under-spending side said "reserve", a second vocabulary for the same scale.
// Both are measured against the same thing — the pace that lasts until the
// reset — so both are named by it now.
import { describe, it, expect } from "vitest";
import { computePace } from "../components/UsagePanel";

const HOUR = 3600;
const WINDOW = 5 * HOUR;
/** Half-way through a five-hour window: the pace that lasts is 50%. */
const half = (pct: number) => computePace(pct, 10 * HOUR, WINDOW, 10 * HOUR - WINDOW / 2);

describe("pace is said as over or under, never ahead (#823)", () => {
  it("calls over-spending over pace, in the warning colour", () => {
    const p = half(56)!;
    expect(p.label).toBe("6% over pace");
    expect(p.isDeficit).toBe(true);
    expect(p.color).toBe("var(--warn)");
  });

  it("calls under-spending under pace", () => {
    const p = half(39)!;
    expect(p.label).toBe("11% under pace");
    expect(p.isDeficit).toBe(false);
  });

  it("keeps on pace for anything within three points of the line", () => {
    expect(half(52)!.label).toBe("on pace");
    expect(half(48)!.label).toBe("on pace");
  });

  it("never says ahead or reserve", () => {
    for (let pct = 0; pct <= 100; pct += 7) {
      const label = half(pct)?.label ?? "";
      expect(label).not.toMatch(/ahead|reserve/);
    }
  });
});
