// What a deck shows somebody who has never opened it.
//
// Three panels answer the questions a first run has — which accounts are
// there, what this machine is doing, what it is costing — and a person who has
// not met the deck cannot ask for a panel they do not know exists. Two of the
// three already opened on a first run; the machine panel did not, on an
// argument about REOPENING that the null check already prevents.
//
// The distinction the three now share is the whole of it: absent means "nobody
// has said", and that gets the panel. `"0"` means somebody closed it, and that
// is an answer on record which no later run overturns.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Comments stripped, so a rule cannot be satisfied by a paragraph that
 *  describes it. */
const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/^\s*\/\/.*$/gm, " ");

/** The one decision, spelled the one way, for each key that carries it. */
const OPENS_ON_FIRST_RUN = /const stored = (?:window\.localStorage\.getItem|readStored)\(KEY\);\s*return stored === null \? true : stored === "1";/;

const PANELS = [
  ["the machine panel", "MACHINE_PANEL_OPEN_KEY"],
  ["usage", "USAGE_PANEL_OPEN_KEY"],
  ["accounts", "ACCOUNTS_PANEL_OPEN_KEY"],
] as const;

describe("a first run opens the panels that answer its questions", () => {
  it.each(PANELS)("opens %s when nobody has said otherwise", (_name, key) => {
    const rule = new RegExp(OPENS_ON_FIRST_RUN.source.replace("KEY", key));
    expect(app).toMatch(rule);
  });

  // The argument the machine panel's old default rested on is kept by the rule
  // above, not by a rule of its own: a panel that came back after being closed
  // would be occupying the rail on behalf of a decision nobody made, and the
  // `stored === "1"` half is what reads that decision back.

  it("writes the answer down, so it survives a reload", () => {
    for (const [name, key] of PANELS) {
      expect(app, name).toMatch(new RegExp(`setItem\\(${key}, [^)]*\\? "1" : "0"\\)`));
    }
  });

  it("sees three panels, so none of the above can pass on an empty set", () => {
    expect(PANELS).toHaveLength(3);
    for (const [, key] of PANELS) expect(app, key).toContain(key);
  });
});
