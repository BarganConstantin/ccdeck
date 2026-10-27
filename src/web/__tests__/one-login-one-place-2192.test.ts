// One login, live in one place (#2192): account sharing and in-use rules.
//
// A Claude refresh token renews once: the copy that renews it first keeps the
// login, and every other copy is refused from then on, so two machines on one
// copied login race at every renewal and the loser is signed out ("Login
// expired · Please run /login"). This pins what crosses the wire about the
// login a deck is signed in to, and how both ends draw it:
//
//   - the login a deck is on is listed and not given, in a shape an older deck
//     already obeys, and refused when an older deck asks for it anyway;
//   - "Send the login this deck is using too" is a new switch that ships off;
//   - this deck's setup and a deck's lanes say "in use" rather than "cannot
//     share";
//   - a paired deck on the same login raises no account warning: real login
//     problems still do.
//
// Auto-switch may still move to a login a paired deck is on (3.43.3).
//
// Pure functions only: no socket, no process, no file. lan-serve.test.ts drives
// `serve` itself through the same answer, and live-login-lan-2192.test.ts two
// whole decks on loopback.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// @ts-expect-error — plain .mjs server module, no types
import { currentFor, heardCurrent, IN_USE, manifestFor, mayGiveInUse, offered, peerWhy, plan } from "../../server/lan-sync.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { createManifests } from "../../server/lan-manifest.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { DEFAULTS, normalise } from "../../server/deck-prefs.mjs";
import { accountIssue } from "../account-issue";
import { lanAccounts, offeredHere } from "../account-lan";
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

  // WHAT A PAIRED DECK SAYS STILL CROSSES THE WIRE. A paired deck's list goes
  // through the real manifest (lan-manifest.mjs, both ends): the login a deck
  // is on is kept on that deck and marked `inUse`, and the deck may name it as
  // `current`. Decks older than this one read that word for their own warning,
  // so it keeps its shape; this deck draws nothing from it.
  it("keeps the in-use marks and the deck's word on the wire", () => {
    const live = account({ active: true, num: 1 });

    // This deck's own live login, which the in-use rule keeps here.
    const mine = offeredHere(lanAccounts([live, account({ num: 2, email: "home@example.test", orgUuid: "org-h" })]), { sendInUse: false });
    expect(mine[0]).toMatchObject({ key: WORK, inUse: true, shareable: false });

    // A paired deck keeping ITS live login there: listed in use, and named as
    // the one it is on.
    const onHome = heardFrom(manifestRows(HOME), SHOWN);
    expect(onHome.peers[0].offers?.accounts).toContainEqual({ key: HOME, email: "home@example.test", alive: true, shareable: false, inUse: true });
    expect(onHome.peers[0].offers?.current).toEqual({ key: HOME });

    // On this deck's login, and hiding which one: the in-use rule leaves that
    // login out of its list and the deck says `hidden`.
    const hidden = heardFrom(manifestRows(WORK), { ...SHOWN, shareActive: false });
    expect(hidden.peers[0].offers?.current).toEqual({ hidden: true });
    expect(hidden.peers[0].offers?.accounts?.map(a => a.key)).toEqual([HOME]);

    // On this deck's login, not ticked for this deck: it says `other`.
    const unticked = heardFrom(manifestRows(WORK), { ...SHOWN, shared: [HOME] });
    expect(unticked.peers[0].offers?.current).toEqual({ other: true });

    // On this deck's login, ticked and shown: named, and marked in use.
    const both = heardFrom(manifestRows(WORK), SHOWN);
    expect(both.peers[0].offers?.current).toEqual({ key: WORK });
    expect(both.peers[0].offers?.accounts).toContainEqual({ key: WORK, email: "work@example.test", alive: true, shareable: false, inUse: true });
    expect(currentFor(manifestRows(WORK), [WORK, HOME], true)).toEqual({ current: { key: WORK } });
  });
});
