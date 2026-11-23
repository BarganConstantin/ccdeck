// Hide from list, the rules (list-hidden.ts): which rows can be hidden, the
// marks kept for them, how a row comes back by itself when its session works
// again, and what storage holds. The list that draws them is
// list-hidden-session-list.test.ts.
import { describe, expect, it } from "vitest";
import {
  LIST_HIDDEN_CAP, LIST_HIDDEN_KEY, canHideRow, focusAfterLeaving, hiddenLifted, hideSince, prunedHidden,
  readListHidden, saveListHidden, sessionsLastWorked, withHidden, withoutHidden, type HiddenMarks, type HiddenWorker,
} from "../list-hidden";
import type { RailGroup } from "../rail-model";

/** A session's main agent, which last worked at `at` (its last prompt). */
const root = (id: string, at: number, extra: Partial<HiddenWorker> = {}): HiddenWorker =>
  ({ id, sessionId: id, kind: "root", startedAt: 0, tools: [], prompts: [{ at }], ...extra }) as HiddenWorker;

function fakeStore(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => { data.set(k, String(v)); },
  };
}

const marks = (...pairs: Array<[string, number]>): HiddenMarks => new Map(pairs);

describe("what can be hidden", () => {
  it("is a row that wants nothing now: Done · new, Done and Ready", () => {
    expect(([0, 1, 2, 3, 4] as RailGroup[]).map(canHideRow)).toEqual([false, true, false, true, true]);
  });
});

describe("hiding and showing", () => {
  it("adds a hidden row as the newest, and moves one hidden again to the end", () => {
    let m = withHidden(new Map(), "a", 10);
    m = withHidden(m, "b", 20);
    expect([...m]).toEqual([["a", 10], ["b", 20]]);
    m = withHidden(m, "a", 30);
    expect([...m]).toEqual([["b", 20], ["a", 30]]);
  });

  it("shows rows again, and hands back the same map when none of them was hidden", () => {
    const m = marks(["a", 1], ["b", 2], ["c", 3]);
    expect([...withoutHidden(m, ["b", "c"])]).toEqual([["a", 1]]);
    expect(withoutHidden(m, ["x"])).toBe(m);
    expect(withoutHidden(m, [])).toBe(m);
  });

  it("keeps at most the cap, dropping the oldest", () => {
    let m: HiddenMarks = new Map();
    for (let i = 0; i < LIST_HIDDEN_CAP + 5; i++) m = withHidden(m, `s${i}`, i);
    expect(m.size).toBe(LIST_HIDDEN_CAP);
    expect(m.has("s0")).toBe(false);
    expect(m.has("s4")).toBe(false);
    expect(m.has("s5")).toBe(true);
    expect([...m.keys()].at(-1)).toBe(`s${LIST_HIDDEN_CAP + 4}`);
  });
});

describe("when a hidden row comes back by itself", () => {
  const groups = (g: Record<string, RailGroup>) => (id: string) => g[id];

  it("counts work from the newer of the session's last work and the press", () => {
    // The page's clock is ahead: the press is the stamp.
    expect(hideSince([root("a", 100)], "a", 500)).toBe(500);
    // The server's stamp is ahead of the page's (a phone whose clock runs
    // behind): the session's own last work is the stamp.
    expect(hideSince([root("a", 900)], "a", 500)).toBe(900);
    // A session with no work at all yet (Ready).
    expect(hideSince([], "a", 500)).toBe(500);
  });

  it("comes back when its session works after the hide, and only then", () => {
    const m = marks(["a", 500], ["b", 500]);
    const g = groups({ a: 3, b: 3 });
    expect(hiddenLifted(m, g, [root("a", 400), root("b", 500)])).toEqual([]);
    expect(hiddenLifted(m, g, [root("a", 501), root("b", 500)])).toEqual(["a"]);
  });

  it("counts every kind of work: a tool call, a block of output, a subagent's start", () => {
    const m = marks(["a", 500]);
    const g = groups({ a: 3 });
    expect(hiddenLifted(m, g, [root("a", 0, { tools: [{ startedAt: 600 }] })])).toEqual(["a"]);
    expect(hiddenLifted(m, g, [root("a", 0, { lastOutputAt: 600 })])).toEqual(["a"]);
    const sub = { id: "a-sub", sessionId: "a", kind: "subagent", startedAt: 600, tools: [], prompts: [] } as HiddenWorker;
    expect(hiddenLifted(m, g, [root("a", 0), sub])).toEqual(["a"]);
  });

  it("comes back when its row is working or needs you, whatever the clocks say", () => {
    const m = marks(["a", 10_000], ["b", 10_000], ["c", 10_000]);
    expect(hiddenLifted(m, groups({ a: 2, b: 0, c: 4 }), [root("a", 0), root("b", 0), root("c", 0)])).toEqual(["a", "b"]);
  });

  it("leaves a mark whose session has no row to the pruning", () => {
    expect(hiddenLifted(marks(["gone", 0]), () => undefined, [root("gone", 99)])).toEqual([]);
  });

  it("reads a session's work from all its agents, and only the sessions asked", () => {
    const sub = { id: "a-sub", sessionId: "a", kind: "subagent", startedAt: 0, tools: [{ startedAt: 70 }], prompts: [] } as HiddenWorker;
    const worked = sessionsLastWorked([root("a", 50), sub, root("b", 90)], new Set(["a"]));
    expect([...worked]).toEqual([["a", 70]]);
  });
});

describe("what storage keeps", () => {
  it("round-trips, under its own agent-dag key, oldest first", () => {
    const store = fakeStore();
    saveListHidden(store, marks(["a", 1], ["b", 2]));
    expect(LIST_HIDDEN_KEY).toBe("agent-dag.listHidden");
    expect(store.data.get(LIST_HIDDEN_KEY)).toBe('[["a",1],["b",2]]');
    expect([...readListHidden(store)]).toEqual([["a", 1], ["b", 2]]);
  });

  it("reads nothing hidden from a store that is missing, blocked, or holds anything else", () => {
    expect(readListHidden(null).size).toBe(0);
    expect(readListHidden(fakeStore()).size).toBe(0);
    for (const bad of ["{", "null", "42", '{"a":1}', '"a"']) {
      expect(readListHidden(fakeStore({ [LIST_HIDDEN_KEY]: bad })).size, bad).toBe(0);
    }
    const throwing = { getItem: () => { throw new Error("SecurityError"); } };
    expect(readListHidden(throwing).size).toBe(0);
  });

  it("skips the entries it cannot read and keeps the rest, a repeated id at its newest place", () => {
    const raw = JSON.stringify([["a", 1], ["", 2], [3, 4], ["b"], ["c", "x"], ["d", null], "e", ["b", 5], ["a", 6]]);
    expect([...readListHidden(fakeStore({ [LIST_HIDDEN_KEY]: raw }))]).toEqual([["b", 5], ["a", 6]]);
  });

  it("keeps at most the cap from what it reads, the newest", () => {
    const raw = JSON.stringify(Array.from({ length: LIST_HIDDEN_CAP + 3 }, (_, i) => [`s${i}`, i]));
    const m = readListHidden(fakeStore({ [LIST_HIDDEN_KEY]: raw }));
    expect(m.size).toBe(LIST_HIDDEN_CAP);
    expect([...m.keys()][0]).toBe("s3");
  });

  it("never throws on a store that refuses the write", () => {
    const full = { setItem: () => { throw new Error("QuotaExceededError"); } };
    expect(() => saveListHidden(full, marks(["a", 1]))).not.toThrow();
    expect(() => saveListHidden(null, marks(["a", 1]))).not.toThrow();
  });

  it("prunes the sessions the deck no longer knows, and hands back the same map when it knows them all", () => {
    const m = marks(["a", 1], ["gone", 2], ["b", 3]);
    expect([...prunedHidden(m, id => id !== "gone")]).toEqual([["a", 1], ["b", 3]]);
    expect(prunedHidden(m, () => true)).toBe(m);
  });
});

describe("where focus goes when a row leaves", () => {
  it("to the next row, else the one before, else nowhere (the list's heading)", () => {
    expect(focusAfterLeaving(["a", "b", "c"], "b")).toBe("c");
    expect(focusAfterLeaving(["a", "b", "c"], "c")).toBe("b");
    expect(focusAfterLeaving(["a"], "a")).toBeNull();
  });
});
