// A pairing the switch made is not a person's choice, and it may not put
// logins into this deck's store.
//
// Asking and saying yes both ship on, so two decks on one network pair without
// anybody pressing anything. What an unticked store gives away was already
// gated — `shared` is empty until somebody ticks a login. What it TAKES IN was
// not: a login this deck lacks is an `add`, adds needed no tick, and an
// arrival was then ticked for sharing onward (#1188). So the logins a deck
// ended up holding and passing on were whatever a deck nobody here chose
// decided to offer.
//
// Each pin now records whether a person or a switch made it. A deck paired by
// the switch is treated like a heal is: what it offers comes in only for an
// account somebody here ticked, and nothing from it is ticked onward. A deck
// somebody here chose — pressed accept on, or paired with by invite — is
// exactly what it was.
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
import { offerLine } from "../lan-exchange";
import { announce, rigDeck, stopAll } from "./lan-engine-rig";

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

describe("a deck paired by the switch", () => {
  it("ships on, which is what makes this the default case", () => {
    expect(SHIPPED).toEqual({ autoAsk: true, autoAccept: true, pairingMode: "automatic" });
    expect(DEFAULTS.lan.shared).toEqual([]);
  });

  it("places no login here and has nothing ticked onward, however many rounds run", async () => {
    const here = await rigDeck("Here", { settings: SHIPPED });
    const far = await offering();

    announce(here, { fp: far.id.fp, port: far.port, name: "Offering" });
    for (let i = 0; i < 4; i++) await here.e.round();

    // The pairing itself still happens — that is what the switch is for.
    const pin = (here.e.status().trusted as Array<{ fp: string }>).find(t => t.fp === far.id.fp);
    expect(pin, "the rounds never reached the pairing this case is about").toBeTruthy();

    expect(here.imported, "a login was written into the store").toEqual([]);
    expect(here.ticked, "an arrival was ticked for sharing onward").toEqual([]);
    expect(far.exported, "the login was even asked for").toEqual([]);
    // And its row says so, for the dialog to draw.
    expect(here.e.status().peers).toMatchObject([{ id: far.id.fp, paired: true, autoPaired: true }]);
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
    // A heal needed this deck's own tick before; the tick is the decision.
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
    // Until the round that moves it: this store is a fixture, so the slot
    // reads expired again on the round after.
    let done: Array<{ action: string; ok: boolean }> = [];
    for (let i = 0; i < 4 && !done.length; i++) done = await here.e.round();
    expect(done).toMatchObject([{ action: "heal", ok: true }]);
    expect(here.imported).toEqual(["ccdeck2:slot-3"]);
  }, 30_000);
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

  it("is the only kind the dialog promises a login from", () => {
    const theirs = { key: OFFERED, email: EMAIL, alive: true };
    expect(offerLine(theirs, null, false)).toMatchObject({ note: "arrives next round", tone: "wait" });
    expect(offerLine(theirs, null, false, false))
      .toMatchObject({ here: "not on this deck", note: "paired automatically — pair by invite to take it", tone: "bad" });
    // Ticked here, it comes in from either kind — the engine's rule too.
    expect(offerLine(theirs, null, true, false)).toMatchObject({ note: "arrives next round" });
  });

  it("is the only kind whose arrivals are ticked onward", () => {
    const add = { key: OFFERED, action: "add" };
    expect(ticksOnArrival(add, "lan", { fp: "x", auto: false })).toBe(true);
    expect(ticksOnArrival(add, "lan", { fp: "x", auto: true })).toBe(false);
  });
});
