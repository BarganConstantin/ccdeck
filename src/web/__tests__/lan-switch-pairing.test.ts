// A pairing the switch made brings the logins its deck shares, like any other.
//
// Asking and saying yes both ship on, so two of one person's machines on one
// network pair without anybody pressing anything. Each pin records whether a
// person or a switch made it, and from 3.33.0 until 3.38.1 a deck the switch
// paired could place a login here only for an account ticked HERE. That was a
// deadlock on the shipped defaults: the setup dialog lists only this deck's own
// accounts, so a login this deck lacks could never be ticked here, and an add
// from such a deck could never pass. A Mac ticked eight working logins, the
// deck it had paired with by the switch received none of them, ever, and its
// round line read "all logins fine".
//
// The owner chose fully automatic (2026-10-06): a login a person ticked on a
// paired deck arrives on every deck paired with it — added where it is
// missing, repaired where it has expired — whoever made the pairing. What
// still guards the rest:
//
// - a login that works here is never replaced (syncAction in lan-copies.mjs
//   never asks for a forced import);
// - a deck the switch paired is HANDED only the logins a person ticked on the
//   giving deck, not ones an arrival ticked onward (sharedWith in lan-sync.mjs,
//   lan-arrival-tick.test.ts);
// - nothing that arrives from a deck the switch paired is ticked onward here
//   (ticksOnArrival).
//
// Two whole engines on loopback, the deck under test on the settings the deck
// ships with; see lan-engine-rig.ts.
import { describe, it, expect, afterEach } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { DEFAULTS, normalise } from "../../server/deck-prefs.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { accountKey, addTrusted } from "../../server/lan-sync.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { ticksOnArrival } from "../../server/lan-engine.mjs";
import { roundLabel } from "../lan-round";
import type { Peer } from "../lan-types";
import { announce, rigDeck, stopAll, type RigDeck } from "./lan-engine-rig";

afterEach(stopAll);

/** The pairing settings a deck ships with, read off the defaults themselves so
 *  a change there is a change here. */
const SHIPPED = {
  autoAsk: DEFAULTS.lan.autoAsk,
  autoAccept: DEFAULTS.lan.autoAccept,
  pairingMode: DEFAULTS.lan.pairingMode,
};

const EMAIL = "new@example.test";
const OFFERED = accountKey(EMAIL, "org-far");

/** A deck with one live login ticked for sharing, which says yes to anybody. */
const offering = () => rigDeck("Offering", {
  rows: [{ num: 3, email: EMAIL, orgUuid: "org-far", alive: true }],
  shared: [OFFERED],
  settings: { autoAsk: false, autoAccept: true },
});

/** Whether `here` holds `far`'s pin as one the switch made — the case every
 *  test below is about, read off what prefs was asked to keep. */
const pinnedBySwitch = (here: RigDeck, far: RigDeck) =>
  (here.trustWrites.at(-1) ?? []).some(t => t.fp === far.id.fp && t.auto === true);

/** Rounds until one moves something, or four. The store is a fixture, so a
 *  login that landed reads missing or expired again on the round after. */
async function firstMove(here: RigDeck) {
  let done: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 4 && !done.length; i++) done = await here.e.round();
  return done;
}

describe("a deck paired by the switch", () => {
  it("ships on, which is what makes this the default case", () => {
    expect(SHIPPED).toEqual({ autoAsk: true, autoAccept: true, pairingMode: "automatic" });
    expect(DEFAULTS.lan.shared).toEqual([]);
  });

  it("a deck the switch paired adds a login this deck does not have", async () => {
    // The deadlock in its shipped shape: nothing ticked here, and nothing here
    // that could be ticked, because this deck does not hold the account.
    const here = await rigDeck("Here", { settings: SHIPPED });
    const far = await offering();
    announce(here, { fp: far.id.fp, port: far.port, name: "Offering" });

    const done = await firstMove(here);
    expect(pinnedBySwitch(here, far), "the rounds never reached the pairing this case is about").toBe(true);
    expect(done).toEqual([{ key: OFFERED, email: EMAIL, action: "add", ok: true, why: null }]);
    expect(far.exported).toEqual([3]);
    expect(here.imported).toEqual(["ccdeck2:slot-3"]);
  }, 30_000);

  it("ticks nothing it brought for sharing onward", async () => {
    const here = await rigDeck("Here", { settings: SHIPPED });
    const far = await offering();
    announce(here, { fp: far.id.fp, port: far.port, name: "Offering" });

    for (let i = 0; i < 4; i++) await here.e.round();
    expect(pinnedBySwitch(here, far), "the rounds never reached the pairing this case is about").toBe(true);
    expect(here.imported, "nothing arrived, so nothing could have been ticked").not.toEqual([]);
    expect(here.ticked, "an arrival from a deck nobody here chose was ticked for sharing onward").toEqual([]);
  }, 30_000);

  it("keeps saying so in prefs, so a restart does not make it a person's pairing", async () => {
    const here = await rigDeck("Here", { settings: SHIPPED });
    const far = await offering();
    announce(here, { fp: far.id.fp, port: far.port, name: "Offering" });
    for (let i = 0; i < 2; i++) await here.e.round();

    const written = here.trustWrites.at(-1) ?? [];
    expect(written).toMatchObject([{ fp: far.id.fp, auto: true }]);
    // And the file keeps it: prefs drops keys it does not know.
    expect(normalise({ lan: { trusted: written } }).lan.trusted).toMatchObject([{ fp: far.id.fp, auto: true }]);
  }, 30_000);

  it("still heals an account somebody here ticked, as any paired deck does", async () => {
    const key = accountKey("mine@example.test", "org-1");
    const here = await rigDeck("Here", {
      rows: [{ num: 1, email: "mine@example.test", orgUuid: "org-1", alive: false }],
      shared: [key], settings: SHIPPED,
    });
    const far = await rigDeck("Offering", {
      rows: [{ num: 3, email: "mine@example.test", orgUuid: "org-1", alive: true }],
      shared: [key], settings: { autoAsk: false, autoAccept: true },
    });
    announce(here, { fp: far.id.fp, port: far.port, name: "Offering" });
    expect(await firstMove(here)).toMatchObject([{ action: "heal", ok: true }]);
    expect(here.imported).toEqual(["ccdeck2:slot-3"]);
  }, 30_000);

  it("a deck the switch paired heals an expired login without a tick here", async () => {
    const key = accountKey("mine@example.test", "org-1");
    const here = await rigDeck("Here", {
      rows: [{ num: 1, email: "mine@example.test", orgUuid: "org-1", alive: false }],
      shared: [], settings: SHIPPED,
    });
    const far = await rigDeck("Offering", {
      rows: [{ num: 3, email: "mine@example.test", orgUuid: "org-1", alive: true }],
      shared: [key], settings: { autoAsk: false, autoAccept: true },
    });
    announce(here, { fp: far.id.fp, port: far.port, name: "Offering" });

    const done = await firstMove(here);
    expect(pinnedBySwitch(here, far), "the rounds never reached the pairing this case is about").toBe(true);
    expect(done).toEqual([{ key, email: "mine@example.test", action: "heal", ok: true, why: null }]);
    expect(here.imported).toEqual(["ccdeck2:slot-3"]);
    // A heal is never ticked onward, whoever brought it.
    expect(here.ticked).toEqual([]);
  }, 30_000);

  it("a deck the switch paired never replaces a login that works here", async () => {
    // Ticked at both ends, so nothing but the copy here working stands between
    // the far deck's login and this store.
    const key = accountKey("mine@example.test", "org-1");
    const here = await rigDeck("Here", {
      rows: [{ num: 1, email: "mine@example.test", orgUuid: "org-1", alive: true }],
      shared: [key], settings: SHIPPED,
    });
    const far = await rigDeck("Offering", {
      rows: [{ num: 3, email: "mine@example.test", orgUuid: "org-1", alive: true }],
      shared: [key], settings: { autoAsk: false, autoAccept: true },
    });
    announce(here, { fp: far.id.fp, port: far.port, name: "Offering" });

    for (let i = 0; i < 4; i++) expect(await here.e.round()).toEqual([]);
    expect(pinnedBySwitch(here, far), "the rounds never reached the pairing this case is about").toBe(true);
    expect(far.exported, "the working login here was even asked to be replaced").toEqual([]);
    expect(here.imported).toEqual([]);
  }, 30_000);

  it("does not stop a heal when the login is unticked here mid-export", async () => {
    // The tick here is this deck's answer to "offer it", from either kind of
    // pairing, so taking it away mid-round changes nothing about what arrives.
    const A = accountKey("a-heal@example.test", "o");
    const B = accountKey("b-add@example.test", "o");
    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const here = await rigDeck("Here", {
      rows: [{ num: 1, email: "a-heal@example.test", orgUuid: "o", alive: false }],
      shared: [A], settings: SHIPPED,
    });
    const far = await rigDeck("Offering", {
      rows: [
        { num: 5, email: "a-heal@example.test", orgUuid: "o", alive: true },
        { num: 6, email: "b-add@example.test", orgUuid: "o", alive: true },
      ],
      shared: [A, B], settings: { autoAsk: false, autoAccept: true },
      deps: {
        exportAccount: async (num: number) => {
          if (num === 5) { started(); await gate; }
          return `ccdeck2:slot-${num}`;
        },
      },
    });
    announce(here, { fp: far.id.fp, port: far.port, name: "Offering" });
    let done: Array<Record<string, unknown>> = [];
    const rounds = (async () => { done = await firstMove(here); })();
    await began;
    await here.e.apply({ shared: [] });
    release();
    await rounds;
    expect(pinnedBySwitch(here, far), "the rounds never reached the pairing this case is about").toBe(true);
    expect(done).toEqual([
      { key: A, email: "a-heal@example.test", action: "heal", ok: true, why: null },
      { key: B, email: "b-add@example.test", action: "add", ok: true, why: null },
    ]);
    expect(here.imported).toEqual(["ccdeck2:slot-5", "ccdeck2:slot-6"]);
  }, 30_000);
});

describe("what the panel says about a deck the switch paired", () => {
  it("does not call a round fine when a paired deck offered logins it did not take", async () => {
    // The line under the far deck's name, on the deck that lacked the login:
    // "all logins fine" while a working login it did not have was on offer and
    // never asked for.
    const here = await rigDeck("Here", { settings: SHIPPED });
    const far = await offering();
    announce(here, { fp: far.id.fp, port: far.port, name: "Offering" });
    for (let i = 0; i < 4; i++) await here.e.round();

    expect(pinnedBySwitch(here, far), "the rounds never reached the pairing this case is about").toBe(true);
    const row = (here.e.status().peers as Peer[]).find(p => (p as Peer & { id?: string }).id === far.id.fp);
    const said = roundLabel(row?.last ?? null, Date.now());
    expect(said?.text).not.toMatch(/all logins fine/);
    expect(said).toMatchObject({ text: expect.stringMatching(/^1 login arrived/), tone: "ok" });
  }, 30_000);

  // Its lanes in the deck's own dialog: lan-peer-modal.test.ts, "a deck the
  // switch paired".
});

describe("a deck somebody here chose", () => {
  it("still places what it offers and has it ticked onward, as before", async () => {
    // The same two decks with the accept switch off here, and one press.
    const here = await rigDeck("Here", { settings: { ...SHIPPED, autoAccept: false } });
    const far = await offering();

    announce(here, { fp: far.id.fp, port: far.port, name: "Offering" });
    await here.e.round();
    await here.e.round();
    expect(here.e.status().pending).toMatchObject([{ fp: far.id.fp }]);
    expect(here.e.accept(far.id.fp)).toBeTruthy();

    expect(await here.e.round()).toMatchObject([{ key: OFFERED, action: "add", ok: true }]);
    expect(here.imported).toEqual(["ccdeck2:slot-3"]);
    expect(here.ticked).toEqual([OFFERED]);
  }, 30_000);

  it("is what a switch's pairing becomes when somebody here pairs with it by hand", () => {
    const pinned = { fp: "abc-def-012-345", pub: "PUB", name: "Offering" };
    const bySwitch = addTrusted([], { ...pinned, auto: true }).list;
    expect(bySwitch).toMatchObject([{ fp: pinned.fp, auto: true }]);
    // A person's pin of the same key takes the mark away.
    const byHand = addTrusted(bySwitch, pinned).list;
    expect(byHand[0].auto).toBeUndefined();
    // And a switch never takes a person's choice back.
    expect(addTrusted(byHand, { ...pinned, auto: true }).list[0].auto).toBeUndefined();
  });

  it("is the only kind whose arrivals are ticked onward", () => {
    const add = { key: OFFERED, action: "add" };
    expect(ticksOnArrival(add, "lan", { fp: "x", auto: false })).toBe(true);
    expect(ticksOnArrival(add, "lan", { fp: "x", auto: true })).toBe(false);
  });
});
