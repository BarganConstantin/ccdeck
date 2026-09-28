// #1497: a switch the accounts panel did not make dropped keyboard focus.
//
// The live account is drawn in one list and the others in the list behind the
// fold. When auto-switch or `cswap switch` in a terminal moves an account from
// one to the other, the next poll draws its row again in the new list — React
// does not move a keyed row between two parents — so the ⋯ the reader was on
// is removed and focus falls to <body>, with an identical ⋯ a few rows away.
//
// Measured in an isolated deck, fold open, focus on the live account's ⋯, the
// store switched from outside: on development focus is <body>; with this it is
// the same account's ⋯ in the list behind the fold. With the fold shut, where
// nothing draws the row, it is the fold's own row. Focus the reader moved off
// the panel before the poll stays where they put it on both.
//
// The chain is a pure function and is run; the half that has to live in the
// DOM — noticing the drop and asking the chain — is read.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { FOLD_ROW, refocusSelectors } from "../account-refocus";
import { rescueSelectors } from "../panel-press";
import { withoutComments } from "./tsx-scan";

const read = (rel: string) => withoutComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
const hook = read("../use-roster-focus.ts");
const panel = read("../components/AccountsPanel.tsx");

describe("where focus goes when a roster takes the focused control away (#1497)", () => {
  it("tries the same control first, wherever the row was drawn again", () => {
    expect(refocusSelectors("ap-more-2")[0]).toBe("#ap-more-2");
    expect(refocusSelectors("ap-row-3")[0]).toBe("#ap-row-3");
  });

  it("falls back to the fold's own row, then to the panel's reload", () => {
    expect(FOLD_ROW).toBe("#ap-rest-entry");
    expect(refocusSelectors("ap-more-2")).toEqual(["#ap-more-2", FOLD_ROW, ...rescueSelectors(null)]);
    expect(rescueSelectors(null)).toEqual([".accounts-panel .ap-refresh"]);
  });
});

describe("the panel notices the drop, and only a drop the roster made", () => {
  it("listens for focus on the whole panel", () => {
    expect(panel).toMatch(/const rosterFocus = useRosterFocus\(data\);/);
    expect(panel).toMatch(/onFocus=\{rosterFocus\.onFocus\} onBlur=\{rosterFocus\.onBlur\}/);
  });

  it("remembers the focused control by id, and forgets it when the reader moves focus themselves", () => {
    expect(hook).toMatch(/focusedId\.current = e\.target\.id \|\| null;/);
    // Still in the document: the reader moved it. Removed: the roster did.
    expect(hook).toMatch(/if \(e\.target\.isConnected\) focusedId\.current = null;/);
  });

  it("asks the chain before paint on every roster, and only when focus really fell off", () => {
    expect(hook).toMatch(/useLayoutEffect\(\(\) => \{/);
    expect(hook).toMatch(/if \(!id \|\| !focusDropped\(document\.activeElement\?\.tagName \?\? null\)\) return;/);
    expect(hook).toMatch(/for \(const sel of refocusSelectors\(id\)\)/);
    expect(hook).toMatch(/\}, \[data\]\);/);
  });
});
