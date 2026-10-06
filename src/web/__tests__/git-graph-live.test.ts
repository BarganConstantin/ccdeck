// A commit arriving in the open history: counted once, glowed once.
//
// The view around the list rebuilt the object carrying the new commits on
// every render — a click, an arrow key, a status answer — and the list told
// arrivals apart by that object's identity, so one commit read "2 new
// commits", then 8, 14, 20 with each key, and its row glowed again on every
// key. An arrival is now known by the commits it brought, and what had
// arrived before the list mounted is not news.
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import GitGraph, { keepReaderPlace, liveInsertKey } from "../components/GitGraph";
import { ROW_H } from "../git-graph-layout";
import { shopHistory, HISTORY_HEAD } from "./git-graph-history";
import { sourceOf } from "./client-source";

const tops = (ids: string[]) => new Map(ids.map((id, i) => [id, i * ROW_H]));

describe("an arrival of commits", () => {
  it("is known by its commits, whichever object carries them", () => {
    const a = { newShas: ["aaa", "bbb"] };
    expect(liveInsertKey(a)).toBe(liveInsertKey({ newShas: ["aaa", "bbb"] }));
    expect(liveInsertKey(a)).not.toBe(liveInsertKey({ newShas: ["aaa"] }));
    expect(liveInsertKey(null)).toBe("");
    expect(liveInsertKey({ newShas: [] })).toBe("");
  });

  it("keeps a scrolled reader on their row and counts one commit as one", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `c${i}`);
    const before = tops(["uncommitted", ...ids]);
    const after = tops(["uncommitted", "new1", ...ids]);
    expect(keepReaderPlace(before, after, ["new1"], 240)).toEqual({ scrollTop: 264, above: 1 });
  });

  it("counts only the arrivals above the reader's row, and moves nothing for one below it", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `c${i}`);
    const before = tops(ids);
    const after = tops([...ids.slice(0, 30), "late", ...ids.slice(30)]);
    expect(keepReaderPlace(before, after, ["late"], 240)).toEqual({ scrollTop: 240, above: 0 });
    const mid = tops([...ids.slice(0, 5), "x", "y", ...ids.slice(5)]);
    expect(keepReaderPlace(before, mid, ["x", "y"], 480)).toEqual({ scrollTop: 528, above: 2 });
  });
});

describe("the history mounting with an arrival already in hand", () => {
  it("does not glow commits that arrived before it was there", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const commits = shopHistory(30);
      const html = renderToStaticMarkup(createElement(GitGraph, {
        repoKey: "live-test", commits, head: { branch: "develop", detached: false, sha: HISTORY_HEAD, short: HISTORY_HEAD, unborn: false },
        uncommitted: { files: 0, byFocus: 0, label: "api-fix" }, focus: { sessionId: "s", agentIds: null },
        selected: "uncommitted", onSelect: () => {}, onOpen: () => {}, onAgentCard: () => {},
        liveInsert: { newShas: [commits[0].sha] },
      }));
      expect(html).toContain(`data-id="${commits[0].sha}"`);
      expect(html).not.toMatch(/gv-row[^"]*is-new/);
    } finally {
      quiet.mockRestore();
    }
  });
});

describe("the wiring", () => {
  const graph = sourceOf("components/GitGraph.tsx");
  const view = sourceOf("components/GitView.tsx");

  it("compares arrivals by their commits in the list, never by the object", () => {
    expect(graph).toMatch(/const liveKey = liveInsertKey\(liveInsert\);/);
    expect(graph).toMatch(/handled\.current === liveKey/);
    expect(graph).not.toMatch(/handled\.current === liveInsert|liveInsert !== settled|liveInsert === settled/);
  });

  it("hands the list one object per history read", () => {
    expect(view).toMatch(/const liveInsert = useMemo\(\(\) => \(data\.newShas\.length \? \{ newShas: data\.newShas \} : null\), \[data\.newShas\]\);/);
    expect(view).toMatch(/liveInsert=\{liveInsert\}/);
  });
});
