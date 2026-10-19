// One login, live in one place (#2192).
//
// A Claude refresh token renews once: the copy that renews it first keeps the
// login, and every other copy is refused from then on, so two machines on one
// copied login race at every renewal and the loser is signed out ("Login
// expired · Please run /login"). Local network already says which account each
// paired deck is on; this pins what the deck now does with that word:
//
//   - which deck is on which login, and for how long its word counts
//     (lan-elsewhere.mjs), and that a deck too old to say anything is read as
//     saying nothing;
//   - what crosses the wire: the login a deck is on is listed and not given,
//     in a shape an older deck already obeys, and refused when an older deck
//     asks for it anyway;
//   - what the account's row says, and the Switch beside it;
//   - the desktop notification, once per incident;
//   - the auto-switch tick kept off a login another deck is on, without
//     touching the rotation the owner set.
//
// Pure functions and the factories' injected doors only: no socket, no process,
// no file. account-notify-wiring.test.ts drives the same rules through the real
// roster and loop.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  connectLanStatus, decksByAccount, deckList, deckName, ELSEWHERE_FRESH_MS, elsewhereNow, namesByAccount,
} from "../../server/lan-elsewhere.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { heardCurrent, IN_USE, manifestFor, mayGiveInUse, offered, peerWhy, plan } from "../../server/lan-sync.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { createAccountNotifier, elsewhereNotice } from "../../server/account-notify.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { holdable, releaseLeft, steeredTick, switchTarget } from "../../server/cswap-tick-holds.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { accountKey } from "../../server/lan-copies.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { DEFAULTS, normalise } from "../../server/deck-prefs.mjs";
import { accountIssue, elsewhereIssue } from "../account-issue";
import { activeElsewhere, lanAccounts, offeredHere } from "../account-lan";
import AccountRow from "../components/AccountRow";
import type { Account } from "../claude-accounts";
import { exchangeLanes } from "../lan-exchange";
import { laneSaid } from "../lan-peer";
import type { LanAccount } from "../lan-types";

const NOW = 1_790_000_000_000;
const WORK = "work@example.test@@org-w";
const HOME = "home@example.test@@org-h";

type PeerRow = {
  fp: string; peerFp?: string | null; name?: string; addr?: string; paired?: boolean;
  offers?: { at: number; current?: unknown; accounts?: unknown[] } | null;
};

/** A paired deck on the LAN that last said, `ago` ms back, it is on `key`. */
function deck(name: string, key: string | null, ago = 30_000, over: Partial<PeerRow> = {}): PeerRow {
  return {
    fp: `fp-${name}`, name, addr: "192.168.1.20", paired: true,
    offers: { at: NOW - ago, accounts: [], ...(key ? { current: { key } } : {}) },
    ...over,
  };
}

function status(peers: PeerRow[], over: Record<string, unknown> = {}) {
  return { enabled: true, peers, addrs: ["192.168.1.10"], aliases: {}, ...over };
}

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
    for (const current of [{ hidden: true }, { other: true }, null, { key: "" }, { key: 7 }]) {
      const p = deck("iMac", null);
      p.offers = { at: NOW - 1000, accounts: [], current };
      expect(decksByAccount(status([p]), NOW).size, JSON.stringify(current)).toBe(0);
    }
    // A deck older than 3.22.15 sends no `current` at all.
    expect(decksByAccount(status([deck("old", null)]), NOW).size).toBe(0);
    // And one that never sent a list has nothing to read.
    expect(decksByAccount(status([deck("new", WORK, 0, { offers: null })]), NOW).size).toBe(0);
    expect(decksByAccount(status([deck("odd", WORK, 0, { offers: { at: Number.NaN, current: { key: WORK } } })]), NOW).size).toBe(0);
  });

  it("is nothing from a deck that is not paired, or while Local network is off", () => {
    expect(decksByAccount(status([deck("near", WORK, 1000, { paired: false })]), NOW).size).toBe(0);
    expect(decksByAccount(status([deck("iMac", WORK)], { enabled: false }), NOW).size).toBe(0);
    expect(decksByAccount(null, NOW).size).toBe(0);
    expect(decksByAccount(undefined, NOW).size).toBe(0);
  });

  it("does not count a second deck on this same machine, which shares the login rather than copying it", () => {
    for (const addr of ["127.0.0.1", "::1", "localhost", "192.168.1.10"]) {
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
    // And the deck's `current` for it is still kept, which is what the warning reads.
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
    // (lan-serve.test.ts drives `serve` itself through the same answer.)
  });

  it("is a new switch that ships off, and a saved choice is kept", () => {
    expect(DEFAULTS.lan.sendInUse).toBe(false);
    expect(normalise({ lan: {} }).lan.sendInUse).toBe(false);
    expect(normalise({ lan: { sendInUse: true } }).lan.sendInUse).toBe(true);
    // The shareActive switch is untouched: it is what the warning reads.
    expect(normalise({ lan: { shareActive: false } }).lan.shareActive).toBe(false);
    expect(DEFAULTS.notifyElsewhere).toBe(true);
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
});

// ── the account's row ───────────────────────────────────────────────────────

describe("an account's row, when a paired deck is on that login", () => {
  const NOW_SEC = NOW / 1000;
  const account = (over: Partial<Account> = {}): Account => ({
    num: 2, email: "work@example.test", alias: null, org: null, orgUuid: "org-w", active: false, disabled: false,
    lanes: [], headroom: 80, fetchedAt: NOW - 60_000, nextAt: null, stale: false, error: null, ...over,
  });
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
    expect(elsewhereIssue(["iMac", "PC"], true).hint).toMatch(/^iMac and PC are using/);
    const html = row(account({ active: true }), ["iMac"]);
    expect(html).toMatch(/class="ap-issue" data-tone="warn"[^>]*>[\s\S]*?Also active on iMac/);
  });

  it("says it quietly on a row to switch to, and the Switch says what it costs", () => {
    const issue = accountIssue({ error: null, active: false }, NOW_SEC, { elsewhere: ["iMac"] });
    expect(issue).toMatchObject({ text: "Active on iMac", tone: "quiet", blocksSwitch: false });
    expect(issue!.hint).toContain("auto-switch leaves it alone");
    const html = row(account(), ["iMac"]);
    expect(html).toMatch(/class="ap-issue" data-tone="quiet"[^>]*>[\s\S]*?Active on iMac/);
    // Still a Switch — a person may choose it — titled with the risk.
    expect(html).toContain('title="Switch to work@example.test — iMac is using this login right now, and when one machine renews it the other is signed out"');
    expect(html).toContain('aria-label="Switch to work@example.test"');
  });

  it("says nothing while no deck is on it", () => {
    expect(accountIssue({ error: null, active: true }, NOW_SEC, { elsewhere: null })).toBeNull();
    expect(accountIssue({ error: null, active: true }, NOW_SEC, { elsewhere: [] })).toBeNull();
    const html = row(account(), null);
    expect(html).not.toContain("Active on");
    expect(html).toContain('title="Switch to work@example.test"');
  });

  it("gives way to a problem the reader has to act on, and outranks a quieter one on the live row", () => {
    const dead = { error: null, stopped: true, collector: "relogin_required", active: true };
    expect(accountIssue(dead, NOW_SEC, { elsewhere: ["iMac"] })?.text).not.toContain("iMac");
    const quiet = { error: null, stopped: true, collector: null, active: true };
    expect(accountIssue(quiet, NOW_SEC)?.text).toBe("Not collecting");
    expect(accountIssue(quiet, NOW_SEC, { elsewhere: ["iMac"] })?.text).toBe("Also active on iMac");
    // On a row to switch to, its own news stays; the Switch's title carries the risk.
    expect(accountIssue({ ...quiet, active: false }, NOW_SEC, { elsewhere: ["iMac"] })?.text).toBe("Not collecting");
  });

  it("is told which one is live, so the setup can say why it is not sent", () => {
    const [on, off] = lanAccounts([account({ active: true, num: 1 }), account({ num: 2, email: "home@example.test" })]);
    expect(on.active).toBe(true);
    expect(off).not.toHaveProperty("active");
  });
});

// ── the notification ────────────────────────────────────────────────────────

describe("the desktop notification", () => {
  type Settings = { swap: boolean; quota: boolean; reset: boolean; elsewhere: boolean };
  function harness(settings: Settings = { swap: true, quota: false, reset: false, elsewhere: true }) {
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
    const { n, said, settings } = harness({ swap: true, quota: false, reset: false, elsewhere: false });
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
});

// ── the auto-switch ─────────────────────────────────────────────────────────

describe("the auto-switch tick, kept off a login another deck is on", () => {
  const roster = [
    { num: 1, email: "now@example.test", orgUuid: "org-n", active: true, disabled: false },
    { num: 2, email: "work@example.test", orgUuid: "org-w", active: false, disabled: false },
    { num: 3, email: "home@example.test", orgUuid: "org-h", active: false, disabled: false },
    { num: 4, email: "spare@example.test", orgUuid: "org-s", active: false, disabled: false },
  ];
  const on = (...keys: string[]) => new Map(keys.map(k => [k, ["iMac"]]));
  const W = accountKey("work@example.test", "org-w");
  const H = accountKey("home@example.test", "org-h");

  /** claude-swap, as far as a tick sees it: what each verb answers, and every
   *  call made, in order. */
  function cswap({ probe = null as number | null, picks = 4 as number | null, refuse = [] as string[] } = {}) {
    const calls: string[] = [];
    const journal: Array<unknown> = [];
    const switchLine = (n: number | null, dry: boolean) => (n == null
      ? JSON.stringify({ event: "poll", active: { number: 1 } })
      : `${JSON.stringify({ event: "poll" })}\n${JSON.stringify({ event: "switch", dryRun: dry, to: { number: n, email: "x@example.test" } })}`);
    const run = async (_bin: string, args: string[]) => {
      const call = args.join(" ");
      calls.push(call);
      if (refuse.includes(call)) return { ok: false, code: 1, stdout: "", stderr: "no" };
      if (args[0] === "auto") return { ok: true, code: 0, stdout: switchLine(args.includes("--dry-run") ? probe : picks, args.includes("--dry-run")) };
      return { ok: true, code: 0, stdout: "", stderr: "" };
    };
    const book = {
      keep: async (list: Array<{ num: number }>) => { journal.push(list.map(h => h.num)); },
      drop: async () => { journal.push("dropped"); },
    };
    return { run, calls, journal, book };
  }

  it("holds out the logins a paired deck is on, but never the live one or one the owner held out", () => {
    const rows = [
      ...roster,
      { num: 5, email: "held@example.test", orgUuid: "org-x", active: false, disabled: true },
      { num: 0, email: "zero@example.test", orgUuid: "org-z", active: false, disabled: false },
      { num: 6, email: null, orgUuid: "org-q", active: false, disabled: false },
    ];
    const keys = on(W, H, accountKey("now@example.test", "org-n"), accountKey("held@example.test", "org-x"), accountKey("zero@example.test", "org-z"));
    expect(holdable(rows, keys, accountKey)).toEqual([
      { num: 2, email: "work@example.test", org: "org-w", decks: ["iMac"] },
      { num: 3, email: "home@example.test", org: "org-h", decks: ["iMac"] },
    ]);
    expect(holdable(rows, new Map(), accountKey)).toEqual([]);
    expect(holdable(null, keys, accountKey)).toEqual([]);
  });

  it("reads where claude-swap says a tick goes", () => {
    expect(switchTarget('{"event":"poll"}\n{"event":"switch","dryRun":true,"to":{"number":3,"email":"a@b"}}')).toBe(3);
    expect(switchTarget('{"event":"switch","to":2}')).toBe(2);
    expect(switchTarget('{"event":"poll"}')).toBeNull();
    expect(switchTarget("not json\n")).toBeNull();
    expect(switchTarget('{"event":"switch","to":{"number":"x"}}')).toBeNull();
    expect(switchTarget(undefined)).toBeNull();
  });

  it("is the tick as it always was while no paired deck is on any of these logins", async () => {
    const c = cswap();
    const { r, held } = await steeredTick({ run: c.run, bin: "cswap", timeout: 1, holds: [], journal: c.book });
    expect(c.calls).toEqual(["auto --once --json"]);
    expect(r.ok).toBe(true);
    expect(held).toEqual([]);
    expect(c.journal).toEqual([]);
  });

  it("asks first, and changes nothing when the tick would stay put or land somewhere else", async () => {
    for (const probe of [null, 4]) {
      const c = cswap({ probe });
      const { held } = await steeredTick({ run: c.run, bin: "cswap", timeout: 1, holds: holdable(roster, on(W), accountKey), journal: c.book });
      expect(c.calls, String(probe)).toEqual(["auto --once --json --dry-run", "auto --once --json"]);
      expect(held).toEqual([]);
      expect(c.journal).toEqual([]);
    }
  });

  it("holds every such login out for the one tick that would land on one, and puts each back", async () => {
    const c = cswap({ probe: 2, picks: 4 });
    const holds = holdable(roster, on(W, H), accountKey);
    const { r, held } = await steeredTick({ run: c.run, bin: "cswap", timeout: 1, holds, journal: c.book });
    expect(c.calls).toEqual([
      "auto --once --json --dry-run",
      // Both, not only the one the probe named: holding only that one would
      // let the tick land on the next.
      "disable 2", "disable 3",
      "auto --once --json",
      "enable 2", "enable 3",
    ]);
    expect(switchTarget(r.stdout)).toBe(4);
    expect(held.map((h: { num: number }) => h.num)).toEqual([2, 3]);
    // Written down before the first hold, and struck once all are back.
    expect(c.journal).toEqual([[2, 3], "dropped"]);
  });

  it("does not run the tick when the hold that mattered did not take", async () => {
    const c = cswap({ probe: 2, refuse: ["disable 2"] });
    const { r, held } = await steeredTick({ run: c.run, bin: "cswap", timeout: 1, holds: holdable(roster, on(W, H), accountKey), journal: c.book });
    expect(r).toEqual({ skipped: "hold-failed" });
    expect(c.calls).toEqual(["auto --once --json --dry-run", "disable 2", "disable 3", "enable 3"]);
    expect(held.map((h: { num: number }) => h.num)).toEqual([3]);
    expect(c.journal).toEqual([[2, 3], "dropped"]);
  });

  it("keeps a hold it could not put back written down, for the next start", async () => {
    const c = cswap({ probe: 2, refuse: ["enable 2"] });
    await steeredTick({ run: c.run, bin: "cswap", timeout: 1, holds: holdable(roster, on(W), accountKey), journal: c.book });
    expect(c.journal).toEqual([[2], [2]]);
  });

  it("puts back at the next start only what it held and still holds the same login", async () => {
    const c = cswap();
    const now = [
      { num: 2, email: "work@example.test", orgUuid: "org-w", disabled: true },
      // Somebody else's slot number since: not ours to lift.
      { num: 3, email: "someone@example.test", orgUuid: "org-o", disabled: true },
      // Already back in rotation.
      { num: 4, email: "spare@example.test", orgUuid: "org-s", disabled: false },
    ];
    const left = [
      { num: 2, email: "work@example.test", org: "org-w" },
      { num: 3, email: "home@example.test", org: "org-h" },
      { num: 4, email: "spare@example.test", org: "org-s" },
      { num: 9, email: "gone@example.test", org: "org-g" },
    ];
    await releaseLeft({ run: c.run, bin: "cswap", left, accounts: now, keyOf: accountKey, journal: c.book });
    expect(c.calls).toEqual(["enable 2"]);
    expect(c.journal).toEqual(["dropped"]);
    // Nothing left is nothing done.
    const d = cswap();
    await releaseLeft({ run: d.run, bin: "cswap", left: [], accounts: now, keyOf: accountKey, journal: d.book });
    expect(d.calls).toEqual([]);
    expect(d.journal).toEqual([]);
  });
});
