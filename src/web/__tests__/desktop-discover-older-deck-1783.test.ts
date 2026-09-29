// An older deck found while the desktop app has none of its own (#1783).
//
// discover() shut down any deck older than the one the app carries whenever
// the app had no deck of its own and was not starting one — and then only
// attached to nothing. The start that was meant to take its place is
// ensureDeck's, and discover() also runs from the five-second look for a
// deck, from the tray stream's lost event and from the own deck's exit, none
// of which start anything. So an older `ccdeck` started in a terminal while
// the app had no deck was shut down within seconds and the machine was left
// with none.
//
// The decision is discoverPlan in own-deck.mjs now: a deck is replaced only on
// the path that starts the app's own right after, and every other look
// attaches to what it found.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs, no types
import { discoverPlan } from "../../../desktop/own-deck.mjs";
// @ts-expect-error — plain .mjs, no types
import { olderVersion } from "../../server/running-deck.mjs";

const OURS = "3.32.0";
const older = { pid: 4242, port: 4317, token: "t", version: "3.31.0" };
const base = { found: older, ours: OURS, ownDeck: null, starting: null, olderVersion };

describe("what a look for a deck does with an older one", () => {
  it("attaches to it when nothing will start in its place — the periodic, lost and exit looks", () => {
    expect(discoverPlan({ ...base, willStart: false })).toBe("attach");
    // Nor one that reports no version at all, which also counts as older.
    expect(discoverPlan({ ...base, found: { ...older, version: undefined }, willStart: false })).toBe("attach");
  });

  it("replaces it on the path that starts the app's own deck next", () => {
    expect(discoverPlan({ ...base, willStart: true })).toBe("replace");
  });

  it("attaches to one that is not older, or while the app has or is starting its own", () => {
    expect(discoverPlan({ ...base, found: { ...older, version: OURS }, willStart: true })).toBe("attach");
    expect(discoverPlan({ ...base, found: { ...older, version: "3.33.0" }, willStart: true })).toBe("attach");
    expect(discoverPlan({ ...base, ownDeck: {}, willStart: true })).toBe("attach");
    expect(discoverPlan({ ...base, starting: Promise.resolve(null), willStart: true })).toBe("attach");
  });

  it("has nothing to do when there is no deck", () => {
    expect(discoverPlan({ ...base, found: null, willStart: true })).toBe("none");
    expect(discoverPlan({ ...base, found: null, willStart: false })).toBe("none");
  });

  it("never shuts a deck down without a start to follow", () => {
    for (const found of [null, older, { ...older, version: undefined }, { ...older, version: OURS }])
      for (const ownDeck of [null, {}])
        for (const starting of [null, Promise.resolve(null)])
          for (const willStart of [false, true]) {
            const plan = discoverPlan({ ...base, found, ownDeck, starting, willStart });
            if (plan === "replace") expect({ willStart, ownDeck, starting }).toEqual({ willStart: true, ownDeck: null, starting: null });
          }
  });
});

describe("the app's wiring", () => {
  const main = readFileSync(fileURLToPath(new URL("../../../desktop/main.mjs", import.meta.url)), "utf8");
  const fn = (name: string) => {
    const at = main.search(new RegExp(`(?:async )?function ${name}\\(`));
    expect(at, `${name} is gone or renamed`).toBeGreaterThan(-1);
    return main.slice(at, main.indexOf("\n}\n", at));
  };

  it("decides through discoverPlan, and replaces only when told a start follows", () => {
    const body = fn("discover");
    expect(body).toMatch(/^async function discover\(\{ willStart = false \} = \{\}\) \{/);
    expect(body).toMatch(/discoverPlan\(\{ found, ours, ownDeck: ownDeck\.current\(\), starting, willStart, olderVersion \}\) === "replace"/);
    expect(body).not.toMatch(/if \(olderVersion\(/);
  });

  it("is told so by ensureDeck alone, before it starts the app's own", () => {
    const ensure = fn("ensureDeck");
    expect(ensure).toMatch(/^async function ensureDeck\(\) \{\n {2}await discover\(\{ willStart: true \}\);\n {2}if \(deck\) return deck;/);
    // Every other caller looks without it.
    expect(main.match(/discover\(\{ willStart: true \}\)/g)).toHaveLength(1);
    expect(main).toContain("setInterval(() => { if (!deck) discover(); }, 5_000);");
    expect(fn("discoverSoon")).toContain("await discover();");
  });
});
