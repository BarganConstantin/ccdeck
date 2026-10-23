// The asks run — use-asks.ts: the waiting sessions answered one after another
// from the terminal stage.
//
// The rule that matters most is one no screenshot shows: THE RUN NEVER MOVES
// BY ITSELF. A permission prompt is answered with a bare `1`, so a stage that
// carried you to the next session the moment you answered this one would aim
// your next keystroke at a prompt you have not read. Every case below that
// answers an ask also checks nobody was switched to.
//
// The reducer is called as it ships; the hook runs on fake-react.ts's React,
// with fake timers for the arrival note's eight seconds and the clear line's
// three.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async () => (await import("./fake-react")).react);

const { mount } = await import("./fake-react");
const {
  ARRIVAL_NOTE_MS, ASKS_CLEAR_MS, asksReducer, asksView, firstOpenAsk, initialAsks, nextAskId, nextDeadline,
  NO_MORE_ASKS, useAsks,
} = await import("../use-asks");
type AsksState = import("../use-asks").AsksState;
type AsksDeps = import("../use-asks").AsksDeps;
type Asks = import("../use-asks").Asks;

/** Waiting sessions, oldest first, each named after its id. */
const waiting = (...ids: string[]) => ids.map(id => ({ id, label: id.toUpperCase() }));

/** A look at the list, the stage and the session on it. */
function look(state: AsksState, ids: string[], o: { stageOpen?: boolean; current?: string | null; now?: number } = {}) {
  return asksReducer(state, {
    type: "observe", waiting: waiting(...ids), stageOpen: o.stageOpen ?? true, current: o.current ?? null, now: o.now ?? 1000,
  });
}

/** A deck that has looked once at `ids` with the stage open, then started a run. */
function running(...ids: string[]) {
  const seen = look(initialAsks(), ids);
  return asksReducer(seen, { type: "start", waiting: waiting(...ids) });
}

describe("a run starts from the waiting list as the chip counts it", () => {
  it("takes the first look as what is already waiting, not as news", () => {
    const s = look(initialAsks(), ["a", "b"]);
    expect(s.run).toBeNull();
    expect(s.arrival).toBeNull();
    expect(s.said, "a deck that opens on a waiting machine announced arrivals").toBe("");
  });

  it("visits the waiting sessions oldest first, from the first", () => {
    const s = running("a", "b", "c");
    expect(s.run!.ids).toEqual(["a", "b", "c"]);
    expect(s.run!.done).toEqual([]);
    expect(firstOpenAsk(s.run)).toBe("a");
  });

  it("does nothing with nothing waiting, and continues a run already going", () => {
    const empty = look(initialAsks(), []);
    expect(asksReducer(empty, { type: "start", waiting: [] })).toBe(empty);
    const s = running("a", "b");
    expect(asksReducer(s, { type: "start", waiting: waiting("b", "c") })).toBe(s);
  });
});

describe("an ask is answered when its session stops waiting", () => {
  it("marks it done and says it resumed, by the name it had while waiting", () => {
    const s = look(running("a", "b"), ["b"], { current: "a" });
    expect(s.run!.done).toEqual(["a"]);
    expect(s.said).toBe("A resumed.");
  });

  it("offers the next ask where the eyes are: '✓ A resumed', 'Next ask B'", () => {
    const s = look(running("a", "b"), ["b"], { current: "a" });
    const view = asksView(s, "a");
    expect(view.resumed).toEqual({ id: "a", label: "A" });
    expect(view.next).toEqual({ id: "b", label: "B" });
    expect(view.position).toBeNull();
    expect(view.track.map(t => t.state)).toEqual(["done", "todo"]);
  });

  it("says 'No more asks' with the last one, and leaves the bar 3.2 seconds later", () => {
    const one = look(running("a", "b"), ["b"], { now: 1000 });
    const all = look(one, [], { current: "b", now: 2000 });
    expect(all.said).toBe(`B resumed. ${NO_MORE_ASKS}`);
    expect(asksView(all, "b").clear).toBe(true);
    expect(all.run!.endsAt).toBe(2000 + ASKS_CLEAR_MS);
    expect(nextDeadline(all)).toBe(2000 + ASKS_CLEAR_MS);
    expect(asksReducer(all, { type: "expire", now: 2000 + ASKS_CLEAR_MS - 1 })).toBe(all);
    expect(asksReducer(all, { type: "expire", now: 2000 + ASKS_CLEAR_MS }).run).toBeNull();
  });

  it("is quiet when a look finds nothing new — the same state, so nothing renders", () => {
    const s = look(running("a", "b"), ["a", "b"]);
    expect(look(s, ["a", "b"])).toBe(s);
    expect(asksReducer(s, { type: "expire", now: 99_999 })).toBe(s);
  });
});

describe("an ask that arrives", () => {
  it("is one more segment during a run, said once, and growing in", () => {
    const s = look(running("a", "b"), ["a", "b", "c"], { current: "a" });
    expect(s.run!.ids).toEqual(["a", "b", "c"]);
    expect(s.run!.fresh).toBe("c");
    expect(s.said).toBe("C is waiting on you.");
    expect(asksView(s, "a").track.map(t => [t.id, t.fresh])).toEqual([["a", false], ["b", false], ["c", true]]);
    expect(asksView(s, "a").position, "1 of 3").toEqual({ index: 1, total: 3 });
  });

  it("brings back a run that had just said 'No more asks'", () => {
    const all = look(look(running("a"), [], { now: 1000 }), ["z"], { now: 2000 });
    expect(all.run!.ids).toEqual(["a", "z"]);
    expect(all.run!.endsAt, "the run would leave the bar with an ask open").toBeNull();
    expect(asksView(all, "a").clear).toBe(false);
  });

  it("reopens the segment of a session that asks again", () => {
    const answered = look(running("a", "b"), ["b"]);
    const again = look(answered, ["b", "a"]);
    expect(again.run!.ids).toEqual(["a", "b"]);
    expect(again.run!.done).toEqual([]);
    expect(again.run!.fresh).toBe("a");
  });

  it("with the stage open and no run, is a note in the bar for eight seconds", () => {
    const seen = look(initialAsks(), ["a"], { current: "a" });
    const s = look(seen, ["a", "t"], { current: "a", now: 5000 });
    expect(s.arrival).toEqual({ id: "t", label: "T", until: 5000 + ARRIVAL_NOTE_MS });
    expect(s.said).toBe("T is waiting on you.");
    expect(asksView(s, "a").arrival?.id).toBe("t");
    expect(asksReducer(s, { type: "expire", now: 5000 + ARRIVAL_NOTE_MS - 1 }).arrival).not.toBeNull();
    expect(asksReducer(s, { type: "expire", now: 5000 + ARRIVAL_NOTE_MS }).arrival).toBeNull();
  });

  it("names the newest of several in the note, and every one aloud", () => {
    const seen = look(initialAsks(), []);
    const s = look(seen, ["p", "q"], { current: "a" });
    expect(s.arrival?.id).toBe("q");
    expect(s.said).toBe("P is waiting on you. Q is waiting on you.");
  });

  it("is no note for the session already on the stage, nor with the stage closed", () => {
    const seen = look(initialAsks(), []);
    expect(look(seen, ["a"], { current: "a" }).arrival).toBeNull();
    const closed = look(initialAsks(), [], { stageOpen: false });
    const s = look(closed, ["a"], { stageOpen: false });
    expect(s.arrival).toBeNull();
    expect(s.said, "the topbar's own announcement covers a closed stage").toBe("");
  });

  it("goes when its session stops waiting, when you go to it, or when a run starts", () => {
    const seen = look(initialAsks(), []);
    const noted = look(seen, ["t"], { current: "a" });
    expect(look(noted, [], { current: "a" }).arrival).toBeNull();
    expect(look(noted, ["t"], { current: "t" }).arrival).toBeNull();
    expect(asksReducer(noted, { type: "start", waiting: waiting("t") }).arrival).toBeNull();
    expect(asksReducer(noted, { type: "take-arrival" }).arrival).toBeNull();
  });
});

describe("where Next ask goes", () => {
  it("to the ask the bar is naming, first", () => {
    const seen = look(initialAsks(), []);
    expect(nextAskId(look(seen, ["t"], { current: "a" }), "a")).toBe("t");
  });

  it("to the run's next open ask that is not on the stage, skipping the answered", () => {
    const s = look(running("a", "b", "c"), ["b", "c"]);
    expect(nextAskId(s, "b")).toBe("c");
    expect(nextAskId(s, "x")).toBe("b");
    expect(nextAskId(look(s, ["b"]), "b")).toBeNull();
  });

  it("nowhere when there is no run — starting one is the caller's", () => {
    expect(nextAskId(look(initialAsks(), ["a"]), null)).toBeNull();
  });
});

describe("closing the stage", () => {
  it("ends the run and the note, which belonged to that visit", () => {
    const s = look(running("a", "b"), ["a", "b"], { stageOpen: false });
    expect(s.run).toBeNull();
  });

  it("does not end a run the chip started before the stage had opened", () => {
    const closed = look(initialAsks(), ["a", "b"], { stageOpen: false });
    const started = asksReducer(closed, { type: "start", waiting: waiting("a", "b") });
    expect(look(started, ["a", "b"], { stageOpen: false }).run, "a run killed on its way to the stage").not.toBeNull();
    expect(look(started, ["a", "b"], { stageOpen: true }).run).not.toBeNull();
  });
});

describe("useAsks, the thin part", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); });
  afterEach(() => { vi.useRealTimers(); });

  function deck(props: Partial<AsksDeps> = {}) {
    const switchTo = vi.fn();
    let shown: AsksDeps = { waitingSessions: waiting("a", "b"), stageOpen: false, currentId: null, switchTo, ...props };
    const m = mount((p: AsksDeps) => useAsks(p), shown);
    return {
      switchTo,
      get asks() { return m.tree as Asks; },
      set(next: Partial<AsksDeps>) { shown = { ...shown, ...next }; m.rerender(shown); },
    };
  }

  it("starts at the oldest waiting session, with the keys in its pane", () => {
    const d = deck();
    d.asks.startAsks();
    expect(d.switchTo.mock.calls).toEqual([["a", { focusPane: true }]]);
  });

  it("starts nothing, and switches nowhere, with nothing waiting", () => {
    const d = deck({ waitingSessions: [] });
    d.asks.startAsks();
    d.asks.nextAsk();
    expect(d.switchTo).not.toHaveBeenCalled();
  });

  it("never moves on by itself when the ask on the stage is answered", () => {
    const d = deck();
    d.asks.startAsks();
    d.set({ stageOpen: true, currentId: "a" });
    d.set({ waitingSessions: waiting("b") });
    vi.advanceTimersByTime(60_000);
    expect(d.switchTo, "the run switched sessions under the reader's hands").toHaveBeenCalledTimes(1);
    expect(d.asks.said).toBe("A resumed.");
    expect(d.asks.view.resumed?.id).toBe("a");
    expect(d.asks.view.next?.id).toBe("b");
  });

  it("goes to the next ask only when asked, and says 'No more asks' after the last", () => {
    const d = deck();
    d.asks.startAsks();
    d.set({ stageOpen: true, currentId: "a" });
    d.set({ waitingSessions: waiting("b") });
    d.asks.nextAsk();
    expect(d.switchTo.mock.calls[1]).toEqual(["b", { focusPane: true }]);
    d.set({ currentId: "b" });
    d.set({ waitingSessions: [] });
    expect(d.asks.said).toBe(`B resumed. ${NO_MORE_ASKS}`);
    expect(d.asks.view.clear).toBe(true);
    vi.advanceTimersByTime(ASKS_CLEAR_MS);
    expect(d.asks.view.track, "the track stayed after the clear line").toEqual([]);
  });

  it("starts a run on n when none is going", () => {
    const d = deck({ stageOpen: true, currentId: "x" });
    d.asks.nextAsk();
    expect(d.switchTo.mock.calls).toEqual([["a", { focusPane: true }]]);
    expect(d.asks.view.track.map(t => t.id)).toEqual(["a", "b"]);
  });

  it("takes n to the ask the bar names, and the note away with it", () => {
    const d = deck({ waitingSessions: [], stageOpen: true, currentId: "x" });
    d.set({ waitingSessions: waiting("t") });
    expect(d.asks.view.arrival?.id).toBe("t");
    expect(d.asks.said).toBe("T is waiting on you.");
    d.asks.nextAsk();
    expect(d.switchTo.mock.calls).toEqual([["t", { focusPane: true }]]);
    expect(d.asks.view.arrival).toBeNull();
  });

  it("lets the note go after eight seconds, to the chip that keeps counting", () => {
    const d = deck({ waitingSessions: [], stageOpen: true, currentId: "x" });
    d.set({ waitingSessions: waiting("t") });
    vi.advanceTimersByTime(ARRIVAL_NOTE_MS - 1);
    expect(d.asks.view.arrival).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(d.asks.view.arrival).toBeNull();
    expect(d.switchTo).not.toHaveBeenCalled();
  });

  it("does not look again for a list rebuilt with the same sessions", () => {
    const d = deck({ stageOpen: true, currentId: "x" });
    const before = d.asks.view;
    d.set({ waitingSessions: waiting("a", "b") });
    expect(d.asks.view).toEqual(before);
    expect(d.asks.said).toBe("");
  });
});
