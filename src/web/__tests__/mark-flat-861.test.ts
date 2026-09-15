// #861: the ✓ on every finished tool bubble glowed green. The bubble itself had
// already given up its ring and glow ("SUCCESS IS FLAT, AND THAT IS WHAT MAKES
// FAILURE FINDABLE"), but its mark still carried a 6px green text-shadow, and
// on a live canvas 103 glowing ticks sat around two glowing crosses. The tick
// is flat now; the cross keeps its glow, so a failure is the one lit thing.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** Every declaration block whose selector list names `sel` exactly. */
const bodies = (sel: string): string[] => {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(",").map(s => s.trim()).includes(sel)) out.push(m[2]);
  }
  return out;
};

describe("the tick on a finished bubble is flat (#861)", () => {
  it("draws the ✓ in its colour and nothing around it", () => {
    const done = bodies(".tool-burst .tb-mark.done");
    expect(done.length).toBeGreaterThan(0);
    for (const b of done) {
      expect(b).toMatch(/color:\s*var\(--ok\)/);
      expect(b).not.toMatch(/text-shadow/);
    }
  });

  it("gives no theme a way to put the glow back", () => {
    expect(css).not.toMatch(/\.tb-mark\.done[^{]*\{[^}]*text-shadow/);
  });

  it("leaves the × lit, so a failure is still the thing that stands out", () => {
    const err = bodies(".tool-burst .tb-mark.err").join("\n");
    expect(err).toMatch(/color:\s*var\(--err\)/);
    expect(err).toMatch(/text-shadow:\s*0 0 6px/);
  });
});
