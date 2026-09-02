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

describe("the radar and its legend", () => {
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
    const calls = source.match(/watchedBrowsers\(/g) ?? [];
    expect(calls.length, "watchedBrowsers is being called per consumer again").toBeLessThanOrEqual(2);
    expect(source).toMatch(/const watching = watchedBrowsers\(/);
    // And the consumers read the shared name, not a fresh call.
    expect(source).toMatch(/browsers=\{watching\.map\(/);
    expect(source).toMatch(/\{watching\.map\(b => \(\s*<li key=\{b\.key\} className=\{b\.running/);
  });
});
