// The Local network view's fold, asked what it does.
//
// The view draws the requests first and on their own, then the machines that
// are on, then — behind one control that counts them — every machine that is
// not. That split was written inline in LanSyncSection.tsx, where the suite
// could only read it; it is viewRows in lan-roster.ts now, and these call it.
import { describe, it, expect } from "vitest";

import { type DeckRow, FOLD_AT, viewRows } from "../lan-roster";

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
    // CHANGED ON PURPOSE (V4's Figma): the decks that are not on are rows like
    // the others, so a short list has no fold at all (the next test pins that).
    // What this test guards is the order and the fold of a LONG list, so it
    // is given one: more decks than FOLD_AT, as it always meant.
    const off = row("paired", false);
    const on = row("paired", true);
    const nearby = row("nearby", true);
    const declined = row("declined", false);
    const filler = Array.from({ length: FOLD_AT }, () => row("paired", false));
    const rows = [off, on, nearby, declined, ...filler];
    const split = viewRows(rows, false);
    expect(split.live).toEqual([on, nearby]);
    expect(split.folded).toEqual([off, declined, ...filler]);
    expect(split.showFolded).toBe(false);
    expect(split.foldable).toBe(true);
    expect(split.shown).toEqual([on, nearby]);
    // Open, the folded ones come after the ones that are on, never among them.
    expect(viewRows(rows, true).shown).toEqual([on, nearby, off, declined, ...filler]);
  });

  it("draws a short list in full, offline decks and all, with no fold to open", () => {
    // V4's Figma draws the offline decks as rows like any other, in the same
    // order: the ones that are on first, then the rest.
    const off = row("paired", false);
    const on = row("paired", true);
    const nearby = row("nearby", true);
    const declined = row("declined", false);
    const split = viewRows([off, on, nearby, declined], false);
    expect(split.showFolded).toBe(true);
    expect(split.foldable).toBe(false);
    expect(split.shown).toEqual([on, nearby, off, declined]);
    // The fold appears with the seventh deck, not before.
    const six = Array.from({ length: FOLD_AT }, (_, i) => row("paired", i === 0));
    expect(viewRows(six, false).foldable).toBe(false);
    expect(viewRows([...six, row("paired", false)], false).foldable).toBe(true);
  });

  it("does not flip between rows and a fold when a nearby deck's beacon comes and goes", () => {
    // Only paired decks count toward the fold. A nearby deck is heard and not
    // heard from one poll to the next, and counting it put the list on either
    // side of the line every time.
    const paired = Array.from({ length: FOLD_AT }, (_, i) => row("paired", i % 2 === 0));
    const heard = [...paired, row("nearby", true)];
    const gone = [...paired, row("nearby", false)];
    const absent = paired;
    for (const rows of [heard, gone, absent]) {
      const split = viewRows(rows, false);
      expect(split.foldable).toBe(false);
      expect(split.shown).toHaveLength(rows.length);
    }
    // Pairing a seventh deck is what puts the fold up, and it stays up.
    const seven = [...paired, row("paired", false)];
    for (const extra of [[], [row("nearby", true)], [row("nearby", false)]]) {
      expect(viewRows([...seven, ...extra], false).foldable).toBe(true);
    }
  });

  it("opens the fold when asked to, and on its own when there is nothing to lead with", () => {
    const off = row("paired", false);
    const on = row("paired", true);
    expect(viewRows([off, on], true).showFolded).toBe(true);
    // An empty list over a `1 more` is a list that has hidden all of itself.
    expect(viewRows([off], false).showFolded).toBe(true);
    expect(viewRows([off], false).shown).toEqual([off]);
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
