// Which login a deck is on stays hidden while its owner hides it (#2192).
//
// "Show paired decks which of these this deck is using", turned off, makes a
// paired deck read "current account hidden". Keeping the login a deck is on
// on that deck (#2192) listed it to every paired deck as `inUse` — "in use
// there" — so the switch hid it under the deck's name and gave it away one row
// down. A
// bare `shareable: false` would still point at it: it would be the one ticked
// login that works there and is not handed out. So while the switch is off the
// login a deck is on is left out of its list. It reads as a login not ticked,
// which is what the list already keeps back, and it is still never sent.
//
// The frame on its own, then two whole decks on loopback through
// lan-engine-rig.ts with the pairing switches as shipped and synthetic tokens.
import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
// @ts-expect-error — plain .mjs server module, no types
import { createManifests } from "../../server/lan-manifest.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { accountKey } from "../../server/lan-sync.mjs";
import { exchangeLanes } from "../lan-exchange";
import { laneSaid } from "../lan-peer";
import { announce, rigDeck, stopAll, type RigDeck, type StoreRow } from "./lan-engine-rig";

afterEach(stopAll);

const SHIPPED = { autoAsk: true, autoAccept: true, pairingMode: "automatic" };
const WORK = "work@example.test";
const HOME = "home@example.test";
const X = accountKey(WORK, "org-w");
const Y = accountKey(HOME, "org-h");

describe("the frame a deck sends while it hides which account it is on", () => {
  const acct = (key: string, email: string, active: boolean) => ({ key, email, alive: true, readable: true, active });
  const frame = (accounts: unknown[], cfg: Record<string, unknown>) =>
    createManifests({ about: null, now: () => 0, myFp: () => "aaa", settings: () => cfg })
      .manifestFrame(accounts, randomBytes(32), "bbb");

  it("leaves the login it is on out of the list, and lists every other ticked login as before", () => {
    const f = frame([acct(X, WORK, true), acct(Y, HOME, false)], { shared: [X, Y], shareActive: false });
    expect(f.accounts).toEqual([{ key: Y, email: HOME, alive: true }]);
    expect(f.current).toEqual({ hidden: true });
  });

  it("lists it, in use, while it shows which account it is on", () => {
    const f = frame([acct(X, WORK, true), acct(Y, HOME, false)], { shared: [X, Y], shareActive: true });
    expect(f.accounts).toEqual([
      { key: Y, email: HOME, alive: true },
      { key: X, email: WORK, alive: true, shareable: false, inUse: true },
    ]);
    expect(f.current).toEqual({ key: X });
  });

  it("lists it as any other when its owner sends it too, as 3.43.3 did", () => {
    const f = frame([acct(X, WORK, true), acct(Y, HOME, false)], { shared: [X, Y], shareActive: false, sendInUse: true });
    expect(f.accounts).toEqual([{ key: Y, email: HOME, alive: true }, { key: X, email: WORK, alive: true }]);
    expect(f.current).toEqual({ hidden: true });
  });

  it("leaves nothing out while the deck is on a login it does not share", () => {
    const f = frame([acct(X, WORK, false), acct(Y, HOME, false), acct("z@example.test@@org-z", "z@example.test", true)],
      { shared: [X, Y], shareActive: false });
    expect(f.accounts).toEqual([{ key: Y, email: HOME, alive: true }, { key: X, email: WORK, alive: true }]);
  });
});

/** A store row as claude-swap's reader hands it over (see live-login-lan-2192). */
type Row = StoreRow & { active?: boolean; collector?: string | null };

const peerRow = (here: RigDeck, far: RigDeck) =>
  (here.e.status().peers as Array<Record<string, any>>).find(p => (p.peerFp ?? p.fp) === far.id.fp);

async function rounds(here: RigDeck, most = 4) {
  let done: Array<Record<string, unknown>> = [];
  for (let i = 0; i < most && !done.length; i++) done = await here.e.round();
  return done;
}

describe("a paired deck, while the deck it is paired with hides which account it is on", () => {
  it("cannot tell which ticked login that deck is on, and is still never handed it", async () => {
    const rows: Row[] = [
      { num: 5, email: WORK, orgUuid: "org-w", alive: true, active: true, collector: "ok" },
      { num: 6, email: HOME, orgUuid: "org-h", alive: true, active: false, collector: "ok" },
    ];
    const exported: number[] = [];
    const tokens: Record<number, string> = { 5: "dummy-refresh-x", 6: "dummy-refresh-y" };
    const far = await rigDeck("Private", {
      rows, shared: [X, Y], settings: { ...SHIPPED, shareActive: false },
      deps: { exportAccount: async (num: number) => { exported.push(num); return tokens[num] ?? null; }, importAccount: async () => true },
    });
    const here = await rigDeck("Peer", { settings: SHIPPED, deps: { importAccount: async () => true } });
    announce(here, { fp: far.id.fp, port: far.port, name: "Private" });

    // Y, which it is not on, arrives as it always did; X does not.
    expect(await rounds(here)).toEqual([{ key: Y, email: HOME, action: "add", ok: true, why: null }]);
    expect(exported).toEqual([6]);
    const offers = peerRow(here, far)?.offers;
    expect(offers?.current).toEqual({ hidden: true });
    expect(offers?.accounts).toEqual([{ key: Y, email: HOME, alive: true }]);
    // What the peer's dialog says, lane by lane, holding both logins itself.
    const said = exchangeLanes(offers?.accounts ?? null, [
      { key: X, email: WORK, alive: true, shareable: true },
      { key: Y, email: HOME, alive: true, shareable: true },
    ], [], null).map(laneSaid);
    expect(said).toEqual(["works here, works there, offered by that deck."]);

    // It switches to Y: X goes out like any other ticked login, and Y is the one left out.
    rows[0].active = false;
    rows[1].active = true;
    expect(await here.e.round()).toEqual([{ key: X, email: WORK, action: "add", ok: true, why: null }]);
    expect(exported).toEqual([6, 5]);
    expect(peerRow(here, far)?.offers?.accounts).toEqual([{ key: X, email: WORK, alive: true }]);
  }, 30_000);
});
