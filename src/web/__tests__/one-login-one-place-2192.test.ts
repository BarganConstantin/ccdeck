// One login, live in one place (#2192): account sharing and in-use rules.
//
// A Claude refresh token renews once: the copy that renews it first keeps the
// login, and every other copy is refused from then on, so two machines on one
// copied login race at every renewal and the loser is signed out ("Login
// expired · Please run /login"). This pins what crosses the wire about the
// login a deck is signed in to, how both ends draw it, and what this deck says
// when a paired deck is on the login it is on:
//
//   - the login a deck is on is listed and not given, in a shape an older deck
//     already obeys, and refused when an older deck asks for it anyway;
//   - "Send the login this deck is using too" is a new switch that ships off;
//   - this deck's setup and a deck's lanes say "in use" rather than "cannot
//     share";
//   - which deck is on which login, and for how long its word counts
//     (lan-elsewhere.mjs), and that a deck too old to say anything is read as
//     saying nothing;
//   - peer activity alone never raises an account warning or desktop alert.
//
// Auto-switch may still move to a login a paired deck is on (3.43.3).
//
// Pure functions only: no socket, no process, no file. lan-serve.test.ts drives
// `serve` itself through the same answer, and live-login-lan-2192.test.ts two
// whole decks on loopback.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  connectLanStatus, decksByAccount, deckList, deckName, ELSEWHERE_FRESH_MS, elsewhereNow, namesByAccount,
} from "../../server/lan-elsewhere.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { currentFor, heardCurrent, IN_USE, manifestFor, mayGiveInUse, offered, peerWhy, plan } from "../../server/lan-sync.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { createManifests } from "../../server/lan-manifest.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { DEFAULTS, normalise } from "../../server/deck-prefs.mjs";
import { accountIssue } from "../account-issue";
import { activeElsewhere, lanAccounts, offeredHere } from "../account-lan";
import AccountRow from "../components/AccountRow";
import type { Account } from "../claude-accounts";
import { exchangeLanes } from "../lan-exchange";
import { laneSaid } from "../lan-peer";
import { roundWhy } from "../lan-round";
import type { LanAccount } from "../lan-types";

const NOW = 1_790_000_000_000;
const WORK = "work@example.test@@org-w";
const HOME = "home@example.test@@org-h";

type Current = { key?: string } | { hidden: true } | { other: true } | null;
type Offers = { at: number; current?: Current; accounts?: Array<Record<string, unknown>> } | null;
type PeerRow = { fp: string; peerFp?: string | null; name?: string; addr?: string; paired?: boolean; offers?: Offers };
type Status = { enabled: boolean; peers: PeerRow[]; addrs: string[]; aliases: Record<string, string> };

/** A paired deck on the LAN that last said, `ago` ms back, it is on `key`. */
function deck(name: string, key: string | null, ago = 30_000, over: Partial<PeerRow> = {}): PeerRow {
  return {
    fp: `fp-${name}`, name, addr: "192.0.2.20", paired: true,
    offers: { at: NOW - ago, accounts: [], ...(key ? { current: { key } } : {}) },
    ...over,
  };
}

function status(peers: PeerRow[], over: Partial<Status> = {}): Status {
  return { enabled: true, peers, addrs: ["192.0.2.10"], aliases: {}, ...over };
}

/** A deck's two logins as its roster gives them to its manifest, on `on`. */
const manifestRows = (on: string) => [
  { key: WORK, email: "work@example.test", alive: true, active: on === WORK, num: 1 },
  { key: HOME, email: "home@example.test", alive: true, active: on === HOME, num: 2 },
];

/** The status this deck holds after one manifest from the paired deck
 *  "studio", built and kept by the real manifest code at both ends
 *  (lan-manifest.mjs) — the in-use rule included. */
function heardFrom(theirs: unknown[], cfg: Record<string, unknown>): Status {
  const there = createManifests({ about: null, now: () => NOW, myFp: () => "fp-studio", settings: () => cfg });
  const here = createManifests({ about: null, now: () => NOW - 30_000, myFp: () => "fp-here", settings: () => ({ shared: [] }) });
  here.keepManifest(null, there.manifestFrame(theirs, null, "fp-here"), "fp-studio");
  return status([deck("studio", null, 0, { fp: "fp-studio", offers: here.heardOf("fp-studio").offers })]);
}

/** The studio's settings that show which shared login it is on. */
const SHOWN = { shared: [WORK, HOME], shareActive: true, sendInUse: false };

// ── which deck is on which login ────────────────────────────────────────────

describe("which deck is on which login", () => {
  it("is what a paired deck said within five minutes, and nothing older", () => {
    expect(ELSEWHERE_FRESH_MS).toBe(5 * 60_000);
    const names = (ago: number) => namesByAccount(status([deck("iMac", WORK, ago)]), NOW).get(WORK) ?? null;
    expect(names(30_000)).toEqual(["iMac"]);
    // A dropped round or two does not take it down: that would be two incidents.
    expect(names(4 * 60_000)).toEqual(["iMac"]);
    expect(names(ELSEWHERE_FRESH_MS)).toEqual(["iMac"]);
    // Past the window, what it said is its last word, not its current one.
    expect(names(ELSEWHERE_FRESH_MS + 1)).toBeNull();
    // And a clock that ran ahead is not a promise about the next five minutes.
    expect(names(-(ELSEWHERE_FRESH_MS + 1))).toBeNull();
    expect(names(-60_000)).toEqual(["iMac"]);
  });

  it("is nothing for a deck that hides it, is on a login it does not share, or never says", () => {
    const said: unknown[] = [{ hidden: true }, { other: true }, null, { key: "" }, { key: 7 }];
    for (const current of said) {
      const p = deck("iMac", null);
      p.offers = { at: NOW - 1000, accounts: [], current: current as Current };
      expect(decksByAccount(status([p]), NOW).size, JSON.stringify(current)).toBe(0);
    }
    // A deck older than 3.22.15 sends no `current` at all.
    expect(decksByAccount(status([deck("old", null)]), NOW).size).toBe(0);
    // And one that never sent a list has nothing to read.
    expect(decksByAccount(status([deck("new", WORK, 0, { offers: null })]), NOW).size).toBe(0);
    const odd = deck("odd", WORK, 0, { offers: { at: Number.NaN, current: { key: WORK } } });
    expect(decksByAccount(status([odd]), NOW).size).toBe(0);
  });

  it("is nothing from a deck that is not paired, or while Local network is off", () => {
    expect(decksByAccount(status([deck("near", WORK, 1000, { paired: false })]), NOW).size).toBe(0);
    expect(decksByAccount(status([deck("iMac", WORK)], { enabled: false }), NOW).size).toBe(0);
    expect(decksByAccount(null, NOW).size).toBe(0);
    expect(decksByAccount(undefined, NOW).size).toBe(0);
  });

  it("does not count a second deck on this same machine, which shares the login rather than copying it", () => {
    for (const addr of ["127.0.0.1", "::1", "localhost", "192.0.2.10"]) {
      expect(decksByAccount(status([deck("here", WORK, 1000, { addr })]), NOW).size, addr).toBe(0);
    }
  });

  it("names each deck once, by the name given it here, in order", () => {
    const s = status([
      deck("rdp", WORK),
      deck("macbook", WORK, 1000, { fp: "fp-mac" }),
      // The same machine reached a second way is still one deck.
      deck("macbook", WORK, 2000, { fp: "fp-mac-2", peerFp: "fp-mac" }),
      deck("pc", HOME),
    ], { aliases: { "fp-mac": "Work Mac" } });
    const by = namesByAccount(s, NOW);
    expect(by.get(WORK)).toEqual(["rdp", "Work Mac"]);
    expect(by.get(HOME)).toEqual(["pc"]);
    expect(decksByAccount(s, NOW).get(WORK)?.map(p => p.fp)).toEqual(["fp-rdp", "fp-mac"]);
    expect(deckName({ fp: "fp-x" })).toBe("another deck");
    expect(deckName({ fp: "fp-x", name: "  " }, { "fp-x": " Den " })).toBe("Den");
  });

  it("is said as a list a sentence can hold", () => {
    expect(deckList([])).toBe("another deck");
    expect(deckList(["iMac"])).toBe("iMac");
    expect(deckList(["iMac", "PC"])).toBe("iMac and PC");
    expect(deckList(["iMac", "Mac", "PC"])).toBe("iMac, Mac and PC");
  });

  it("is asked through a door the server connects, and is nobody until it is", () => {
    connectLanStatus(null);
    expect(elsewhereNow(NOW).size).toBe(0);
    connectLanStatus(() => status([deck("iMac", WORK)]));
    expect(elsewhereNow(NOW).get(WORK)).toEqual(["iMac"]);
    // A status that cannot be read is a deck that knows of nobody.
    connectLanStatus(() => { throw new Error("engine gone"); });
    expect(elsewhereNow(NOW).size).toBe(0);
    connectLanStatus(null);
  });
});

// ── what crosses the wire ───────────────────────────────────────────────────

describe("the login a deck is on, on the wire", () => {
  const rows = [
    { key: WORK, email: "work@example.test", alive: true, active: true, num: 1 },
    { key: HOME, email: "home@example.test", alive: true, active: false, num: 2 },
  ];

  it("is listed and not offered, unless its owner turned sending it on", () => {
    expect(manifestFor(rows, [WORK, HOME])).toEqual([
      { key: HOME, email: "home@example.test", alive: true },
      // Still listed: `current` names it, and a paired deck keeps a `current`
      // only for an account in the same list.
      { key: WORK, email: "work@example.test", alive: true, shareable: false, inUse: true },
    ]);
    expect(manifestFor(rows, [WORK, HOME], { sendInUse: true })).toEqual([
      { key: HOME, email: "home@example.test", alive: true },
      { key: WORK, email: "work@example.test", alive: true },
    ]);
    // A login this deck cannot read stays unoffered whatever the switch says.
    expect(manifestFor([{ ...rows[0], readable: false }], [WORK], { sendInUse: true }))
      .toEqual([{ key: WORK, email: "work@example.test", alive: true, shareable: false }]);
    // Two slots of the login it is on are one login.
    expect(manifestFor([{ ...rows[0], active: false, num: 3 }, rows[0]], [WORK]))
      .toEqual([{ key: WORK, email: "work@example.test", alive: true, shareable: false, inUse: true }]);
    // An account nobody ticked is still absent, live or not.
    expect(manifestFor(rows, [HOME])).toEqual([{ key: HOME, email: "home@example.test", alive: true }]);
  });

  it("is read by a deck of this version as in use, and asked for by nobody", () => {
    const theirs = offered(manifestFor(rows, [WORK, HOME]));
    expect(theirs.find((a: { key: string }) => a.key === WORK)).toEqual({ key: WORK, email: "work@example.test", alive: true, shareable: false, inUse: true });
    // A dead copy here is not healed from it, and no copy here is not added.
    expect(plan([
      { key: WORK, email: "work@example.test", alive: false },
      { key: HOME, email: "home@example.test", alive: true },
    ], theirs)).toEqual([]);
    expect(plan([], theirs)).toEqual([{ key: HOME, email: "home@example.test", action: "add" }]);
    // And the deck's `current` for it is still kept.
    expect(heardCurrent({ key: WORK }, theirs)).toEqual({ key: WORK });
  });

  it("carries `inUse` only beside `shareable: false`, which is what every peer since 3.29.0 obeys", () => {
    // `inUse` alone says nothing a round acts on, so it is not kept alone.
    expect(offered([{ key: WORK, email: "w@x", alive: true, inUse: true }])).toEqual([{ key: WORK, email: "w@x", alive: true }]);
    // A list from a deck older than this one has neither, and means what it did.
    const old = offered([{ key: WORK, email: "w@x", alive: true }]);
    expect(old).toEqual([{ key: WORK, email: "w@x", alive: true }]);
    expect(plan([{ key: WORK, email: "w@x", alive: false }], old)).toEqual([{ key: WORK, email: "w@x", action: "heal" }]);
  });

  it("is refused to a deck too old to read the mark, with a reason a deck of this version prints", () => {
    expect(IN_USE).toBe("in use");
    expect(peerWhy("in use")).toBe("in use");
    expect(mayGiveInUse(rows, WORK, false)).toBe(false);
    expect(mayGiveInUse(rows, WORK, undefined)).toBe(false);
    expect(mayGiveInUse(rows, WORK, true)).toBe(true);
    expect(mayGiveInUse(rows, HOME, false)).toBe(true);
    // And the round says why, at the other end.
    expect(roundWhy({ key: WORK, email: "work@example.test", action: "add", ok: false, why: "in use" } as never))
      .toMatchObject({ short: "in use on the other deck" });
  });

  it("ships on since 3.48.1, and keeps a choice made from then on", () => {
    expect(DEFAULTS.lan.sendInUse).toBe(true);
    expect(normalise({ lan: {} }).lan.sendInUse).toBe(true);
    // A false saved before 3.48.1 is the old default written back with the
    // rest of `lan`, not a choice.
    expect(normalise({ lan: { sendInUse: false } }).lan.sendInUse).toBe(true);
    expect(normalise({ lan: { sendInUse: false, sendInUseSet: true } }).lan.sendInUse).toBe(false);
    expect(normalise({ lan: { sendInUse: "no", sendInUseSet: true } }).lan.sendInUse).toBe(true);
    // The pairing switches and shareActive are untouched.
    expect(normalise({ lan: {} }).lan).toMatchObject({ autoAsk: true, autoAccept: true, pairingMode: "automatic", shareActive: true });
    expect(normalise({ lan: { shareActive: false } }).lan.shareActive).toBe(false);
  });

  it("is drawn on this deck's side the way the server sends it", () => {
    const mine = [
      { key: WORK, email: "work@example.test", alive: true, shareable: true, active: true },
      { key: HOME, email: "home@example.test", alive: true, shareable: true },
    ] as LanAccount[];
    expect(offeredHere(mine, { sendInUse: false })[0]).toMatchObject({ shareable: false, inUse: true });
    expect(offeredHere(mine, null)[1]).toEqual(mine[1]);
    expect(offeredHere(mine, { sendInUse: true })).toBe(mine);
  });

  it("is said on a deck's lanes as in use, at whichever end it is, and not as unreadable", () => {
    const theirs = [{ key: WORK, email: "work@example.test", alive: true, shareable: false, inUse: true }];
    const mine = [{ key: WORK, email: "work@example.test", alive: false, shareable: true }] as LanAccount[];
    const [there] = exchangeLanes(theirs, mine, [], WORK);
    expect(there).toMatchObject({ here: "expired", there: "inUse", in: "cut", usedThere: true });
    expect(there.caption).toBe("expired here · in use there");
    expect(laneSaid(there)).toBe("expired here, in use there, offered by that deck.");
    const kept = offeredHere([{ key: HOME, email: "home@example.test", alive: true, shareable: true, active: true }] as LanAccount[], null);
    const [here] = exchangeLanes([], kept, [HOME]);
    expect(here).toMatchObject({ here: "inUse", out: "cut", caption: "in use here" });
    expect(laneSaid(here)).toBe("in use here, not offered by that deck, offered by this deck.");
  });

  it("leaves a lane for an unreadable login as it was", () => {
    const theirs = [{ key: WORK, email: "work@example.test", alive: true, shareable: false }];
    const [there] = exchangeLanes(theirs, [], [], null);
    expect(there).toMatchObject({ there: "unavailable", in: "cut" });
    expect(laneSaid(there)).toContain("cannot share there");
  });
});

// ── this deck's roster ──────────────────────────────────────────────────────

describe("this deck's accounts, as Local network reads them", () => {
  const account = (over: Partial<Account> = {}): Account => ({
    num: 2, email: "work@example.test", alias: null, org: null, orgUuid: "org-w", active: false, disabled: false,
    lanes: [], headroom: 80, fetchedAt: NOW - 60_000, nextAt: null, stale: false, error: null, ...over,
  });

  it("is told which one is live, so the setup can say why it is not sent", () => {
    const [on, off] = lanAccounts([account({ active: true, num: 1 }), account({ num: 2, email: "home@example.test" })]);
    expect(on.active).toBe(true);
    expect(off).not.toHaveProperty("active");
  });
});

// ── the live account's row ──────────────────────────────────────────────────

describe("the live account's row, when a paired deck is on that login", () => {
  const NOW_SEC = NOW / 1000;
  const account = (over: Partial<Account> = {}): Account => ({
    num: 2, email: "work@example.test", alias: null, org: null, orgUuid: "org-w", active: false, disabled: false,
    lanes: [], headroom: 80, fetchedAt: NOW - 60_000, nextAt: null, stale: false, error: null, ...over,
  } as Account);
  const row = (a: Account) => renderToStaticMarkup(createElement(AccountRow, {
    a, nowSec: NOW_SEC, lan: { sharedTo: null }, opened: false, onToggleLanes: () => {}, busy: null,
    pressProps: () => ({}), onSwitch: () => {}, menuOpen: false, onOpenMenu: () => {}, onCloseMenu: () => {},
    refusal: null, onDismissRefusal: () => {}, switchedHere: false, swapped: null, displaced: undefined,
    issueExpanded: false, onOpenIssue: () => {},
  } as never));

  it("finds the decks by the list's names, through the same rule as the server", () => {
    const s = status([deck("imac", WORK, 1000, { fp: "fp-imac" })], { aliases: { "fp-imac": "iMac" } });
    expect(activeElsewhere(WORK, s as never, NOW)).toEqual(["iMac"]);
    expect(activeElsewhere(HOME, s as never, NOW)).toBeNull();
    expect(activeElsewhere(WORK, s as never, NOW + ELSEWHERE_FRESH_MS + 2000)).toBeNull();
    expect(activeElsewhere(WORK, null, NOW)).toBeNull();
  });

  it("shows no account warning just because another deck is on the same login", () => {
    expect(accountIssue({ error: null }, NOW_SEC)).toBeNull();
    const html = row(account({ active: true }));
    expect(html).not.toContain("Also active");
    expect(html).not.toContain('class="ap-issue"');
  });

  it("keeps switching available on an account also in use by a peer", () => {
    expect(accountIssue({ error: null }, NOW_SEC)).toBeNull();
    const html = row(account());
    expect(html).not.toContain("Also active");
    expect(html).toContain('title="Switch to work@example.test"');
  });

  it("preserves genuine login errors and collector warnings", () => {
    const dead = { error: null, stopped: true, collector: "relogin_required" };
    expect(accountIssue(dead, NOW_SEC)?.text).toBe("Login expired");
    expect(row(account({ active: true, error: "invalid_grant" }))).not.toContain("Also active");
    const quiet = { error: null, stopped: true, collector: null };
    expect(accountIssue(quiet, NOW_SEC)?.text).toBe("Not collecting");
    expect(accountIssue({ ...dead, error: "invalid_grant" }, NOW_SEC)?.tone).toBe("warn");
    expect(accountIssue(dead, NOW_SEC, { noCopyWorksNearby: true })?.text).toBe("Login expired on all online decks");
  });

  // THE IN-USE RULE AND THE UI READ DIFFERENT WORDS. A paired deck's list
  // goes through the real manifest (lan-manifest.mjs, both ends): the login a
  // deck is on is kept on that deck and marked `inUse`, and this deck's own
  // live login is marked "in use here". Neither mark means that an account
  // needs attention merely because another machine is using it.
  it("does not alert on an account in use locally or on another deck", () => {
    const rows = manifestRows;
    const heard = heardFrom;
    const shown = SHOWN;
    const live = account({ active: true, num: 1 });
    const warns = (s: Status) => {
      const decks = activeElsewhere(WORK, s as never, NOW);
      return {
        decks,
        issue: accountIssue(live, NOW_SEC)?.text ?? null,
        row: row(live).includes("Also active"),
      };
    };
    const silent = { decks: null, issue: null, row: false };

    // This deck's own live login, which the in-use rule keeps here: marked so
    // in this deck's own list, and no deck has said anything about it.
    const mine = offeredHere(lanAccounts([live, account({ num: 2, email: "home@example.test", orgUuid: "org-h" })]), { sendInUse: false });
    expect(mine[0]).toMatchObject({ key: WORK, inUse: true, shareable: false });
    expect(warns(status([]))).toEqual(silent);
    expect(warns(heard(rows(HOME), { shared: [] }))).toEqual(silent);

    // A paired deck keeping ITS live login there: listed in use, and named as
    // the one it is on, which is not this deck's.
    const onHome = heard(rows(HOME), shown);
    expect(onHome.peers[0].offers?.accounts).toContainEqual({ key: HOME, email: "home@example.test", alive: true, shareable: false, inUse: true });
    expect(onHome.peers[0].offers?.current).toEqual({ key: HOME });
    expect(warns(onHome)).toEqual(silent);

    // On this deck's login, and hiding which one: the in-use rule leaves that
    // login out of its list and the deck says `hidden`, so nothing names it.
    const hidden = heard(rows(WORK), { ...shown, shareActive: false });
    expect(hidden.peers[0].offers?.current).toEqual({ hidden: true });
    expect(hidden.peers[0].offers?.accounts?.map(a => a.key)).toEqual([HOME]);
    expect(warns(hidden)).toEqual(silent);

    // On this deck's login, not ticked for this deck: it says `other`.
    const unticked = heard(rows(WORK), { ...shown, shared: [HOME] });
    expect(unticked.peers[0].offers?.current).toEqual({ other: true });
    expect(warns(unticked)).toEqual(silent);

    // And the one case that is a deck saying so: on this deck's login, ticked
    // and shown. Its list marks that login in use, without raising an alert.
    const both = heard(rows(WORK), shown);
    expect(both.peers[0].offers?.current).toEqual({ key: WORK });
    expect(both.peers[0].offers?.accounts).toContainEqual({ key: WORK, email: "work@example.test", alive: true, shareable: false, inUse: true });
    expect(warns(both)).toEqual({ decks: ["studio"], issue: null, row: false });
    // The same word as currentFor gives it on its own.
    expect(currentFor(rows(WORK), [WORK, HOME], true)).toEqual({ current: { key: WORK } });
  });
});
