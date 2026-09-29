// A deck's side of the manifest exchange, driven on its own: two decks built
// from the module, one key between them, and no socket.
//
// lan-engine.test.ts proves the exchange over the wire, both ways, with decks
// old and new. What is pinned here is what each side says and keeps — which
// accounts a frame lists, the card sealed for one direction only, a list kept
// only when one came — and that the fingerprint and the settings are read at
// the moment of asking rather than when the deck was built.
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
// @ts-expect-error — plain .mjs server module, no types
import { createManifests } from "../../server/lan-manifest.mjs";

const T0 = 1_790_550_000_000;
const A = "aaa-aaa-aaa-aaa";
const B = "bbb-bbb-bbb-bbb";
const CARD = { version: "3.29.9", os: "Linux", arch: "x64" };

type Cfg = { shared: string[]; shareActive?: boolean };

/** One deck: its card, its fingerprint and its settings, all changeable. */
function side(fp: string, about: typeof CARD | null, cfg: Cfg) {
  const me = { fp, cfg };
  const m = createManifests({ about, now: () => T0, myFp: () => me.fp, settings: () => me.cfg });
  return { m, me };
}

const acct = (email: string, extra: Record<string, unknown> = {}) =>
  ({ key: `${email}@@org`, email, alive: true, readable: true, active: false, ...extra });

describe("the frame a deck sends", () => {
  it("lists only what is shared, and which of it the deck is on", () => {
    const { m } = side(A, null, { shared: ["b@x@@org", "a@x@@org"], shareActive: true });
    const frame = m.manifestFrame([acct("c@x"), acct("b@x", { active: true }), acct("a@x")], randomBytes(32), B);
    expect(frame).toEqual({
      t: "manifest",
      accounts: [
        { key: "a@x@@org", email: "a@x", alive: true },
        { key: "b@x@@org", email: "b@x", alive: true },
      ],
      current: { key: "b@x@@org" },
    });
  });

  it("reads the settings when it is built, not when the deck was", () => {
    const { m, me } = side(A, null, { shared: [] });
    const accounts = [acct("a@x", { active: true })];
    expect(m.manifestFrame(accounts, randomBytes(32), B).accounts).toEqual([]);
    me.cfg = { shared: ["a@x@@org"], shareActive: false };
    const frame = m.manifestFrame(accounts, randomBytes(32), B);
    expect(frame.accounts).toHaveLength(1);
    expect(frame.current).toEqual({ hidden: true });
  });

  it("carries a card only for a deck that has one, sealed for that one direction", () => {
    const key = randomBytes(32);
    expect(side(A, null, { shared: [] }).m.manifestFrame([], key, B)).not.toHaveProperty("about");
    const a = side(A, CARD, { shared: [] });
    const frame = a.m.manifestFrame([], key, B);
    expect(frame.about).toBeTruthy();
    // B opens it; the same seal handed back to A as if it were B's does not.
    const b = side(B, null, { shared: [] });
    b.m.keepManifest(key, frame, A);
    expect(b.m.heardOf(A).about).toEqual({ ...CARD, at: T0 });
    a.m.keepManifest(key, frame, B);
    expect(a.m.heardOf(B).about).toBeNull();
  });
});

describe("what a deck keeps of the frame it hears", () => {
  it("is nothing until something is heard", () => {
    expect(side(A, null, { shared: [] }).m.heardOf(B)).toEqual({ about: null, offers: null });
  });

  it("is the list it offered, filtered, with the one it is on", () => {
    const { m } = side(A, null, { shared: [] });
    const list = m.keepManifest(randomBytes(32), {
      t: "manifest",
      accounts: [{ key: "a@x@@org", email: "a@x", alive: true }, { key: 7, email: "junk" }],
      current: { key: "a@x@@org" },
    }, B);
    expect(list).toEqual([{ key: "a@x@@org", email: "a@x", alive: true }]);
    expect(m.heardOf(B).offers).toEqual({ at: T0, accounts: list, current: { key: "a@x@@org" } });
  });

  it("keeps the last list when a frame comes with a card and no list", () => {
    const key = randomBytes(32);
    const b = side(B, CARD, { shared: [] });
    const { m } = side(A, null, { shared: [] });
    m.keepManifest(key, { t: "manifest", accounts: [{ key: "a@x@@org", email: "a@x", alive: true }] }, B);
    // An older caller asks with its card alone: a missing list is not an
    // empty one.
    expect(m.keepManifest(key, { t: "manifest", about: b.m.manifestFrame([], key, A).about }, B)).toBeNull();
    expect(m.heardOf(B).offers?.accounts).toHaveLength(1);
    expect(m.heardOf(B).about).toEqual({ ...CARD, at: T0 });
  });

  it("opens a card under the fingerprint the deck has now", () => {
    const key = randomBytes(32);
    const b = side(B, CARD, { shared: [] });
    const a = side("old-fp", null, { shared: [] });
    const frame = b.m.manifestFrame([], key, A);
    // A restart for a new key changed A's fingerprint to the one B sealed for.
    a.me.fp = A;
    a.m.keepManifest(key, frame, B);
    expect(a.m.heardOf(B).about).toEqual({ ...CARD, at: T0 });
  });
});
