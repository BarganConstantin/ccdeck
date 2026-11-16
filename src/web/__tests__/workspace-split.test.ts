// Workspace split into panes (internal #102): the arrangement as a tree, the
// boxes it draws, where a drop lands, what a close and a move leave, the
// minimum a divider stops at, and what a reload keeps.
import { describe, expect, it } from "vitest";
import type { StageTarget } from "../stage-shell";
import {
  MAX_PANES, SPLIT_KEY, fits, focusSplit, insertPane, layoutSplit, loadSplit, minExtent, movePane, paneCount, paneIds,
  paneTarget, paneWith, parseSplit, promoteLaunch, pruneSplit, ratioAt, readingOrder, removePane, saveSplit,
  serializeSplit, setRatio, singleSplit, withFocusedTarget, zoneAt, zoneRect, type SplitState,
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
    s = { ...s, targets: { ...s.targets, p3: { kind: "launch", agent: "codex", cwd: "/w", key: "k" } } };
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
