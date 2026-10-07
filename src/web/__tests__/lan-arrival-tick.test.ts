// An account that arrives from a deck somebody here chose is ticked for sharing
// here too (#1188), so this deck can heal the next machine in the group. That
// tick is made by the arrival, not by a person, and the group it is for is the
// decks somebody here chose. A deck the accept switch paired is offered what a
// person ticked here and nothing an arrival ticked for them — the promise the
// switch ships on is that a deck which pairs is offered nothing until somebody
// ticks a login (deck-prefs.mjs).
//
// Whole engines on loopback; see lan-engine-rig.ts.
import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// @ts-expect-error — plain .mjs server module, no types
import { DEFAULTS, normalise, publicPrefs, withShared } from "../../server/deck-prefs.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { accountKey } from "../../server/lan-sync.mjs";
import { deckRows, rowSource } from "../lan-roster";
import { peerView } from "../lan-peer";
import LanPeerMap from "../components/LanPeerMap";
import type { LanStatus } from "../lan-types";
import { announce, rigDeck, stopAll, type RigDeck } from "./lan-engine-rig";

afterEach(stopAll);

const SHIPPED = { autoAsk: DEFAULTS.lan.autoAsk, autoAccept: DEFAULTS.lan.autoAccept, pairingMode: DEFAULTS.lan.pairingMode };
const EMAIL = "owner@example.test";
const X = accountKey(EMAIL, "org-x");

/** Rounds on both decks until `far` has done something with `key`, or six. */
async function roundsUntil(here: RigDeck, far: RigDeck, key: string) {
  let got: Array<{ key: string; ok: boolean }> = [];
  for (let i = 0; i < 6 && !got.some(s => s.key === key); i++) {
    await here.e.round();
    got = await far.e.round();
  }
  return got;
}

/**
 * A laptop that never ticked anything, hand-paired with a desk that shares X,
 * after the round that brought X here and ticked it on arrival. Its store
 * takes the login in, and its tick is applied the way the deck applies one:
 * the shared list, handed back to the engine.
 */
async function laptopWithArrival() {
  const rows: Array<{ num: number; email: string; orgUuid: string; alive: boolean }> = [];
  const shared: string[] = [];
  let laptop: RigDeck | null = null;
  laptop = await rigDeck("Laptop", {
    settings: { ...SHIPPED, autoAccept: false },
    deps: {
      readAccounts: async () => ({ accounts: rows }),
      importAccount: async () => { rows.push({ num: 7, email: EMAIL, orgUuid: "org-x", alive: true }); return true; },
      onShared: async (key: string) => { shared.push(key); await laptop!.e.apply({ shared: [...shared] }); },
    },
  });
  const desk = await rigDeck("Desk", {
    rows: [{ num: 3, email: EMAIL, orgUuid: "org-x", alive: true }],
    shared: [X], settings: { autoAsk: false, autoAccept: true },
  });
  announce(laptop, { fp: desk.id.fp, port: desk.port, name: "Desk" });
  await laptop.e.round(); await laptop.e.round();
  expect(laptop.e.accept(desk.id.fp), "the desk never asked to be accepted").toBeTruthy();
  expect(await laptop.e.round()).toMatchObject([{ key: X, action: "add", ok: true }]);
  expect(laptop.e.status().shared).toEqual([X]);
  return laptop;
}

/** A deck that pairs with `laptop` and asks it for X, having put X in its own
 *  list. The laptop's accept switch is on, as it ships. */
async function strangerOf(laptop: RigDeck) {
  const stranger = await rigDeck("Stranger", { shared: [X], settings: { ...SHIPPED } });
  announce(stranger, { fp: laptop.id.fp, port: laptop.port, name: "Laptop" });
  announce(laptop, { fp: stranger.id.fp, port: stranger.port, name: "Stranger" });
  return stranger;
}

describe("an account ticked because it arrived", () => {
  it("is not handed to a deck the accept switch paired", async () => {
    const laptop = await laptopWithArrival();
    await laptop.e.apply({ autoAccept: true });
    const stranger = await strangerOf(laptop);

    const got = await roundsUntil(laptop, stranger, X);
    const pin = (laptop.trustWrites.at(-1) ?? []).find(t => t.fp === stranger.id.fp);
    expect(pin?.auto, "the case never reached a pairing the switch made").toBe(true);
    expect(stranger.imported, "the login went to a deck nobody here chose").toEqual([]);
    // Not even named: it is not in what the laptop offers that deck.
    expect(got.filter(s => s.key === X)).toEqual([]);
  }, 60_000);

  it("is still handed to a deck somebody here chose", async () => {
    const laptop = await laptopWithArrival();
    const desk2 = await rigDeck("Desk-2", { settings: { ...SHIPPED, autoAccept: false } });
    announce(desk2, { fp: laptop.id.fp, port: laptop.port, name: "Laptop" });
    // Desk-2 asks; somebody at the laptop presses accept, and somebody at
    // Desk-2 accepts the laptop back.
    await desk2.e.round();
    expect(laptop.e.accept(desk2.id.fp), "Desk-2 never asked the laptop").toBeTruthy();
    await desk2.e.round();
    expect(desk2.e.accept(laptop.id.fp), "the laptop never asked Desk-2").toBeTruthy();

    expect(await desk2.e.round()).toMatchObject([{ key: X, action: "add", ok: true }]);
    expect(desk2.imported).toEqual(["ccdeck2:slot-7"]);
  }, 60_000);

  it("is handed to every paired deck once somebody here ticks it", async () => {
    const laptop = await laptopWithArrival();
    await laptop.e.apply({ autoAccept: true });
    // Unticked and ticked again by a person: the deck hands the engine the
    // list it wrote, with nothing marked as an arrival's.
    await laptop.e.apply({ shared: [], onward: [] });
    await laptop.e.apply({ shared: [X], onward: [] });
    const stranger = await strangerOf(laptop);

    expect(await roundsUntil(laptop, stranger, X)).toMatchObject([{ key: X, action: "add", ok: true }]);
    expect(stranger.imported).toEqual(["ccdeck2:slot-7"]);
  }, 60_000);
});

/** `here`'s dialog about the deck `fp`, built from the status the engine
 *  serves, the way the panel builds it. */
function dialogOf(here: RigDeck, fp: string) {
  const status = here.e.status() as LanStatus;
  const now = Date.now();
  const row = deckRows(status, now).find(r => r.fp === fp);
  expect(row?.kind, `${fp} is not a paired row here`).toBe("paired");
  const accounts = [{ key: X, email: EMAIL, alive: true, shareable: true }];
  return { row: row!, status, view: peerView({ row: row!, source: rowSource(status, row!), status, accounts, now }) };
}

/** The keys that dialog draws going out from this deck. */
function drawnOut(here: RigDeck, fp: string) {
  return dialogOf(here, fp).view.lanes.filter(l => l.out != null).map(l => l.key);
}

/** The key under that dialog's lanes, as it reads. */
function legendOf(here: RigDeck, fp: string) {
  const { row, status, view } = dialogOf(here, fp);
  const html = renderToStaticMarkup(createElement(LanPeerMap, {
    view, row, status, asking: false, drawn: 0, onSettings: () => {},
  }));
  const legend = html.match(/<div class="lan-legend">([\s\S]*?)<\/div>/)?.[1];
  expect(legend, "the dialog drew no key").toBeDefined();
  return legend!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

describe("what the deck's dialog draws of an arrival's tick", () => {
  it("draws no lane going out to a deck the accept switch paired", async () => {
    const laptop = await laptopWithArrival();
    await laptop.e.apply({ autoAccept: true });
    const stranger = await strangerOf(laptop);
    await roundsUntil(laptop, stranger, X);
    const pin = (laptop.trustWrites.at(-1) ?? []).find(t => t.fp === stranger.id.fp);
    expect(pin?.auto, "the case never reached a pairing the switch made").toBe(true);

    expect(drawnOut(laptop, stranger.id.fp), "drawn as offered to a deck it is not offered to").toEqual([]);
  }, 60_000);

  it("still draws it going out to a deck somebody here chose", async () => {
    const laptop = await laptopWithArrival();
    const [desk] = (laptop.e.status() as LanStatus).peers.filter(p => p.paired);
    expect(drawnOut(laptop, desk.peerFp ?? desk.fp)).toEqual([X]);
  }, 60_000);

  // The key under the lanes read "from this deck, to every paired deck" in
  // every dialog. In the dialog of a deck somebody here chose, the lane of a
  // login an arrival ticked goes out — and a deck the switch paired, paired
  // here too, is not handed it, so "every" said more than the deck does.
  it("keys the arrow to the decks somebody chose while a deck the switch paired is not handed what it draws", async () => {
    const laptop = await laptopWithArrival();
    const [desk] = (laptop.e.status() as LanStatus).peers.filter(p => p.paired);
    const deskFp = desk.peerFp ?? desk.fp;
    expect(legendOf(laptop, deskFp), "the common case changed").toContain("from this deck, to every paired deck");

    await laptop.e.apply({ autoAccept: true });
    const stranger = await strangerOf(laptop);
    await roundsUntil(laptop, stranger, X);
    const pin = (laptop.trustWrites.at(-1) ?? []).find(t => t.fp === stranger.id.fp);
    expect(pin?.auto, "the case never reached a pairing the switch made").toBe(true);
    expect(drawnOut(laptop, deskFp)).toEqual([X]);

    const key = legendOf(laptop, deskFp);
    expect(key).not.toContain("every paired deck");
    expect(key).toContain("from this deck, to decks you chose");

    // Ticked again by a person, it is handed to every paired deck, and the key
    // says so again.
    await laptop.e.apply({ shared: [], onward: [] });
    await laptop.e.apply({ shared: [X], onward: [] });
    expect(legendOf(laptop, deskFp)).toContain("from this deck, to every paired deck");
  }, 60_000);
});

describe("what prefs keeps of an arrival's tick", () => {
  it("marks the tick as the arrival's, beside the shared list", () => {
    const prev = normalise({ lan: { shared: ["mine@example.test@@org-1"] } });
    expect(withShared(X)(prev)).toEqual({ lan: { shared: ["mine@example.test@@org-1", X], onward: [X] } });
  });

  it("does not mark an account somebody already ticked", () => {
    expect(withShared(X)(normalise({ lan: { shared: [X] } }))).toBeNull();
  });

  it("forgets the mark when the account is unticked, so ticking it again is a person's tick", () => {
    expect(normalise({ lan: { shared: [X], onward: [X] } }).lan.onward).toEqual([X]);
    expect(normalise({ lan: { shared: [], onward: [X] } }).lan.onward).toEqual([]);
    expect(normalise({ lan: {} }).lan.onward).toEqual([]);
  });

  it("is the deck's bookkeeping, and no page is handed it", () => {
    expect(publicPrefs(normalise({ lan: { shared: [X], onward: [X] } })).lan).not.toHaveProperty("onward");
  });
});
