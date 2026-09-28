// The Local network view's fold, asked what it does.
//
// The view draws the requests first and on their own, then the machines that
// are on, then — behind one control that counts them — every machine that is
// not. That split was written inline in LanSyncSection.tsx, where the suite
// could only read it; it is viewRows in lan-roster.ts now, and these call it.
import { describe, it, expect } from "vitest";

import { type DeckRow, viewRows } from "../lan-roster";

let n = 0;
const row = (kind: DeckRow["kind"], here: boolean, tone: DeckRow["tone"] = here ? "ok" : "idle"): DeckRow => ({
  fp: `fp-${n++}`, name: `machine ${n}`, addr: "", kind, state: "", tone, here, hint: "",
});

describe("the view's rows, split at the fold", () => {
  it("answers the requests on their own and keeps them out of the list", () => {
    const ask = row("asks", true, "wait");
    const on = row("paired", true);
    const split = viewRows([ask, on], false);
    expect(split.asks).toEqual([ask]);
    expect(split.rest).toEqual([on]);
    expect(split.live).toEqual([on]);
  });

  it("leads with what is on and folds everything that is not, in the order it came", () => {
    const off = row("paired", false);
    const on = row("paired", true);
    const nearby = row("nearby", true);
    const declined = row("declined", false);
    const split = viewRows([off, on, nearby, declined], false);
    expect(split.live).toEqual([on, nearby]);
    expect(split.folded).toEqual([off, declined]);
    expect(split.showFolded).toBe(false);
  });

  it("opens the fold when asked to, and on its own when there is nothing to lead with", () => {
    const off = row("paired", false);
    const on = row("paired", true);
    expect(viewRows([off, on], true).showFolded).toBe(true);
    // An empty list over a `1 more` is a list that has hidden all of itself.
    expect(viewRows([off], false).showFolded).toBe(true);
    expect(viewRows([], false).showFolded).toBe(true);
  });

  it("counts only the folded machines that are in trouble, not every one that is away", () => {
    const failing = row("paired", false, "bad");
    const away = row("paired", false, "idle");
    const onButBad = row("paired", true, "bad");
    const split = viewRows([failing, away, onButBad], false);
    expect(split.troubled).toBe(1);
  });

  it("counts the paired decks among the rest, whether or not they are on", () => {
    const split = viewRows([
      row("asks", true, "wait"), row("paired", true), row("paired", false), row("dialling", false), row("nearby", true),
    ], false);
    expect(split.paired).toBe(2);
  });
});
