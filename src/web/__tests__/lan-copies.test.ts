// Which copy of a login wins, driven on the module that now owns it.
//
// lan-sync.test.ts proves the outcomes — add, heal, never a third — and what a
// manifest carries, through lan-sync.mjs, which re-exports all of it; and
// lan-engine.test.ts proves a peer's duplicate rows and its cap over the wire.
// What is pinned here is the one rule those all lean on, onePerKey's order,
// spelled out case by case; what `offered` keeps of the strings a peer sent;
// and that the names lan-sync.mjs hands out are these functions and not copies
// of them.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import * as copies from "../../server/lan-copies.mjs";
// @ts-expect-error — plain .mjs server module, no types
import * as sync from "../../server/lan-sync.mjs";

const { onePerKey, slotFor, offered } = copies;

type Row = { key: string; email?: string; alive?: boolean; readable?: boolean; num?: number };

describe("one row per identity", () => {
  const row = (num: number, over: Partial<Row>): Row => ({ key: "a@@o", email: "a@x", alive: true, num, ...over });

  it("takes a live copy over an expired one, wherever it sits", () => {
    const live = row(7, {});
    const dead = row(2, { alive: false });
    expect(onePerKey([dead, live])).toEqual([live]);
    expect(onePerKey([live, dead])).toEqual([live]);
  });

  it("then one this process can read over one it cannot", () => {
    const locked = row(2, { readable: false });
    const open = row(7, {});
    expect(onePerKey([locked, open])).toEqual([open]);
    // Alive outranks readable: a live copy nobody can read still beats a
    // readable one that is dead.
    const deadOpen = row(9, { alive: false });
    expect(onePerKey([deadOpen, locked])).toEqual([locked]);
  });

  it("then the earlier slot, when nothing else tells two apart", () => {
    const first = row(2, {});
    const second = row(7, {});
    expect(onePerKey([first, second])).toEqual([first]);
    expect(onePerKey([second, first])).toEqual([second]);
  });

  it("keeps each identity once and leaves the others alone", () => {
    const b = { key: "b@@o", email: "b@x", alive: false };
    expect(onePerKey([row(1, { alive: false }), b, row(3, {})])).toEqual([row(3, {}), b]);
  });

  it("is the slot this deck answers for one identity, or null", () => {
    const rows = [row(2, { alive: false }), row(5, {}), { key: "b@@o", alive: true, num: 1 }];
    expect(slotFor(rows, "a@@o")).toEqual(row(5, {}));
    expect(slotFor(rows, "c@@o")).toBeNull();
  });
});

describe("what a peer's list keeps of the strings it sent", () => {
  it("takes out control and format characters, not just the length", () => {
    // U+202E would reverse the address drawn beside it; U+0007 would ring a
    // terminal the name is logged to.
    const [a] = offered([{ key: "k‮1\u0007@@o", email: " a​@x\n", alive: true }]);
    expect(a).toEqual({ key: "k1 @@o", email: "a@x", alive: true });
  });

  it("bounds the key and the email, in characters", () => {
    const [a] = offered([{ key: "k".repeat(400), email: "é".repeat(300), alive: true }]);
    expect([...a.key]).toHaveLength(320);
    expect([...a.email]).toHaveLength(254);
  });

  it("drops a row whose strings are nothing once cleaned, and one that is not a row", () => {
    expect(offered([{ key: "​", email: "a@x", alive: true }, null, { key: 5, email: "a" }, "x"])).toEqual([]);
    expect(offered("not a list")).toEqual([]);
  });

  it("reads alive through the stored copy's verdict, and says shareable only when it is not", () => {
    const [a, b] = offered([
      { key: "a@@o", email: "a@x", alive: false, collector: "keychain_unavailable" },
      { key: "b@@o", email: "b@x", alive: true, shareable: false },
    ]);
    expect(a).toEqual({ key: "a@@o", email: "a@x", alive: true });
    expect(b).toEqual({ key: "b@@o", email: "b@x", alive: true, shareable: false });
  });
});

describe("lan-sync.mjs", () => {
  it("hands out these functions, not copies of them", () => {
    for (const name of Object.keys(copies)) {
      expect(sync[name], name).toBe(copies[name]);
    }
  });
});
