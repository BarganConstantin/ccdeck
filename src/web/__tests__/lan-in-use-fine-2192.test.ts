// The login a deck is on is not a login with something wrong (#2192).
//
// Keeping the login this deck is on here made its lane "in use here", and the
// lane borrowed the tone of a copy that cannot be shared — a Keychain this deck
// cannot open — which is a fault. So the network map sorted it first among the
// logins that need a look, drew it with the grey dot, and titled the deck
// "2 shared logins · 1 fine" where 3.43.3 said "2 shared logins, all fine",
// for somebody who had touched nothing. The deck it is paired with drew the
// same login "in use there" the same way, over a copy of its own that works.
// Both are fine: nothing is broken at either end, and nothing is waiting.
//
// What still is not fine: a paired deck without that login, which now gets
// nothing for it while this deck is on it — said quietly, as before this.
//
// And one login in two of claude-swap's slots is one login: the server keeps
// every slot of the login this deck is on (manifestFor, mayGiveInUse, by key),
// so the panel marks every slot of it too, whichever order they come in.
//
// Two whole decks on loopback through lan-engine-rig.ts, the pairing switches
// as shipped, every credential a synthetic string.
import { describe, it, expect, afterEach } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { accountKey } from "../../server/lan-sync.mjs";
import { offeredHere, sharedLine, sharedMarks } from "../account-lan";
import { exchangeLanes } from "../lan-exchange";
import { sharedLoginsTitle } from "../lan-network-map";
import { peerView } from "../lan-peer";
import { deckRows, rowSource } from "../lan-roster";
import type { LanAccount, LanStatus } from "../lan-types";
import { announce, rigDeck, stopAll, type RigDeck, type StoreRow } from "./lan-engine-rig";

afterEach(stopAll);

const SHIPPED = { autoAsk: true, autoAccept: true, pairingMode: "automatic" };
const WORK = "work@example.test";
const HOME = "home@example.test";
const X = accountKey(WORK, "org-w");
const Y = accountKey(HOME, "org-h");

/** A store row as claude-swap's reader hands it over (see live-login-lan-2192). */
type Row = StoreRow & { active?: boolean; collector?: string | null };

/** `here`'s view of `far` once the two have paired and traded, with `held` as
 *  this deck's panel hands its accounts to the dialogs (offeredHere). */
async function viewOf(here: RigDeck, far: RigDeck, held: LanAccount[]) {
  const status = here.e.status() as LanStatus;
  const now = Date.now();
  const row = deckRows(status, now).find(r => r.fp === far.id.fp);
  expect(row?.kind, "the rounds never paired the two decks").toBe("paired");
  return peerView({ row: row!, source: rowSource(status, row!), status, accounts: offeredHere(held, status), now });
}

async function pair(a: RigDeck, b: RigDeck) {
  announce(b, { fp: a.id.fp, port: a.port, name: "A" });
  for (let i = 0; i < 4; i++) { await b.e.round(); await a.e.round(); }
}

const tones = (lanes: Array<{ email: string; tone: string }>) => lanes.map(l => [l.email, l.tone]);

describe("the network map of the deck that is on a login, about a deck it is paired with", () => {
  it("draws that login fine, and the deck all fine, as 3.43.3 did", async () => {
    const a = await rigDeck("A", {
      rows: [
        { num: 5, email: WORK, orgUuid: "org-w", alive: true, active: true, collector: "ok" },
        { num: 6, email: HOME, orgUuid: "org-h", alive: true, active: false, collector: "ok" },
      ] as Row[],
      shared: [X, Y], settings: SHIPPED,
    });
    const b = await rigDeck("B", { settings: SHIPPED });
    await pair(a, b);
    const view = await viewOf(a, b, [
      { key: X, email: WORK, alive: true, shareable: true, active: true },
      { key: Y, email: HOME, alive: true, shareable: true },
    ]);
    // Still said, and still kept here.
    const x = view.lanes.find(l => l.key === X)!;
    expect([x.here, x.out, x.caption]).toEqual(["inUse", "cut", "in use here"]);
    expect(tones(view.lanes)).toEqual([[WORK, "ok"], [HOME, "ok"]]);
    expect(sharedLoginsTitle(view.lanes)).toBe("2 shared logins, all fine");
  }, 30_000);

  it("draws it fine where the paired deck offers it back too", () => {
    // Both decks on X: that deck lists it in use there, this one keeps its own.
    const lanes = exchangeLanes(
      [{ key: X, email: WORK, alive: true, shareable: false, inUse: true }],
      offeredHere([{ key: X, email: WORK, alive: true, shareable: true, active: true }], { sendInUse: false }),
      [X], X,
    );
    expect(lanes.map(l => [l.here, l.there, l.tone])).toEqual([["inUse", "inUse", "ok"]]);
  });
});

describe("the network map of a paired deck, about the deck that is on a login", () => {
  it("draws that login fine over a copy of its own that works", async () => {
    const a = await rigDeck("A", {
      rows: [
        { num: 5, email: WORK, orgUuid: "org-w", alive: true, active: true, collector: "ok" },
        { num: 6, email: HOME, orgUuid: "org-h", alive: true, active: false, collector: "ok" },
      ] as Row[],
      shared: [X, Y], settings: SHIPPED,
    });
    const b = await rigDeck("B", {
      rows: [
        { num: 1, email: WORK, orgUuid: "org-w", alive: true, active: false, collector: "ok" },
        { num: 2, email: HOME, orgUuid: "org-h", alive: true, active: true, collector: "ok" },
      ] as Row[],
      settings: SHIPPED,
    });
    await pair(a, b);
    const view = await viewOf(b, a, [
      { key: X, email: WORK, alive: true, shareable: true },
      { key: Y, email: HOME, alive: true, shareable: true, active: true },
    ]);
    const x = view.lanes.find(l => l.key === X)!;
    expect([x.here, x.there, x.usedThere]).toEqual(["works", "inUse", true]);
    expect(tones(view.lanes)).toEqual([[HOME, "ok"], [WORK, "ok"]]);
    expect(sharedLoginsTitle(view.lanes)).toBe("2 shared logins, all fine");
  }, 30_000);

  it("does not call it fine where it has no copy, since none comes while that deck is on it", async () => {
    const a = await rigDeck("A", {
      rows: [
        { num: 5, email: WORK, orgUuid: "org-w", alive: true, active: true, collector: "ok" },
        { num: 6, email: HOME, orgUuid: "org-h", alive: true, active: false, collector: "ok" },
      ] as Row[],
      shared: [X, Y], settings: SHIPPED,
    });
    const b = await rigDeck("B", {
      rows: [{ num: 2, email: HOME, orgUuid: "org-h", alive: true, active: true, collector: "ok" }] as Row[],
      settings: SHIPPED,
    });
    await pair(a, b);
    const view = await viewOf(b, a, [{ key: Y, email: HOME, alive: true, shareable: true, active: true }]);
    const x = view.lanes.find(l => l.key === X)!;
    expect([x.here, x.there, x.tone]).toEqual(["missing", "inUse", "idle"]);
    expect(sharedLoginsTitle(view.lanes)).toBe("2 shared logins · 1 fine");
  }, 30_000);
});

describe("one login in two slots, one of them the slot this deck is on", () => {
  const live = { key: X, email: WORK, alive: true, shareable: true, active: true };
  const idle = { key: X, email: WORK, alive: true, shareable: true };
  const status = {
    enabled: true, shared: [X], aliases: {}, sendInUse: false,
    peers: [{ fp: "fp-laptop", name: "Laptop", addr: "192.0.2.9", port: 4317, paired: true }],
  } as unknown as LanStatus;

  for (const [order, held] of [["idle slot first", [idle, live]], ["live slot first", [live, idle]]] as const) {
    it(`is kept here whole, with the ${order}`, () => {
      const accounts = offeredHere([...held], status);
      // Every slot of it, as the server keeps it by key.
      expect(accounts.map(a => [a.shareable, a.inUse])).toEqual([[false, true], [false, true]]);
      const lanes = exchangeLanes([], accounts, [X], null);
      expect(lanes.map(l => [l.here, l.out, l.caption])).toEqual([["inUse", "cut", "in use here"]]);
      const mark = new Map(sharedMarks(accounts, status)).get(X)!;
      expect(sharedLine(mark.to, mark.inUse)).toBe("Shared on Local network: in use here · not sent to Laptop while this deck is on it.");
    });
  }

  it("is handed out whole when its owner sends the login in use too", () => {
    expect(offeredHere([idle, live], { sendInUse: true })).toEqual([idle, live]);
  });
});
