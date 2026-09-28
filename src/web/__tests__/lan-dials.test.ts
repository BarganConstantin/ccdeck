// The addresses a deck dials that the beacon did not hand it, driven on their
// own.
//
// lan-engine.test.ts drives the list through whole engines — two hundred
// beacons against the cap, a caller dialled back and given up on, a settings
// write replacing the list. What is pinned here is each rule the list keeps,
// with no socket in sight: which addresses are rows at all, who is capped and
// who is evicted, what a typed row outranks, and how a dial-back is tried.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { createDials, MAX_AUTO_PEERS } from "../../server/lan-dials.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { MAX_AUTO_PEERS as FROM_ENGINE } from "../../server/lan-engine.mjs";

type Row = { fp: string; name: string; addr: string; port: number; manual: true; typed: boolean };

describe("a row on the list", () => {
  it("is an address and a port, trimmed, keyed host:port", () => {
    const d = createDials();
    expect(d.add(" 10.0.0.5 ", "4800")).toBe(true);
    expect(d.rows()).toEqual([{ fp: "manual:10.0.0.5:4800", name: "10.0.0.5", addr: "10.0.0.5", port: 4800, manual: true, typed: true }]);
    // The same address again is the same row.
    expect(d.add("10.0.0.5", 4800)).toBe(true);
    expect(d.rows()).toHaveLength(1);
  });

  it("is never stored for something that can never connect", () => {
    const d = createDials();
    for (const [addr, port] of [["", 4800], ["  ", 4800], [null, 4800], ["10.0.0.5", 0], ["10.0.0.5", 65_536], ["10.0.0.5", 1.5], ["10.0.0.5", "x"]]) {
      expect(d.add(addr, port), `${addr}:${port}`).toBe(false);
    }
    expect(d.rows()).toEqual([]);
  });

  it("comes off by the address it was put on with", () => {
    const d = createDials();
    d.add("10.0.0.5", 4800);
    expect(d.remove(" 10.0.0.5", "4800")).toBe(true);
    expect(d.remove("10.0.0.5", 4800)).toBe(false);
  });
});

describe("a row a person typed", () => {
  it("outranks one the deck added, whichever came first", () => {
    const d = createDials();
    d.add("10.0.0.5", 4800, { typed: false });
    expect((d.rows() as Row[])[0].typed).toBe(false);
    d.add("10.0.0.5", 4800);
    expect((d.rows() as Row[])[0].typed).toBe(true);
    // And the next beacon does not undo the person's vouching for it.
    d.add("10.0.0.5", 4800, { typed: false });
    expect((d.rows() as Row[])[0].typed).toBe(true);
  });

  it("is never capped", () => {
    const d = createDials();
    for (let p = 0; p < MAX_AUTO_PEERS + 10; p++) expect(d.add("10.0.0.5", 40_000 + p)).toBe(true);
    expect(d.rows()).toHaveLength(MAX_AUTO_PEERS + 10);
  });
});

describe("the rows the deck added itself", () => {
  it(`stop at ${MAX_AUTO_PEERS}, the number the engine exports`, () => {
    expect(FROM_ENGINE).toBe(MAX_AUTO_PEERS);
  });

  it("make room by dropping the oldest that never answered", () => {
    const d = createDials();
    for (let p = 0; p < MAX_AUTO_PEERS; p++) d.add("10.0.0.5", 40_000 + p, { typed: false });
    // The first one answered once, so it is not the one to go.
    d.answered("10.0.0.5:40000", { fp: "fp-a", name: "A" });
    expect(d.add("10.0.0.9", 50_000, { typed: false })).toBe(true);
    const at = (d.rows() as Row[]).map(r => `${r.addr}:${r.port}`);
    expect(at).toHaveLength(MAX_AUTO_PEERS);
    expect(at).toContain("10.0.0.5:40000");
    expect(at).not.toContain("10.0.0.5:40001");
    expect(at.at(-1)).toBe("10.0.0.9:50000");
  });

  it("refuse a new one when every one of them has answered", () => {
    const d = createDials();
    for (let p = 0; p < MAX_AUTO_PEERS; p++) {
      d.add("10.0.0.5", 40_000 + p, { typed: false });
      d.meet(`10.0.0.5:${40_000 + p}`, { fp: `fp-${p}`, name: "" });
    }
    expect(d.add("10.0.0.9", 50_000, { typed: false })).toBe(false);
    // An address already on the list is not a new row, and a typed one is
    // never the deck's to refuse.
    expect(d.add("10.0.0.5", 40_000, { typed: false })).toBe(true);
    expect(d.add("10.0.0.9", 50_000)).toBe(true);
  });
});

describe("replacing the list, which is what a settings write means", () => {
  it("keeps only what the write says, split on the last colon", () => {
    const d = createDials();
    d.add("10.0.0.1", 1);
    expect(d.replace(["1.2.3.4:5", "6.7.8.9:10"])).toBe(2);
    expect((d.rows() as Row[]).map(r => r.addr)).toEqual(["1.2.3.4", "6.7.8.9"]);
    expect((d.rows() as Row[]).every(r => r.typed)).toBe(true);
    expect(d.replace(["nonsense", "", "x:0", ":4800"])).toBe(0);
    expect(d.replace(null)).toBe(0);
    // An unbracketed IPv6 address parses as its last group: the dialog
    // refuses one before it is ever stored (see addressFault in
    // LanAddDeckModal.tsx).
    d.replace(["fe80::1:4800"]);
    expect((d.rows() as Row[])[0]).toMatchObject({ addr: "fe80::1", port: 4800 });
  });
});

describe("what answered where", () => {
  it("joins a row to the deck it reached", () => {
    const d = createDials();
    d.add("10.0.0.5", 4800);
    expect(d.metAt("10.0.0.5:4800")).toBeUndefined();
    expect(d.answersAs("fp-a")).toBe(false);
    d.meet("10.0.0.5:4800", { fp: "fp-a", name: "Deck-A" });
    expect(d.metAt("10.0.0.5:4800")).toEqual({ fp: "fp-a", name: "Deck-A" });
    expect(d.answersAs("fp-a")).toBe(true);
    expect(d.rowAnswering("fp-a")).toMatchObject({ addr: "10.0.0.5", port: 4800 });
    expect(d.rowAnswering("fp-b")).toBeUndefined();
  });

  it("counts as dialling a deck only while the row is still on the list", () => {
    const d = createDials();
    d.add("10.0.0.5", 4800);
    d.meet("10.0.0.5:4800", { fp: "fp-a", name: "" });
    d.remove("10.0.0.5", 4800);
    expect(d.answersAs("fp-a")).toBe(false);
    // An answer from a heard deck — no row of its own — is kept and joins
    // nothing.
    d.answered("10.0.0.7:4800", { fp: "fp-b", name: "" });
    expect(d.answersAs("fp-b")).toBe(false);
  });
});

describe("a deck that called in, dialled back", () => {
  it("is taken away again when the round cannot reach it", () => {
    const d = createDials();
    d.add("10.0.0.5", 4800, { typed: false });
    d.trial("10.0.0.5:4800", { fp: "fp-a", name: "A" });
    expect(d.answersAs("fp-a")).toBe(true);
    expect(d.failed("10.0.0.5:4800")).toBe(true);
    expect(d.rows()).toEqual([]);
    expect(d.metAt("10.0.0.5:4800")).toBeUndefined();
    // And only once: it is no longer on trial.
    expect(d.failed("10.0.0.5:4800")).toBe(false);
  });

  it("is an ordinary row once a round reaches it, and then stays when one fails", () => {
    const d = createDials();
    d.add("10.0.0.5", 4800, { typed: false });
    d.trial("10.0.0.5:4800", { fp: "fp-a", name: "A" });
    d.answered("10.0.0.5:4800", { fp: "fp-a", name: "Deck-A" });
    expect(d.failed("10.0.0.5:4800")).toBe(false);
    expect(d.rows()).toHaveLength(1);
    expect(d.metAt("10.0.0.5:4800")).toEqual({ fp: "fp-a", name: "Deck-A" });
  });

  it("leaves every row that was not on trial alone when a round fails", () => {
    const d = createDials();
    d.add("10.0.0.5", 4800);
    expect(d.failed("10.0.0.5:4800")).toBe(false);
    expect(d.rows()).toHaveLength(1);
  });

  // #1674: the trial outlived its row. A settings write replaced the list and
  // kept the address on trial, so the first failed round took away the row a
  // person had typed there since.
  it("is off trial once somebody types the address, by a settings write or by hand", () => {
    for (const type of [
      (d: ReturnType<typeof createDials>) => d.replace(["10.0.0.5:4800"]),
      (d: ReturnType<typeof createDials>) => d.add("10.0.0.5", 4800),
    ]) {
      const d = createDials();
      d.add("10.0.0.5", 4800, { typed: false });
      d.trial("10.0.0.5:4800", { fp: "fp-a", name: "A" });
      type(d);
      expect(d.failed("10.0.0.5:4800")).toBe(false);
      expect(d.rows()).toEqual([expect.objectContaining({ addr: "10.0.0.5", port: 4800, typed: true })]);
      // Still the deck that answered there.
      expect(d.metAt("10.0.0.5:4800")).toEqual({ fp: "fp-a", name: "A" });
    }
  });

  it("ends with a settings write that drops its row", () => {
    const d = createDials();
    d.add("10.0.0.5", 4800, { typed: false });
    d.trial("10.0.0.5:4800", { fp: "fp-a", name: "A" });
    d.replace([]);
    // A round that fails at that address later — to the same deck heard
    // there, say — has no trial to end and nothing of this list to remove.
    expect(d.failed("10.0.0.5:4800")).toBe(false);
    // What answered there is still known, for a row that comes back.
    expect(d.metAt("10.0.0.5:4800")).toEqual({ fp: "fp-a", name: "A" });
  });

  it("stays on trial when the deck adds the same address again itself", () => {
    const d = createDials();
    d.add("10.0.0.5", 4800, { typed: false });
    d.trial("10.0.0.5:4800", { fp: "fp-a", name: "A" });
    d.add("10.0.0.5", 4800, { typed: false });
    expect(d.failed("10.0.0.5:4800")).toBe(true);
    expect(d.rows()).toEqual([]);
  });
});
