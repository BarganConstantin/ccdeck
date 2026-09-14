// #843: the Clear dialog rendered what the server said would be destroyed as
// one run-on paragraph of up to sixty words, which the reader had to parse at
// the moment of deciding. The content was computed honestly and stays; it is
// sorted into what goes and what stays, one fact to a line.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { clearCopy, type ClearPlan } from "../clear-confirm";

const component = readFileSync(fileURLToPath(new URL("../components/ClearConfirm.tsx", import.meta.url)), "utf8");

const plan = (p: Partial<ClearPlan>): ClearPlan => ({ path: "/tmp/events.jsonl", decks: 1, mine: true, ownerPort: null, ...p });

describe("what goes and what stays, per plan (#843)", () => {
  it("unknown plan: everything goes, including the shared log, and nothing stays", () => {
    const c = clearCopy(2, null);
    expect(c.goes).toEqual([
      "all 2 agents on the canvas",
      expect.stringContaining("the event log on disk"),
      "layout, pins and selection",
    ]);
    expect(c.stays).toEqual([]);
    expect(c.final).toBe("This cannot be undone.");
  });

  it("no log kept: the canvas goes, nothing on disk changes, and nothing brings it back", () => {
    const c = clearCopy(1, plan({ path: null }));
    expect(c.goes).toEqual(["the one agent on the canvas", "layout, pins and selection"]);
    expect(c.stays).toEqual([]);
    expect(c.final).toMatch(/no event log/);
  });

  it("someone else's log: the canvas goes, the log stays, and it can come back", () => {
    const c = clearCopy(3, plan({ mine: false, decks: 3, ownerPort: 4318 }));
    expect(c.goes.join(" ")).not.toMatch(/event log/);
    expect(c.stays).toEqual([
      "the event log — the deck on port 4318 owns that file, one of 3 decks sharing it",
      "restart this deck and the log replays back onto it",
    ]);
    expect(c.final).toBeNull();
    expect(c.confirm).toBe("Clear this canvas");
  });

  it("this deck's own log: the log goes with the canvas", () => {
    const c = clearCopy(4, plan({}));
    expect(c.goes[1]).toMatch(/^this deck's event log/);
    expect(c.stays).toEqual([]);
  });

  it("a shared log it owns: the other decks keep their canvas only until they restart", () => {
    const c = clearCopy(4, plan({ decks: 3 }));
    expect(c.goes[1]).toMatch(/2 other running decks share with this one — every session recorded in it/);
    expect(c.stays).toEqual(["what those decks show, until they restart — then it is gone there too"]);
    expect(c.final).toBe("This cannot be undone.");
  });

  it("drops the canvas line when there is nothing on it", () => {
    expect(clearCopy(0, plan({})).goes[0]).toMatch(/^this deck's event log/);
  });

  it("keeps every line short enough to read at once", () => {
    const all = [null, plan({ path: null }), plan({ mine: false, decks: 5, ownerPort: 1 }), plan({}), plan({ decks: 4 })]
      .flatMap(p => { const c = clearCopy(12, p); return [...c.goes, ...c.stays]; });
    // The old paragraph ran to sixty words. A line here is one fact.
    for (const line of all) expect(line.split(/\s+/).length, line).toBeLessThanOrEqual(34);
  });
});

describe("the dialog lays them out as labelled groups (#843)", () => {
  it("renders Goes and Stays as a definition list, not one paragraph", () => {
    expect(component).toMatch(/<dl className="cc-plan">/);
    expect(component).toMatch(/<dt>Goes<\/dt>/);
    expect(component).toMatch(/<dt>Stays<\/dt>/);
    expect(component).not.toMatch(/\{note\}/);
  });

  it("says nothing stays when nothing does, rather than leaving the line empty", () => {
    expect(component).toContain("stays.length > 0 ? stays.map(");
    expect(component).toContain("<span>nothing</span>");
  });
});
