// A session whose pin comes off keeps the grace a finished session gets
// (list-pinned.ts sweepKeeps), so the board's next tick does not take it the
// moment it is unpinned; once the grace is over it counts like any other.
import { describe, it, expect } from "vitest";
import { LIST_PINNED_KEY, LIST_UNPINNED_KEY, noteUnpinned, sweepKeeps } from "../list-pinned";
import { DONE_SESSION_GRACE_MS } from "../board-limits";

function memoryStore(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    raw: (key: string) => data.get(key),
  };
}

const T0 = 1_000_000;

describe("an unpinned session and the board's sweep", () => {
  it("keeps every pinned session", () => {
    const store = memoryStore({ [LIST_PINNED_KEY]: JSON.stringify(["a", "b"]) });
    expect([...sweepKeeps(store, T0)].sort()).toEqual(["a", "b"]);
  });

  it("keeps a session for the grace after its pin comes off, then lets it go", () => {
    const store = memoryStore();
    noteUnpinned(store, "a", T0);
    expect(sweepKeeps(store, T0).has("a")).toBe(true);
    expect(sweepKeeps(store, T0 + DONE_SESSION_GRACE_MS).has("a"), "still inside the grace").toBe(true);
    expect(sweepKeeps(store, T0 + DONE_SESSION_GRACE_MS + 1).has("a"), "past it").toBe(false);
  });

  it("starts the grace again when the same session is unpinned again", () => {
    const store = memoryStore();
    noteUnpinned(store, "a", T0);
    noteUnpinned(store, "a", T0 + DONE_SESSION_GRACE_MS);
    expect(sweepKeeps(store, T0 + DONE_SESSION_GRACE_MS + 1_000).has("a")).toBe(true);
  });

  it("drops the times that ran out when it writes a new one, so the store stays small", () => {
    const store = memoryStore();
    noteUnpinned(store, "old", T0);
    noteUnpinned(store, "new", T0 + DONE_SESSION_GRACE_MS + 1);
    expect(Object.keys(JSON.parse(store.raw(LIST_UNPINNED_KEY)!))).toEqual(["new"]);
  });

  it("reads a missing, blocked or broken store as nothing kept", () => {
    expect(sweepKeeps(null, T0).size).toBe(0);
    expect(sweepKeeps(memoryStore({ [LIST_UNPINNED_KEY]: "{not json" }), T0).size).toBe(0);
    expect(sweepKeeps(memoryStore({ [LIST_UNPINNED_KEY]: "[1,2]" }), T0).size).toBe(0);
    const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(() => noteUnpinned(throwing, "a", T0)).not.toThrow();
    expect(sweepKeeps(throwing, T0).size).toBe(0);
  });
});
