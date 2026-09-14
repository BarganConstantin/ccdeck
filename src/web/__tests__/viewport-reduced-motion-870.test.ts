// #870: under reduced motion the camera still flew 350-500 ms to every card.
//
// j/k, a session picked from the list and the selected ribbon all frame a card
// with `rf.fitView({ duration })`, and the viewport rule in viewport-motion.ts
// only ever asked whether the tab was hidden. The CSS half of the deck answers
// `prefers-reduced-motion` with care — reduced-motion-reach.test.ts polices it —
// but the camera is driven from JS, where no media query reaches, so a reader
// who had asked the OS for less motion got a full-canvas pan and zoom on every
// keypress. Same class of gap #357 closed for the inline transitions.
//
// The rule now reads the setting, and the three fits that passed a bare number
// ask it through fitViewDuration — whose 0 takes fitView's synchronous branch,
// which is what makes "no animation" mean "go now" rather than "never".
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fitViewDuration, prefersReducedMotion, shouldAnimateViewport } from "../viewport-motion";

afterEach(() => { vi.unstubAllGlobals(); });

const asking = (reduce: boolean) =>
  (query: string) => ({ matches: reduce && query === "(prefers-reduced-motion: reduce)" });

describe("the camera under reduced motion (#870)", () => {
  it("does not animate when the reader asked for less motion", () => {
    expect(shouldAnimateViewport({ durationMs: 500, documentHidden: false, reducedMotion: true })).toBe(false);
    expect(shouldAnimateViewport({ durationMs: 500, documentHidden: false, reducedMotion: false })).toBe(true);
  });

  it("reads the setting from the page when the caller leaves it out", () => {
    // Every call site passes durationMs and documentHidden and nothing else, so
    // the default is the part that actually reaches them.
    vi.stubGlobal("matchMedia", asking(true));
    expect(prefersReducedMotion()).toBe(true);
    expect(shouldAnimateViewport({ durationMs: 500, documentHidden: false })).toBe(false);
    vi.stubGlobal("matchMedia", asking(false));
    expect(shouldAnimateViewport({ durationMs: 500, documentHidden: false })).toBe(true);
  });

  it("animates as before where there is no setting to read", () => {
    expect(prefersReducedMotion()).toBe(false);
    expect(shouldAnimateViewport({ durationMs: 500, documentHidden: false })).toBe(true);
  });

  it("hands fitView a zero when the rule says no, and the duration when it says yes", () => {
    vi.stubGlobal("matchMedia", asking(true));
    expect(fitViewDuration(500)).toBe(0);
    vi.stubGlobal("matchMedia", asking(false));
    expect(fitViewDuration(500)).toBe(500);
  });
});

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
const appCode = app
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");

describe("every fit that frames a card asks the rule", () => {
  it("passes fitView no bare duration", () => {
    // A fourth fit added with `duration: 500` is this bug again.
    const fits = [...appCode.matchAll(/rf\.fitView\(\{([^}]*)\}\)/g)].map(m => m[1]);
    expect(fits.length).toBeGreaterThanOrEqual(3);
    for (const options of fits) {
      expect(options).not.toMatch(/duration:\s*\d/);
      expect(options).toMatch(/duration: fitViewDuration\(\d+\)/);
    }
  });

  it("relies on a synchronous branch React Flow's fitView still has", () => {
    // fitViewDuration's 0 is only "go now" because of this line. Should an
    // upgrade drop it, a 0 becomes a transition waiting on a frame (#671).
    const core = readFileSync(fileURLToPath(
      new URL("../../../node_modules/@reactflow/core/dist/esm/index.mjs", import.meta.url)), "utf8");
    expect(core).toMatch(/typeof options\.duration === 'number' && options\.duration > 0/);
  });
});
