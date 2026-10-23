// One login, live in one place (#2192): the in-use refusal, and the warning.
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
//   - the live account's row: "Also active on <deck>", from that word and
//     nothing else, so it never fires for a login the in-use rule keeps here;
//   - the desktop notification, once per incident, from the same word.
//
// Auto-switch is not here: it may move to a login a paired deck is on (3.43.3),
// and the warning is what says so once it has.
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
// @ts-expect-error — plain .mjs server module, no types
import { createAccountNotifier, elsewhereNotice } from "../../server/account-notify.mjs";
import { accountIssue, elsewhereIssue } from "../account-issue";
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

  it("is a new switch that ships off, and a saved choice is kept", () => {
    expect(DEFAULTS.lan.sendInUse).toBe(false);
    expect(normalise({ lan: {} }).lan.sendInUse).toBe(false);
    expect(normalise({ lan: { sendInUse: true } }).lan.sendInUse).toBe(true);
    expect(normalise({ lan: { sendInUse: "yes" } }).lan.sendInUse).toBe(false);
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
  const row = (a: Account, elsewhere: readonly string[] | null) => renderToStaticMarkup(createElement(AccountRow, {
    a, nowSec: NOW_SEC, lan: { sharedTo: null, elsewhere }, opened: false, onToggleLanes: () => {}, busy: null,
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

  it("warns on the live row, which is what the notice over the list reads", () => {
    const issue = accountIssue({ error: null, active: true }, NOW_SEC, { elsewhere: ["iMac"] });
    expect(issue).toMatchObject({ text: "Also active on iMac", tone: "warn", fix: null, blocksSwitch: false });
    expect(issue!.hint).toContain("iMac is using this login right now as well.");
    expect(issue!.hint).toContain("the other is signed out");
    expect(issue!.hint).toContain("Signing in on each machine separately");
    expect(elsewhereIssue(["iMac", "PC"]).hint).toMatch(/^iMac and PC are using/);
    const html = row(account({ active: true }), ["iMac"]);
    expect(html).toMatch(/class="ap-issue" data-tone="warn"[^>]*>[\s\S]*?Also active on iMac/);
  });

  // Auto-switch may move here (3.43.3), and a person may: the row to switch to
  // keeps its Switch as it was, and the warning is the live row's once it lands.
  it("says nothing on a row to switch to", () => {
    expect(accountIssue({ error: null, active: false }, NOW_SEC, { elsewhere: ["iMac"] })).toBeNull();
    const html = row(account(), ["iMac"]);
    expect(html).not.toContain("Active on");
    expect(html).not.toContain("Also active");
    expect(html).toContain('title="Switch to work@example.test"');
  });

  it("says nothing while no deck is on it", () => {
    expect(accountIssue({ error: null, active: true }, NOW_SEC, { elsewhere: null })).toBeNull();
    expect(accountIssue({ error: null, active: true }, NOW_SEC, { elsewhere: [] })).toBeNull();
    expect(row(account({ active: true }), null)).not.toContain("Also active");
  });

  it("gives way to a problem the reader has to act on, and outranks a quieter one", () => {
    const dead = { error: null, stopped: true, collector: "relogin_required", active: true };
    expect(accountIssue(dead, NOW_SEC, { elsewhere: ["iMac"] })?.text).toBe("Login expired");
    const quiet = { error: null, stopped: true, collector: null, active: true };
    expect(accountIssue(quiet, NOW_SEC)?.text).toBe("Not collecting");
    expect(accountIssue(quiet, NOW_SEC, { elsewhere: ["iMac"] })?.text).toBe("Also active on iMac");
    // On a row to switch to, its own news stays.
    expect(accountIssue({ ...quiet, active: false }, NOW_SEC, { elsewhere: ["iMac"] })?.text).toBe("Not collecting");
  });

  // THE IN-USE RULE AND THE WARNING READ DIFFERENT WORDS. A paired deck's list
  // goes through the real manifest (lan-manifest.mjs, both ends): the login a
  // deck is on is kept on that deck and marked `inUse`, and this deck's own
  // live login is marked "in use here". Neither mark is a deck saying where it
  // is, and the warning is built from that saying alone.
  it("never fires for a login the in-use rule keeps local", () => {
    const rows = manifestRows;
    const heard = heardFrom;
    const shown = SHOWN;
    const live = account({ active: true, num: 1 });
    const warns = (s: Status) => {
      const decks = activeElsewhere(WORK, s as never, NOW);
      return {
        decks,
        issue: accountIssue(live, NOW_SEC, { elsewhere: decks })?.text ?? null,
        row: row(live, decks).includes("Also active"),
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
    // and shown. Its list marks that login in use, and the warning names it.
    const both = heard(rows(WORK), shown);
    expect(both.peers[0].offers?.current).toEqual({ key: WORK });
    expect(both.peers[0].offers?.accounts).toContainEqual({ key: WORK, email: "work@example.test", alive: true, shareable: false, inUse: true });
    expect(warns(both)).toEqual({ decks: ["studio"], issue: "Also active on studio", row: true });
    // The same word as currentFor gives it on its own.
    expect(currentFor(rows(WORK), [WORK, HOME], true)).toEqual({ current: { key: WORK } });
  });
});

// ── the notification ────────────────────────────────────────────────────────

describe("the desktop notification", () => {
  type Settings = { swap: boolean; quota: boolean; reset: boolean; stopped: boolean; elsewhere: boolean };
  function harness(settings: Settings = { swap: true, quota: false, reset: false, stopped: true, elsewhere: true }) {
    const said: Array<{ title: string; body: string }> = [];
    const errors: unknown[] = [];
    const n = createAccountNotifier({
      notify: (title: string, body: string) => { said.push({ title, body }); },
      settings: () => settings,
      product: "ccdeck",
      now: () => NOW,
      load: async () => null,
      save: async () => {},
      later: () => 0,
      onError: (err: unknown) => errors.push(err),
    });
    return { n, said, settings, errors };
  }
  const ON_WORK = { key: WORK, name: "work@example.test" };
  const ON_HOME = { key: HOME, name: "home" };

  it("is said once for as long as both decks are on the login, however often it is asked", async () => {
    const { n, said, errors } = harness();
    for (let i = 0; i < 5; i++) await n.elsewhere(ON_WORK, ["iMac"]);
    expect(said).toEqual([{
      title: "Claude · work@example.test — ccdeck",
      body: "Also active on iMac. When one machine renews this login, the other is signed out — use a different account on one of them.",
    }]);
    expect(errors).toEqual([]);
  });

  it("is said again for a new incident, and not for the end of one", async () => {
    const { n, said } = harness();
    await n.elsewhere(ON_WORK, ["iMac"]);
    // The other deck moved off it: the incident closes, silently.
    await n.elsewhere(ON_WORK, []);
    await n.elsewhere(null, []);
    expect(said).toHaveLength(1);
    // And back on it: that is news again.
    await n.elsewhere(ON_WORK, ["iMac"]);
    expect(said).toHaveLength(2);
    // This deck moved to another login a deck is on: a different incident.
    await n.elsewhere(ON_HOME, ["PC"]);
    expect(said.map(s => s.title)).toEqual([
      "Claude · work@example.test — ccdeck", "Claude · work@example.test — ccdeck", "Claude · home — ccdeck",
    ]);
  });

  it("is not said with its switch off, and an incident that opened unsaid stays unsaid", async () => {
    const { n, said, settings } = harness({ swap: true, quota: false, reset: false, stopped: true, elsewhere: false });
    await n.elsewhere(ON_WORK, ["iMac"]);
    settings.elsewhere = true;
    await n.elsewhere(ON_WORK, ["iMac"]);
    expect(said).toEqual([]);
    await n.elsewhere(ON_WORK, []);
    await n.elsewhere(ON_WORK, ["iMac"]);
    expect(said).toHaveLength(1);
  });

  it("names every deck on it", () => {
    expect(elsewhereNotice({ accountName: "work", decks: ["iMac", "PC"] }).body).toMatch(/^Also active on iMac and PC\. /);
  });

  // The same in-use cases as the row's, through the door the notifier reads
  // (account-watch.mjs watchElsewhereOnce asks elsewhereNow, then this).
  it("is never said for a login the in-use rule keeps local", async () => {
    const { n, said } = harness();
    const ask = async (s: Status) => {
      connectLanStatus(() => s);
      await n.elsewhere(ON_WORK, elsewhereNow(NOW).get(WORK) ?? []);
    };
    try {
      await ask(status([]));
      await ask(heardFrom(manifestRows(HOME), SHOWN));
      await ask(heardFrom(manifestRows(WORK), { ...SHOWN, shareActive: false }));
      await ask(heardFrom(manifestRows(WORK), { ...SHOWN, shared: [HOME] }));
      await ask(heardFrom(manifestRows(WORK), { shared: [] }));
      expect(said).toEqual([]);
      // The one that is a deck saying so.
      await ask(heardFrom(manifestRows(WORK), SHOWN));
      expect(said.map(s => s.body)).toEqual([expect.stringMatching(/^Also active on studio\. /)]);
    } finally {
      connectLanStatus(null);
    }
  });
});
