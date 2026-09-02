import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { watchedBrowsers, type WatchBrowser } from "../components/BrowserWatchModal";

const browser = (over: Partial<WatchBrowser>): WatchBrowser => ({
  key: "chrome",
  name: "Google Chrome",
  installed: true,
  profiles: 1,
  withExtension: [],
  running: true,
  relay: { state: "unknown", count: 0, why: "" },
  ...over,
});

describe("the browsers the watch reads", () => {
  it("drops what is not installed, and what was installed but never opened", () => {
    // Never opened means no profile directory, which means no history file.
    // A blip for it would be a light with nothing behind it.
    const kept = watchedBrowsers([
      browser({ key: "chrome" }),
      browser({ key: "brave", installed: false }),
      browser({ key: "edge", profiles: 0 }),
    ]);
    expect(kept.map(b => b.key)).toEqual(["chrome"]);
  });

  it("keeps a browser that is installed and closed", () => {
    // Not running is a fact about right now; its history is still on disk and
    // still worth reading. The radar draws it dim rather than dropping it.
    expect(watchedBrowsers([browser({ running: false })])).toHaveLength(1);
  });

  it("holds the order it was given", () => {
    // Load-bearing: the radar puts blip i at angle i/n and the legend names
    // item i. If this reordered, every name would sit beside another's dot.
    const keys = watchedBrowsers([
      browser({ key: "brave" }),
      browser({ key: "chrome" }),
      browser({ key: "edge" }),
    ]).map(b => b.key);
    expect(keys).toEqual(["brave", "chrome", "edge"]);
  });

  it("survives a snapshot that has no browsers field yet", () => {
    expect(watchedBrowsers(undefined)).toEqual([]);
  });
});

describe("the radar and the rows beside it", () => {
  const source = readFileSync(new URL("../components/BrowserWatchModal.tsx", import.meta.url), "utf8");

  it("read from one list, not two copies of one predicate", () => {
    // The defect this exists for still LOOKS like a working radar: names beside
    // the wrong dots, every mark drawn, nothing to catch by eye. So it is
    // pinned at the source instead — the filter may be written once, inside
    // watchedBrowsers, and nowhere else.
    const inlined = source.match(/\.filter\(\s*b\s*=>\s*b\.installed\s*&&\s*b\.profiles\s*>\s*0\s*\)/g) ?? [];
    expect(inlined).toHaveLength(1);
    expect(source.slice(0, source.indexOf(inlined[0]))).toContain("export function watchedBrowsers");
  });

  it("read it once and share the array, rather than each calling for itself", () => {
    // Stronger than the old "at least four call sites". The component derives
    // `watching` once and every consumer reads that one array — the radar, the
    // legend, the profile rows, the counts and the status bar's tally. Sharing
    // the array is what makes "blip i is legend item i" true by construction
    // rather than by two filters happening to agree.
    // Not a call count — watchTrouble is a pure function and derives its own
    // view honestly. What must hold is that the RENDER reads one array: the
    // component derives `watching` once and every consumer names it.
    expect(source).toMatch(/const watching = watchedBrowsers\(/);
    // And the consumers read the shared name, not a fresh call. The radar and
    // the profile rows are the pair that must agree: the disc puts blip i at
    // angle i/n and the row list is what names them.
    expect(source).toMatch(/browsers=\{watching\.map\(/);
    expect(source).toMatch(/<ul className="bw-profiles">\s*\{watching\.map\(/);
    expect(source).toMatch(/visitTotals\(watching,/);
  });
});

describe("the disc on the ground it is drawn on", () => {
  it("knows a light ground from a dark one", async () => {
    // Alpha is contrast against the ground, and the radar was using one set of
    // alphas for both: a 26% accent wash reads as a beam over #0b0c10 and as
    // almost nothing over white, so the disc arrived in light as an empty
    // circle with a legend under it.
    const { isLight } = await import("../components/WatchRadar");
    expect(isLight("#0b0c10")).toBe(false);
    expect(isLight("#14161b")).toBe(false);
    expect(isLight("#eef1f6")).toBe(true);
    expect(isLight("#ffffff")).toBe(true);
  });

  it("assumes dark when it cannot tell, which is the ground it was tuned on", async () => {
    // A missing or unparseable token must not flip the disc into its pale
    // treatment on a dark ground, where the boosted alphas would glare.
    const { isLight } = await import("../components/WatchRadar");
    expect(isLight(undefined)).toBe(false);
    expect(isLight("")).toBe(false);
    expect(isLight("var(--something)")).toBe(false);
  });
});
