// Workspace split into panes (internal #102): the arrangement as a tree, the
// boxes it draws, where a drop lands, what a close and a move leave, the
// minimum a divider stops at, and what a reload keeps.
import { describe, expect, it } from "vitest";
import type { StageTarget } from "../stage-shell";
import {
  MAX_PANES, MAX_TABS, SPLIT_KEY, closeTab, emptyPaneTabs, fits, focusSplit, heldLaunches, insertPane, layoutSplit,
  loadSplit, minExtent, movePane, paneCount, paneIds, paneSessions, paneTabs, paneTarget, paneWith, parseSplit,
  promoteLaunch, pruneSplit, ratioAt, readingOrder, removePane, replaceTab, sameTab, saveSplit, serializeSplit,
  sessionPaneLinks, setRatio, singleSplit, splitOutTab, tabKey, tabWith, withFocusedTarget, zoneAt, zoneRect, type SplitState,
} from "../workspace-split";

const S = (id: string): StageTarget => ({ kind: "session", id });
const MIN = { w: 354, h: 224 };
const BOX = { x: 0, y: 0, w: 1000, h: 800 };

/** Two panes side by side: p0 (s1) left with the keys, p1 (s2) right. */
function two(): SplitState {
  const s = withFocusedTarget(singleSplit(), S("s1"));
  return insertPane(s, "p0", "right", S("s2"))!.state;
}

/** The 2×2 grid: p0 p1 on top, p2 p3 below (left and right columns cut). */
function grid(): SplitState {
  let s = two();
  s = insertPane(s, "p0", "bottom", S("s3"))!.state;
  s = insertPane(s, "p1", "bottom", S("s4"))!.state;
  return s;
}

describe("one pane is the Workspace as it was", () => {
  it("starts as one empty pane with the keys", () => {
    const s = singleSplit();
    expect(paneIds(s.root)).toEqual(["p0"]);
    expect(s.focused).toBe("p0");
    expect(paneTarget(s, "p0", null)).toEqual({ kind: "empty" });
  });

  it("is never kept: a reload of one pane is the old Workspace's", () => {
    expect(serializeSplit(withFocusedTarget(singleSplit(), S("s1")), S("s1"))).toBeNull();
    const writes: string[] = [], removes: string[] = [];
    saveSplit(singleSplit(), null, k => writes.push(k), k => removes.push(k));
    expect(writes).toEqual([]);
    expect(removes).toEqual([SPLIT_KEY]);
  });
});

describe("a drop on an edge opens a pane beside, above or below", () => {
  it("cuts the pane in two at half, the new pane on the side dropped on", () => {
    const s = two();
    expect(paneIds(s.root)).toEqual(["p0", "p1"]);
    const { panes, dividers } = layoutSplit(s.root, BOX, MIN);
    expect(panes.get("p0")).toEqual({ x: 0, y: 0, w: 500, h: 800 });
    expect(panes.get("p1")).toEqual({ x: 501, y: 0, w: 499, h: 800 });
    expect(dividers).toHaveLength(1);
    expect(dividers[0]).toMatchObject({ dir: "row", path: "", rect: { x: 500, y: 0, w: 1, h: 800 } });
  });

  it("puts a pane dropped on the left or the top before the one it cut", () => {
    const left = insertPane(withFocusedTarget(singleSplit(), S("s1")), "p0", "left", S("s2"))!;
    expect(paneIds(left.state.root)).toEqual([left.id, "p0"]);
    const top = insertPane(withFocusedTarget(singleSplit(), S("s1")), "p0", "top", S("s2"))!;
    const { panes } = layoutSplit(top.state.root, BOX, MIN);
    expect(panes.get(top.id)!.y).toBe(0);
    expect(panes.get("p0")!.y).toBeGreaterThan(300);
  });

  it("makes the 2×2 grid, and stops at four", () => {
    const s = grid();
    expect(paneCount(s)).toBe(MAX_PANES);
    const { panes } = layoutSplit(s.root, BOX, MIN);
    expect(readingOrder(panes), "1–4 count left to right, then the next row").toEqual(["p0", "p1", "p2", "p3"]);
    expect(insertPane(s, "p0", "right", S("s5")), "a fifth pane is refused").toBeNull();
  });

  it("does not hand the new pane the keys by itself", () => {
    expect(two().focused).toBe("p0");
  });

  it("never reuses an id still on screen", () => {
    let s = two();
    s = removePane(s, "p0");
    const added = insertPane(s, "p1", "left", S("s9"))!;
    expect(added.id).not.toBe("p1");
    expect(new Set(paneIds(added.state.root)).size).toBe(2);
  });
});

describe("drop zones", () => {
  const r = { x: 100, y: 100, w: 400, h: 400 };
  it("are the four edge bands and Here in the middle", () => {
    expect(zoneAt(r, 110, 300, true)).toBe("left");
    expect(zoneAt(r, 490, 300, true)).toBe("right");
    expect(zoneAt(r, 300, 110, true)).toBe("top");
    expect(zoneAt(r, 300, 490, true)).toBe("bottom");
    expect(zoneAt(r, 300, 300, true)).toBe("here");
  });

  it("are only Here once four panes are open", () => {
    expect(zoneAt(r, 110, 300, false)).toBe("here");
  });

  it("light the half a new pane would take, or the whole pane for Here", () => {
    expect(zoneRect(r, "right")).toEqual({ x: 300, y: 100, w: 200, h: 400 });
    expect(zoneRect(r, "top")).toEqual({ x: 100, y: 100, w: 400, h: 200 });
    expect(zoneRect(r, "here")).toEqual(r);
  });
});

describe("a session is in one pane at most", () => {
  it("finds the pane that has it, the pane in focus by the shell's target", () => {
    const s = two();
    expect(paneWith(s, "s2", S("s1"))).toBe("p1");
    expect(paneWith(s, "s1", S("s1"))).toBe("p0");
    expect(paneWith(s, "s7", S("s7")), "the focused pane shows what the shell shows").toBe("p0");
    expect(paneWith(s, "s1", S("s1"), "p0"), "except the pane asked about").toBeNull();
  });
});

describe("✕ closes a pane; the panes beside it take its room", () => {
  it("gives the closed pane's half to its sibling", () => {
    const s = removePane(two(), "p1");
    expect(paneIds(s.root)).toEqual(["p0"]);
    expect(layoutSplit(s.root, BOX, MIN).panes.get("p0")).toEqual(BOX);
    expect(s.targets.p1).toBeUndefined();
  });

  it("hands the keys to the pane beside it when the closed one had them", () => {
    const s = focusSplit(two(), "p1", S("s1"));
    const after = removePane(s, "p1");
    expect(after.focused).toBe("p0");
    expect(after.targets.p0, "p0 kept what it showed").toEqual(S("s1"));
  });

  it("keeps the keys where they are when another pane closes", () => {
    const s = grid();
    expect(removePane(s, "p3").focused).toBe("p0");
  });

  it("never removes the last pane: that one empties instead (the caller's)", () => {
    const s = singleSplit();
    expect(removePane(s, "p0")).toBe(s);
  });

  it("in the grid, closes one corner and keeps the other three where they were", () => {
    const s = removePane(grid(), "p2");
    const { panes } = layoutSplit(s.root, BOX, MIN);
    expect(panes.get("p0")).toEqual({ x: 0, y: 0, w: 500, h: 800 });
    expect(panes.get("p1")!.x).toBe(501);
    expect(panes.get("p3")!.y).toBeGreaterThan(300);
  });
});

describe("a pane dragged by its header moves; its id, and so its terminal, stays", () => {
  it("moves to another pane's edge", () => {
    let s = grid();
    s = movePane(s, "p3", "p0", "left");
    expect(paneIds(s.root)).toContain("p3");
    expect(paneCount(s)).toBe(4);
    expect(readingOrder(layoutSplit(s.root, BOX, MIN).panes)[0]).toBe("p3");
  });

  it("swaps with the pane dropped on Here", () => {
    const s = movePane(two(), "p1", "p0", "here");
    expect(paneIds(s.root)).toEqual(["p1", "p0"]);
    expect(s.targets.p1, "each keeps its own session").toEqual(S("s2"));
  });

  it("does nothing dropped on itself", () => {
    const s = two();
    expect(movePane(s, "p1", "p1", "left")).toBe(s);
  });
});

describe("dividers stop at 40 columns by 8 rows", () => {
  it("measures the minimum of a whole arrangement", () => {
    expect(minExtent(two().root, MIN)).toEqual({ w: 709, h: 224 });
    expect(minExtent(grid().root, MIN)).toEqual({ w: 709, h: 449 });
  });

  it("keeps a ratio off both sides' minimum", () => {
    const d = layoutSplit(two().root, BOX, MIN).dividers[0]!;
    expect(ratioAt(d, 50) * d.length).toBeGreaterThanOrEqual(MIN.w - 1);
    expect((1 - ratioAt(d, 990)) * d.length).toBeGreaterThanOrEqual(MIN.w - 1);
    expect(ratioAt(d, 600)).toBeCloseTo(600 / 999, 3);
  });

  it("draws a stored ratio that would squeeze a side at that side's minimum", () => {
    const s = setRatio(two(), "", 0.1);
    expect(layoutSplit(s.root, BOX, MIN).panes.get("p0")!.w).toBe(MIN.w);
  });

  it("says when the window is too small for the arrangement", () => {
    expect(fits(two().root, { w: 1000, h: 800 }, MIN)).toBe(true);
    expect(fits(two().root, { w: 700, h: 800 }, MIN)).toBe(false);
    expect(fits(grid().root, { w: 1000, h: 400 }, MIN)).toBe(false);
  });

  it("double-click shares the space: ratio one half", () => {
    const s = setRatio(setRatio(two(), "", 0.7), "", 0.5);
    expect(layoutSplit(s.root, BOX, MIN).panes.get("p0")!.w).toBe(500);
  });
});

describe("the keys move between panes", () => {
  it("keeps what the pane that had them showed", () => {
    const s = focusSplit(two(), "p1", S("s7"));
    expect(s.focused).toBe("p1");
    expect(s.targets.p0).toEqual(S("s7"));
  });

  it("⤢ follows the keys while one pane fills the Workspace", () => {
    const s = focusSplit({ ...two(), max: "p0" }, "p1", S("s1"));
    expect(s.max).toBe("p1");
  });

  it("names a launch a pane without the keys shows once it is a session", () => {
    let s = two();
    s = { ...s, targets: { ...s.targets, p1: { kind: "launch", agent: "claude", cwd: "/w", key: "k1" } } };
    s = promoteLaunch(s, "k1", "s9");
    expect(s.targets.p1).toEqual({ kind: "session", id: "s9", launch: "k1" });
  });
});

describe("kept per browser", () => {
  it("round-trips the arrangement with its sessions, never a launch", () => {
    let s = grid();
    const launching = { kind: "launch", agent: "codex", cwd: "/w", key: "k" } as const;
    s = { ...s, targets: { ...s.targets, p3: launching }, tabs: { ...s.tabs, p3: [launching] } };
    const raw = serializeSplit(s, S("s1"))!;
    const back = parseSplit(raw)!;
    expect(paneIds(back.root)).toEqual(paneIds(s.root));
    expect(back.targets).toEqual({ p0: S("s1"), p1: S("s2"), p2: S("s3"), p3: { kind: "empty" } });
    expect(back.focused).toBe("p0");
  });

  it("refuses anything this version did not write", () => {
    for (const raw of [null, "", "{", "[]", '{"v":2}', JSON.stringify({ v: 1, root: { kind: "leaf", id: "p0" }, panes: {}, focused: "p0" }),
      JSON.stringify({ v: 1, root: { kind: "split", dir: "row", ratio: 3, a: { kind: "leaf", id: "p0" }, b: { kind: "leaf", id: "p1" } }, panes: {} }),
      JSON.stringify({ v: 1, root: { kind: "split", dir: "row", ratio: 0.5, a: { kind: "leaf", id: "p0" }, b: { kind: "leaf", id: "p0" } }, panes: {} }),
      JSON.stringify({ v: 1, root: { kind: "split", dir: "row", ratio: 0.5, a: { kind: "leaf", id: "<img>" }, b: { kind: "leaf", id: "p1" } }, panes: {} })]) {
      expect(parseSplit(raw), String(raw)).toBeNull();
    }
  });

  it("closes the panes whose session is gone; nothing is started for them", () => {
    const s = pruneSplit(parseSplit(serializeSplit(grid(), S("s1")))!, id => id !== "s2" && id !== "s4");
    expect(paneIds(s.root)).toEqual(["p0", "p2"]);
    expect(Object.values(s.targets)).toEqual([S("s1"), S("s3")]);
  });

  it("reads and writes its one key", () => {
    const store = new Map<string, string>();
    saveSplit(two(), S("s1"), (k, v) => store.set(k, v), k => store.delete(k));
    expect([...store.keys()]).toEqual([SPLIT_KEY]);
    expect(paneIds(loadSplit(k => store.get(k) ?? null)!.root)).toEqual(["p0", "p1"]);
  });
});

describe("a pane holds tabs", () => {
  const L = (key: string): StageTarget => ({ kind: "launch", agent: "claude", cwd: "/w", key });
  /** Two columns, a third session opened in the left one (the pane in focus). */
  function third(): SplitState {
    return withFocusedTarget(two(), S("s3"));
  }

  it("opens a session as a new tab of the pane in focus: the columns and their sessions stay", () => {
    const s = third();
    expect(paneIds(s.root)).toEqual(["p0", "p1"]);
    expect(paneTabs(s, "p0", S("s3"))).toEqual([S("s1"), S("s3")]);
    expect(paneTabs(s, "p1", S("s3"))).toEqual([S("s2")]);
    expect(paneSessions(s, S("s3"))).toEqual(["s1", "s3", "s2"]);
    // The shell's target is a tab before it is written back.
    expect(paneTabs(two(), "p0", S("s3"))).toEqual([S("s1"), S("s3")]);
  });

  it("finds a session in any tab of any pane, so it is never opened twice", () => {
    const s = third();
    expect(tabWith(s, "s1", S("s3"))).toEqual({ pane: "p0", target: S("s1") });
    expect(tabWith(s, "s2", S("s3"))).toEqual({ pane: "p1", target: S("s2") });
    expect(tabWith(s, "s9", S("s3"))).toBeNull();
    expect(paneWith(s, "s1", S("s3"), "p0"), "except the pane asked about").toBeNull();
    // The original comes back as the tab it is, in its place.
    const back = withFocusedTarget(s, S("s1"));
    expect(paneTabs(back, "p0", S("s1"))).toEqual([S("s1"), S("s3")]);
    expect(back.targets.p0).toEqual(S("s1"));
  });

  it("keeps a launch's tab, and its key, once the launch is a session", () => {
    let s = withFocusedTarget(two(), L("k1"));
    expect(paneTabs(s, "p0", L("k1"))).toEqual([S("s1"), L("k1")]);
    const promoted: StageTarget = { kind: "session", id: "s5", launch: "k1" };
    s = withFocusedTarget(s, promoted);
    expect(paneTabs(s, "p0", promoted)).toEqual([S("s1"), promoted]);
    expect(tabKey(L("k1"))).toBe(tabKey(promoted));
    expect(tabKey(S("s1"))).toBe("s:s1");
    expect(sameTab(L("k1"), promoted)).toBe(true);
    expect(sameTab(S("s5"), promoted)).toBe(true);
    expect(sameTab(S("s1"), S("s2"))).toBe(false);
    expect(sameTab({ kind: "empty" }, { kind: "empty" })).toBe(false);
    // A session's tab never goes back to the launch it came from.
    expect(paneTabs(s, "p0", L("k1"))).toEqual([S("s1"), promoted]);
  });

  it("names the launches a pane holds in a tab, not the one the shell shows", () => {
    let s = withFocusedTarget(two(), L("k1"));
    s = withFocusedTarget(s, S("s1"));
    expect(heldLaunches(s, S("s1"))).toEqual(["k1"]);
    expect(heldLaunches(s, L("k1"))).toEqual([]);
    s = promoteLaunch(s, "k1", "s9");
    expect(s.tabs.p0).toEqual([S("s1"), { kind: "session", id: "s9", launch: "k1" }]);
    expect(heldLaunches(s, S("s1"))).toEqual([]);
  });

  it(`keeps ${MAX_TABS} tabs at most: the oldest one not on show leaves the strip`, () => {
    let s = withFocusedTarget(singleSplit(), S("t0"));
    for (let i = 1; i <= MAX_TABS; i++) s = withFocusedTarget(s, S(`t${i}`));
    expect(s.tabs.p0).toHaveLength(MAX_TABS);
    expect(s.tabs.p0![0]).toEqual(S("t1"));
    expect(s.tabs.p0![MAX_TABS - 1]).toEqual(S(`t${MAX_TABS}`));
    // Shown again, the oldest keeps its place; once another comes on, it goes.
    s = withFocusedTarget(s, S("t1"));
    expect(s.tabs.p0![0]).toEqual(S("t1"));
    s = withFocusedTarget(s, S("t99"));
    expect(s.tabs.p0).toHaveLength(MAX_TABS);
    expect(s.tabs.p0![0]).toEqual(S("t2"));
    expect(s.tabs.p0![MAX_TABS - 1]).toEqual(S("t99"));
  });

  it("closes a tab alone: its neighbour on the right comes on, else the one before", () => {
    let s = withFocusedTarget(third(), S("s4"));
    s = withFocusedTarget(s, S("s3"));
    // p0: s1 s3 s4, s3 on show.
    const mid = closeTab(s, "p0", S("s3"), S("s3"))!;
    expect(mid.shown).toBe(true);
    expect(mid.shows).toEqual(S("s4"));
    expect(mid.state.tabs.p0).toEqual([S("s1"), S("s4")]);
    expect(mid.state.targets.p0).toEqual(S("s4"));
    const last = closeTab(withFocusedTarget(s, S("s4")), "p0", S("s4"), S("s4"))!;
    expect(last.shows).toEqual(S("s3"));
    // A tab behind: the one on show stays.
    const behind = closeTab(s, "p0", S("s1"), S("s3"))!;
    expect(behind.shown).toBe(false);
    expect(behind.shows).toEqual(S("s3"));
    expect(behind.state.tabs.p0).toEqual([S("s3"), S("s4")]);
    expect(paneIds(behind.state.root), "the panes stay").toEqual(["p0", "p1"]);
    // A pane beside: its own tabs, the keys where they were.
    const beside = closeTab(withFocusedTarget(focusSplit(s, "p1", S("s3")), S("s7")), "p1", S("s2"), S("s7"))!;
    expect(beside.shows).toEqual(S("s7"));
    expect(beside.state.focused).toBe("p1");
  });

  it("leaves the pane's last tab to the pane's own close", () => {
    expect(closeTab(two(), "p1", S("s2"), S("s1"))).toBeNull();
    expect(closeTab(two(), "p9", S("s2"), S("s1"))).toBeNull();
    const emptied = emptyPaneTabs(third(), "p0");
    expect(emptied.tabs.p0).toEqual([]);
    expect(emptied.targets.p0).toEqual({ kind: "empty" });
    expect(paneTabs(emptied, "p0", { kind: "empty" })).toEqual([]);
    expect(emptyPaneTabs(emptied, "p9")).toBe(emptied);
  });

  it("puts Start again and a continuation in their tab's place", () => {
    let s = withFocusedTarget(third(), L("k1"));
    s = withFocusedTarget(s, S("s1"));
    // p0: s1 s3 k1.
    const again = replaceTab(s, "p0", L("k1"), L("k2"));
    expect(again.tabs.p0).toEqual([S("s1"), S("s3"), L("k2")]);
    expect(again.targets.p0).toEqual(L("k2"));
    // A continuation already held in another tab of the pane takes this one's place.
    const moved = replaceTab(s, "p0", S("s1"), S("s3"));
    expect(moved.tabs.p0).toEqual([S("s3"), L("k1")]);
    expect(replaceTab(s, "p1", S("s1"), S("s8")), "a pane without the tab").toBe(s);
  });

  it("badges every tab's session with its pane, active only the one on show in the pane in focus", () => {
    // In workspace-session-links.test.ts at large; here the 2-column example.
    expect(Object.fromEntries(sessionPaneLinks(third(), S("s3")))).toEqual({
      s1: { number: 1, active: false },
      s3: { number: 1, active: true },
      s2: { number: 2, active: false },
    });
  });

  it("keeps the tabs through a reload, never a launch", () => {
    let s = withFocusedTarget(third(), L("k1"));
    s = withFocusedTarget(s, S("s3"));
    const back = parseSplit(serializeSplit(s, S("s3")))!;
    expect(paneIds(back.root)).toEqual(["p0", "p1"]);
    expect(back.tabs).toEqual({ p0: [S("s1"), S("s3")], p1: [S("s2")] });
    expect(back.targets).toEqual({ p0: S("s3"), p1: S("s2") });
  });

  it("keeps one pane once it holds two tabs, and forgets it with one", () => {
    const one = withFocusedTarget(withFocusedTarget(singleSplit(), S("s1")), S("s2"));
    const back = parseSplit(serializeSplit(one, S("s2")))!;
    expect(paneIds(back.root)).toEqual(["p0"]);
    expect(back.tabs.p0).toEqual([S("s1"), S("s2")]);
    expect(back.targets.p0).toEqual(S("s2"));
    const closed = closeTab(one, "p0", S("s1"), S("s2"))!;
    expect(serializeSplit(closed.state, S("s2"))).toBeNull();
  });

  it("loads an arrangement kept before tabs as one tab a pane", () => {
    const old = JSON.stringify({
      v: 1,
      root: { kind: "split", dir: "row", ratio: 0.5, a: { kind: "leaf", id: "p0" }, b: { kind: "leaf", id: "p1" } },
      panes: { p0: "s1", p1: null },
      focused: "p1",
      next: 2,
    });
    const s = parseSplit(old)!;
    expect(s.targets).toEqual({ p0: S("s1"), p1: { kind: "empty" } });
    expect(s.tabs).toEqual({ p0: [S("s1")], p1: [] });
    expect(s.focused).toBe("p1");
    // One pane kept before tabs: one tab, which is not kept at all.
    expect(parseSplit(JSON.stringify({ v: 1, root: { kind: "leaf", id: "p0" }, panes: { p0: "s1" }, focused: "p0", next: 1 }))).toBeNull();
  });

  it("reads kept tabs with care: a session in one pane at most, the one on show among them", () => {
    const raw = JSON.stringify({
      v: 1,
      root: { kind: "split", dir: "row", ratio: 0.5, a: { kind: "leaf", id: "p0" }, b: { kind: "leaf", id: "p1" } },
      panes: { p0: "s1", p1: null },
      tabs: { p0: ["s2", "s2", 7, "", "s1"], p1: ["s2", "s3"] },
      focused: "p0",
      next: 2,
    });
    const s = parseSplit(raw)!;
    expect(s.tabs.p0).toEqual([S("s2"), S("s1")]);
    expect(s.tabs.p1, "s2 is p0's").toEqual([S("s3")]);
    expect(s.targets.p1, "a pane that showed a launch shows its newest tab").toEqual(S("s3"));
    const many = JSON.stringify({ v: 1, root: { kind: "leaf", id: "p0" }, panes: { p0: "a0" },
      tabs: { p0: Array.from({ length: MAX_TABS + 3 }, (_, i) => `a${i}`) }, focused: "p0", next: 1 });
    const capped = parseSplit(many)!;
    expect(capped.tabs.p0).toHaveLength(MAX_TABS);
    expect(capped.tabs.p0).toContainEqual(S("a0"));
  });

  it("lets go of the tabs whose session is gone: the neighbour comes on, a pane left with none closes", () => {
    let s = withFocusedTarget(third(), S("s4"));
    s = withFocusedTarget(s, S("s3"));
    // p0: s1 s3 s4, s3 on show; p1: s2.
    const pruned = pruneSplit(s, id => id !== "s3" && id !== "s2");
    expect(paneIds(pruned.root)).toEqual(["p0"]);
    expect(pruned.tabs.p0).toEqual([S("s1"), S("s4")]);
    expect(pruned.targets.p0).toEqual(S("s4"));
  });
});

describe("an open session dragged onto a pane's edge leaves its tabs for a pane there (internal #168)", () => {
  /** One pane, two tabs: s1 behind, s2 on show with the keys. */
  const oneWithTwo = () => withFocusedTarget(withFocusedTarget(singleSplit(), S("s1")), S("s2"));

  it("takes a tab behind out of its pane into a new pane beside: the same tab, never a second one", () => {
    const out = splitOutTab(oneWithTwo(), "s1", "p0", "right", S("s2"))!;
    expect(out.from).toBe("p0");
    expect(out.target).toEqual(S("s1"));
    expect(paneIds(out.state.root)).toEqual(["p0", out.id]);
    expect(paneTabs(out.state, "p0", null)).toEqual([S("s2")]);
    expect(paneTabs(out.state, out.id, null)).toEqual([S("s1")]);
    expect(paneSessions(out.state, null)).toEqual(["s2", "s1"]);
  });

  it("takes the tab on show out too: the pane it leaves shows its neighbour", () => {
    const out = splitOutTab(oneWithTwo(), "s2", "p0", "bottom", S("s2"))!;
    expect(paneTarget(out.state, "p0", null)).toEqual(S("s1"));
    expect(paneTabs(out.state, "p0", null)).toEqual([S("s1")]);
    expect(paneTabs(out.state, out.id, null)).toEqual([S("s2")]);
    expect(out.state.root).toMatchObject({ kind: "split", dir: "col" });
  });

  it("writes back what the pane in focus shows before it moves a tab", () => {
    // The shell shows s3 in p0; the split's own entry still names s2.
    const out = splitOutTab(oneWithTwo(), "s1", "p0", "left", S("s3"))!;
    expect(paneTabs(out.state, "p0", null)).toEqual([S("s2"), S("s3")]);
    expect(paneTarget(out.state, "p0", null)).toEqual(S("s3"));
  });

  it("goes beside another pane: the pane it left keeps its other tabs", () => {
    const s = withFocusedTarget(two(), S("s3"));
    expect(paneTabs(s, "p0", null)).toEqual([S("s1"), S("s3")]);
    const out = splitOutTab(s, "s1", "p1", "bottom", S("s3"))!;
    expect(paneIds(out.state.root)).toEqual(["p0", "p1", out.id]);
    expect(paneTabs(out.state, "p0", null)).toEqual([S("s3")]);
    expect(paneTabs(out.state, "p1", null)).toEqual([S("s2")]);
    expect(paneTabs(out.state, out.id, null)).toEqual([S("s1")]);
  });

  it("is no split for a pane's only tab, a session in no tab, or a fifth pane", () => {
    expect(splitOutTab(two(), "s2", "p0", "right", S("s1")), "its pane's only tab: that pane moves instead").toBeNull();
    expect(splitOutTab(oneWithTwo(), "s9", "p0", "right", S("s2"))).toBeNull();
    const g = withFocusedTarget(grid(), S("s5"));
    expect(paneTabs(g, "p0", null)).toEqual([S("s1"), S("s5")]);
    expect(splitOutTab(g, "s1", "p1", "right", S("s5"))).toBeNull();
  });
});
