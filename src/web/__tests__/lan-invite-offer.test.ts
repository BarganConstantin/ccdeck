// The invite a deck is holding out, driven on its own.
//
// lan-invite-secret-1137.test.ts proves the engine's side end to end: a joiner
// with a wrong token, over a real socket, until the invite is put away. What
// is pinned here is the bookkeeping those rounds go through — a clock the test
// holds, and a log it can read line by line — so that each rule is one case.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { createInviteOffer } from "../../server/lan-invite-offer.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { MAX_WRONG_PROOFS } from "../../server/lan-invite.mjs";

const T0 = 1_790_550_000_000;
const MINTED = { token: "ccdeck-invite:abc", code: "c0de", expiresAt: T0 + 600_000, addrs: ["10.0.0.2:4800"] };

/** An offer on a clock the test moves, with every redraw and log line kept. */
function desk() {
  let t = T0;
  const changes: number[] = [];
  const said: string[] = [];
  const offer = createInviteOffer({
    now: () => t,
    onChange: () => changes.push(t),
    onError: (where: string, err: Error) => said.push(`${where}: ${err.message}`),
  });
  return { offer, changes, said, at: (ms: number) => { t = ms; } };
}

describe("an invite on offer", () => {
  it("is offered, drawn and checked against once it is put out", () => {
    const d = desk();
    expect(d.offer.offering()).toBeNull();
    expect(d.offer.row()).toBeNull();
    expect(d.offer.live()).toBeNull();
    d.offer.put(MINTED);
    expect(d.changes).toHaveLength(1);
    expect(d.offer.offering()).toEqual({ token: MINTED.token, expiresAt: MINTED.expiresAt });
    expect(d.offer.row()).toEqual({ token: MINTED.token, expiresAt: MINTED.expiresAt, refused: 0 });
    // The listener is handed the whole invite, code and all: it is what a
    // proof is checked against.
    expect(d.offer.live()).toMatchObject({ code: "c0de", refused: 0 });
  });

  it("stops being offered, drawn or provable the moment it runs out", () => {
    const d = desk();
    d.offer.put(MINTED);
    d.at(MINTED.expiresAt - 1);
    expect(d.offer.live()).not.toBeNull();
    d.at(MINTED.expiresAt);
    expect(d.offer.offering()).toBeNull();
    expect(d.offer.row()).toBeNull();
    expect(d.offer.live()).toBeNull();
  });

  it("is one at a time, and a new one starts with no wrong proofs", () => {
    const d = desk();
    d.offer.put(MINTED);
    d.offer.wrongInvite({ addr: "10.0.0.9" });
    d.offer.put({ ...MINTED, token: "ccdeck-invite:def" });
    expect(d.offer.row()).toEqual({ token: "ccdeck-invite:def", expiresAt: MINTED.expiresAt, refused: 0 });
  });
});

describe("putting it away", () => {
  it("by hand says whether there was one, and redraws only then", () => {
    const d = desk();
    expect(d.offer.withdraw()).toBe(false);
    expect(d.changes).toHaveLength(0);
    d.offer.put(MINTED);
    expect(d.offer.withdraw()).toBe(true);
    expect(d.changes).toHaveLength(2);
    expect(d.offer.offering()).toBeNull();
  });

  it("once it is spent leaves the redraw to the pairing that spent it", () => {
    const d = desk();
    d.offer.put(MINTED);
    d.offer.retire();
    expect(d.changes).toHaveLength(1);
    expect(d.offer.live()).toBeNull();
  });
});

describe("a proof of it that does not hold (#1137)", () => {
  it("is counted, logged with where it came from, and redrawn", () => {
    const d = desk();
    d.offer.put(MINTED);
    d.offer.wrongInvite({ addr: "10.0.0.9" });
    d.offer.wrongInvite(null);
    expect(d.said).toEqual([
      `invite: a proof of this deck's invite from 10.0.0.9 did not hold (1 of ${MAX_WRONG_PROOFS})`,
      `invite: a proof of this deck's invite from an unknown address did not hold (2 of ${MAX_WRONG_PROOFS})`,
    ]);
    expect(d.offer.row()?.refused).toBe(2);
    expect(d.changes).toHaveLength(3);
  });

  it(`puts it away at the ${MAX_WRONG_PROOFS}th, and says so`, () => {
    const d = desk();
    d.offer.put(MINTED);
    for (let i = 0; i < MAX_WRONG_PROOFS; i++) d.offer.wrongInvite({ addr: "10.0.0.9" });
    expect(d.offer.live()).toBeNull();
    expect(d.offer.offering()).toBeNull();
    expect(d.said).toHaveLength(MAX_WRONG_PROOFS + 1);
    expect(d.said.at(-1)).toBe(`invite: put the invite away after ${MAX_WRONG_PROOFS} proofs that did not hold; make a new one`);
  });

  it("with nothing on offer is nothing to count", () => {
    const d = desk();
    d.offer.wrongInvite({ addr: "10.0.0.9" });
    expect(d.said).toEqual([]);
    expect(d.changes).toEqual([]);
  });
});
