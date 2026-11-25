// #1579, then internal #94: with nine or more accounts in Other accounts, the
// list stood in slot order and every row had to be opened on its own. #1579
// gave it a menu of orders and "expand all"; the owner then asked for one
// order instead of the menu — the accounts a switch can use now on top, the
// ones it cannot below them — and no sort control at all (internal #94).
//
// What these pin: the availability groups and their order, slot order inside
// each, model windows left out; "expand all" as a mode that a row's own press
// still works inside; the hold that keeps rows still under a reader; what is
// kept in the browser; and the fold's row, which has expand-all and no order.
//
// CHANGED ON PURPOSE (internal #94): the menu of orders, its stored choice and
// the bold "sorted by" figure in each row are gone, and so are their tests.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Account } from "../claude-accounts";
import { laneKey } from "../lane-open";
import {
  allOpen, availability, byAvailability, holdOrder, isOpen, NEAR_WEEK_PCT, NONE_OPEN, rowKey, toggleAll,
  toggleOne, trimOpenness, type Openness,
} from "../other-accounts-order";
import AccountRow from "../components/AccountRow";
import { quotaLevel } from "../components/QuotaBar";
import { usageReport } from "../accounts-usage-report";
import { loadOpenness, saveOpenness } from "../accounts-prefs";
import OtherAccounts from "../components/OtherAccounts";
import { sourceOf } from "./client-source";
import { sheetText } from "./sheet-source";

const NOW = 1_800_000_000;
const lane = (id: string, label: string, pct: number, resetAt: number | null = null) => ({ id, label, pct, resetAt });
function acct(num: number, p5: number | null, p7: number | null, models: [string, number][] = [], over: Partial<Account> = {}): Account {
  const lanes = [
    ...(p5 == null ? [] : [lane("five_hour", "5h", p5)]),
    ...(p7 == null ? [] : [lane("seven_day", "7d", p7)]),
    ...models.map(([m, p], i) => lane(`scoped-${i}`, m, p)),
  ];
  return {
    num, email: `a${num}@x.io`, alias: null, org: null, active: false, disabled: false, lanes,
    headroom: lanes.length ? 100 - Math.max(...lanes.map(l => l.pct)) : null,
    fetchedAt: null, nextAt: null, stale: false, error: null, ...over,
  };
}

const LIST = [acct(5, 12, 48, [["Opus", 30]]), acct(8, 97, 88), acct(9, 0, 5), acct(10, 45, 91, [["Sonnet", 60]]), acct(16, 100, 57)];
const nums = (xs: Account[]) => xs.map(a => a.num);
const OPEN = { reachable: true, rateLimited: false };
const all = () => OPEN;

describe("where an account stands (internal #94)", () => {
  // CHANGED ON PURPOSE (near the weekly limit): a week at 90% or more is a
  // group of its own, under the usable and the not read yet, so every number
  // past "usable" moved down by one and 99/99 is no longer usable.
  it("is usable with every window read, running and under 100%, the week under 90%", () => {
    expect(availability(acct(1, 0, 0), OPEN, NOW)).toBe(0);
    expect(availability(acct(1, 99, 89), OPEN, NOW)).toBe(0);
    expect(availability(acct(1, 99, 99), OPEN, NOW)).toBe(2);
  });

  it("puts a spent week below a full 5-hour window, whatever that 5-hour window says", () => {
    expect(availability(acct(1, 0, 100), OPEN, NOW)).toBe(4);
    expect(availability(acct(1, 100, 100), OPEN, NOW)).toBe(4);
    expect(availability(acct(1, 100, 40), OPEN, NOW)).toBe(3);
  });

  it("waits on a rate limit, as on a full window", () => {
    expect(availability(acct(1, 10, 10), { reachable: true, rateLimited: true }, NOW)).toBe(3);
  });

  it("calls an account with no reading, or a window that reset since it was read, not read yet", () => {
    expect(availability(acct(1, null, null), OPEN, NOW)).toBe(1);
    const reset = { ...acct(1, 10, 10), lanes: [lane("five_hour", "5h", 95, NOW - 60), lane("seven_day", "7d", 10, NOW + 3600)] };
    expect(availability(reset, OPEN, NOW)).toBe(1);
    // A full week that reset since it was read is no longer a spent week.
    const weekBack = { ...acct(1, 10, 10), lanes: [lane("five_hour", "5h", 10, NOW + 60), lane("seven_day", "7d", 100, NOW - 60)] };
    expect(availability(weekBack, OPEN, NOW)).toBe(1);
  });

  it("puts what no switch reaches at the bottom, ahead of every reading", () => {
    expect(availability(acct(1, 0, 0), { reachable: false, rateLimited: false }, NOW)).toBe(5);
    expect(availability(acct(1, 0, 100), { reachable: false, rateLimited: true }, NOW)).toBe(5);
  });

  it("leaves a model's own window out: a full Opus stops that model, not the account", () => {
    expect(availability(acct(1, 10, 10, [["Opus", 100]]), OPEN, NOW)).toBe(0);
    expect(availability(acct(1, null, null, [["Opus", 10]]), OPEN, NOW)).toBe(1);
  });
});

describe("the order", () => {
  it("lists the usable accounts first, then not read, waiting, week spent and out of reach", () => {
    const roster = [
      acct(1, 10, 100),                                   // week spent
      acct(2, 5, 5, [], { disabled: true }),              // out of reach
      acct(3, 100, 20),                                   // waiting
      acct(4, null, null),                                // not read yet
      acct(5, 40, 40),                                    // usable
    ];
    const reach = (a: Account) => ({ reachable: !a.disabled, rateLimited: false });
    expect(nums(byAvailability(roster, reach, NOW))).toEqual([5, 4, 3, 1, 2]);
  });

  it("puts an account with room above one whose week is spent, whatever their 5-hour windows say", () => {
    expect(nums(byAvailability([acct(1, 0, 100), acct(2, 95, 60)], all, NOW))).toEqual([2, 1]);
  });

  it("keeps slot order inside a group, so a poll that changes a number moves nothing", () => {
    // All five are usable but 10, near its weekly limit at 91%, and 16, whose
    // 5-hour window is full. CHANGED ON PURPOSE (near the weekly limit): 10
    // no longer stands among the usable, so reversed it stays under them.
    expect(nums(byAvailability(LIST, all, NOW))).toEqual([5, 8, 9, 10, 16]);
    expect(nums(byAvailability([...LIST].reverse(), all, NOW))).toEqual([9, 8, 5, 10, 16]);
    expect(nums(byAvailability([acct(12, 40, 0), acct(3, 90, 0), acct(7, 1, 0)], all, NOW))).toEqual([12, 3, 7]);
  });

  it("moves an account up once a fresh reading says it has room", () => {
    const before = [acct(2, null, null), acct(3, 30, 30)];
    expect(nums(byAvailability(before, all, NOW))).toEqual([3, 2]);
    const after = [acct(2, 10, 10), acct(3, 30, 30)];
    expect(nums(byAvailability(after, all, NOW))).toEqual([2, 3]);
  });

  it("takes reach and rate limits from the caller, the row's own rules", () => {
    const can = (a: Account) => ({ reachable: a.num !== 9, rateLimited: a.num === 5 });
    expect(nums(byAvailability(LIST, can, NOW))).toEqual([8, 10, 5, 16, 9]);
  });
});

describe("an account near its weekly limit", () => {
  // Windows with a reset still ahead, as the server sends them for a reading
  // that is current.
  const at = (num: number, p5: number, p7: number, resets: { five?: number; week?: number } = {}, over: Partial<Account> = {}): Account => ({
    ...acct(num, p5, p7, [], over),
    lanes: [lane("five_hour", "5h", p5, resets.five ?? NOW + 3600), lane("seven_day", "7d", p7, resets.week ?? NOW + 3 * 86_400)],
  });

  it("goes below a usable account, as reported: 99% and 93% of the week above one at 20%", () => {
    const roster = [at(1, 10, 99), at(2, 5, 93), at(3, 15, 20)];
    expect(nums(byAvailability(roster, all, NOW))).toEqual([3, 1, 2]);
  });

  it("starts at 90% of the week, the level the weekly bar turns red at", () => {
    expect(NEAR_WEEK_PCT).toBe(90);
    // One number with the meters: the row a poll moves down is the one whose
    // bar already wears the error ink, and the one just under it does not.
    expect(quotaLevel(NEAR_WEEK_PCT)).toBe("err");
    expect(quotaLevel(NEAR_WEEK_PCT - 1)).not.toBe("err");
    expect(availability(at(1, 0, 89), OPEN, NOW)).toBe(0);
    expect(availability(at(1, 0, 90), OPEN, NOW)).toBe(2);
    expect(availability(at(1, 0, 93), OPEN, NOW)).toBe(2);
    expect(availability(at(1, 0, 99), OPEN, NOW)).toBe(2);
    expect(availability(at(1, 0, 100), OPEN, NOW)).toBe(4);
  });

  it("orders 93%, 99% and 100% of the week: usable, then near, then waiting, then spent", () => {
    const roster = [at(1, 0, 100), at(2, 10, 99), at(3, 100, 20), at(4, 5, 93), at(5, 15, 20)];
    expect(nums(byAvailability(roster, all, NOW))).toEqual([5, 2, 4, 3, 1]);
  });

  it("keeps slot order among near accounts, so a week going from 93% to 95% moves nothing", () => {
    expect(nums(byAvailability([at(4, 0, 93), at(2, 0, 99), at(7, 0, 91)], all, NOW))).toEqual([4, 2, 7]);
    expect(nums(byAvailability([at(4, 0, 95), at(2, 0, 99), at(7, 0, 91)], all, NOW))).toEqual([4, 2, 7]);
  });

  it("does not count the 5-hour window: 97% of it with 20% of the week is still usable", () => {
    expect(availability(at(1, 97, 20), OPEN, NOW)).toBe(0);
    expect(nums(byAvailability([at(1, 5, 93), at(2, 97, 20)], all, NOW))).toEqual([2, 1]);
  });

  it("puts a week at 20% with the 5-hour window spent after the usable ones and the near ones", () => {
    const roster = [at(1, 100, 20), at(2, 10, 99), at(3, 10, 30)];
    expect(nums(byAvailability(roster, all, NOW))).toEqual([3, 2, 1]);
    // Near the week and out of 5 hours, or rate limited: waiting wins.
    expect(availability(at(1, 100, 95), OPEN, NOW)).toBe(3);
    expect(availability(at(1, 10, 95), { reachable: true, rateLimited: true }, NOW)).toBe(3);
  });

  it("stays near while the 5-hour window has reset since it was read: a running week only grows", () => {
    const fiveBack = at(1, 40, 95, { five: NOW - 60 });
    expect(availability(fiveBack, OPEN, NOW)).toBe(2);
    // And a usable week with the same reset is not read yet, above it.
    expect(nums(byAvailability([fiveBack, at(2, 40, 20, { five: NOW - 60 })], all, NOW))).toEqual([2, 1]);
  });

  it("moves back up once the week resets: not read yet at once, and on top with the fresh reading", () => {
    const usable = at(3, 15, 20);
    const near = at(4, 5, 93);
    const before = [at(2, 10, 99), usable, near];
    expect(nums(byAvailability(before, all, NOW))).toEqual([3, 2, 4]);
    // The reset time passed: its 99% belongs to a week that is over.
    const passed = [at(2, 10, 99, { week: NOW - 60 }), usable, near];
    expect(availability(passed[0], OPEN, NOW)).toBe(1);
    expect(nums(byAvailability(passed, all, NOW))).toEqual([3, 2, 4]);
    expect(nums(byAvailability([near, ...passed.slice(0, 2)], all, NOW))).toEqual([3, 2, 4]);
    // The reading after the reset confirms the room: usable, in slot order.
    const read = [at(2, 0, 2, { week: NOW + 7 * 86_400 }), usable, near];
    expect(nums(byAvailability(read, all, NOW))).toEqual([2, 3, 4]);
  });

  it("orders a stale reading by its numbers, as before: the age is the row's to say", () => {
    const old = { stale: true, fetchedAt: (NOW - 42 * 60) * 1000 };
    expect(availability(at(1, 20, 30, {}, old), OPEN, NOW)).toBe(0);
    expect(availability(at(1, 20, 93, {}, old), OPEN, NOW)).toBe(2);
    expect(availability({ ...acct(1, null, null), stale: true }, OPEN, NOW)).toBe(1);
  });

  it("leaves a signed-out or held-out account at the bottom, whatever its week says", () => {
    const shut = { reachable: false, rateLimited: false };
    expect(availability(at(1, 0, 20), shut, NOW)).toBe(5);
    expect(availability(at(1, 0, 93), shut, NOW)).toBe(5);
    const reach = (a: Account) => ({ reachable: a.num !== 1 && !a.disabled, rateLimited: false });
    const roster = [at(1, 0, 5), at(2, 0, 93), at(3, 0, 100), at(4, 0, 10, {}, { disabled: true }), at(5, 0, 20)];
    expect(nums(byAvailability(roster, reach, NOW))).toEqual([5, 2, 3, 1, 4]);
  });

  it("never calls 93% or 99% of the week a weekly limit, on the row or in the capacity report", () => {
    const shut = (a: Account) => renderToStaticMarkup(createElement(AccountRow, {
      a, nowSec: NOW, opened: false, onToggleLanes: () => {}, busy: null, pressProps: () => ({}),
      onSwitch: () => {}, menuOpen: false, onOpenMenu: () => {}, onCloseMenu: () => {}, refusal: null,
      onDismissRefusal: () => {}, switchedHere: false, swapped: null, displaced: undefined,
      issueExpanded: false, onOpenIssue: () => {},
    } as never));
    for (const p7 of [93, 99]) {
      const html = shut(at(2, 10, p7, {}, { fetchedAt: (NOW - 60) * 1000 }));
      expect(html).toContain(`${p7}%`);
      expect(html).not.toContain("Weekly limit");
      expect(html).not.toMatch(/used up|exhausted/i);
    }
    expect(shut(at(2, 10, 100, {}, { fetchedAt: (NOW - 60) * 1000 }))).toContain("Weekly limit");
    const report = usageReport([at(2, 10, 93), at(3, 10, 99), at(4, 10, 100), at(5, 100, 100)], NOW).rows.map(r => r.status);
    expect(report).toEqual(["ready", "ready", "limited", "exhausted"]);
  });
});

describe("the hold", () => {
  it("keeps the order the reader found, through a poll that moves an account to another group", () => {
    const found = byAvailability(LIST, all, NOW);
    const held = found.map(laneKey);
    const polled = byAvailability([acct(9, 100, 5), ...LIST.filter(a => a.num !== 9)], all, NOW);
    expect(nums(holdOrder(polled, held))).toEqual(nums(found));
    // And lets the fresh order land once nobody is there.
    expect(nums(holdOrder(polled, null))).toEqual([5, 8, 10, 9, 16]);
  });

  it("adds an account that arrived at the end, and drops one that left", () => {
    const held = LIST.map(laneKey);
    const now = [...LIST.filter(a => a.num !== 8), acct(2, 50, 50)];
    expect(nums(holdOrder(byAvailability(now, all, NOW), held))).toEqual([5, 9, 10, 16, 2]);
  });
});

describe("which rows are open", () => {
  it("starts with none, and a row's own press opens and shuts it", () => {
    let s: Openness = NONE_OPEN;
    s = toggleOne(s, LIST[1]);
    expect(LIST.map(a => isOpen(s, a))).toEqual([false, true, false, false, false]);
    s = toggleOne(s, LIST[1]);
    expect(LIST.some(a => isOpen(s, a))).toBe(false);
  });

  it("opens every row at once, and shuts them all when all are open", () => {
    let s = toggleAll(NONE_OPEN, LIST);
    expect(allOpen(s, LIST)).toBe(true);
    s = toggleAll(s, LIST);
    expect(s).toEqual(NONE_OPEN);
  });

  it("opens the rest when some were opened one by one, rather than shutting those", () => {
    const some = toggleOne(NONE_OPEN, LIST[0]);
    expect(allOpen(some, LIST)).toBe(false);
    expect(allOpen(toggleAll(some, LIST), LIST)).toBe(true);
  });

  it("still lets a row be shut and reopened after everything was opened", () => {
    let s = toggleAll(NONE_OPEN, LIST);
    s = toggleOne(s, LIST[2]);
    expect(isOpen(s, LIST[2])).toBe(false);
    expect(allOpen(s, LIST)).toBe(false);
    s = toggleOne(s, LIST[2]);
    expect(allOpen(s, LIST)).toBe(true);
  });

  it("holds 'all' for an account signed in after it was pressed", () => {
    const s = toggleAll(NONE_OPEN, LIST);
    expect(isOpen(s, acct(22, 1, 1))).toBe(true);
  });

  it("follows the account, not the slot it stands in (#542)", () => {
    const s = toggleOne(NONE_OPEN, acct(5, 1, 1));
    expect(isOpen(s, { ...acct(5, 1, 1), num: 11 })).toBe(true);
    expect(isOpen(s, { ...acct(6, 1, 1), num: 5 })).toBe(false);
  });

  it("forgets an account that left, and changes nothing on a poll nobody left", () => {
    const s = toggleOne(toggleOne(NONE_OPEN, LIST[0]), LIST[1]);
    const trimmed = trimOpenness(s, LIST.slice(1));
    expect(trimmed.keys).toEqual([rowKey(LIST[1])]);
    expect(trimOpenness(s, LIST)).toBe(s);
    expect(trimOpenness(s, null)).toBe(s);
  });

  it("forgets a shut exception in 'all' mode the same way, so the account comes back open", () => {
    const s = toggleOne(toggleAll(NONE_OPEN, LIST), LIST[0]);
    const trimmed = trimOpenness(s, LIST.slice(1));
    expect(trimmed).toEqual({ mode: "all", keys: [] });
    expect(isOpen(trimmed, LIST[0])).toBe(true);
  });

  it("is still all open when the one row shut is the live account, which is not in the list", () => {
    const live = { ...acct(1, 50, 50), active: true };
    const s = toggleOne(toggleAll(NONE_OPEN, LIST), live);
    expect(allOpen(s, LIST)).toBe(true);
  });

  it("names a row by a hash of its account, so the store holds no address", () => {
    const k = rowKey(LIST[0]);
    expect(k).toMatch(/^h:[0-9a-z]+$/);
    expect(k).not.toContain("@");
    expect(rowKey({ ...LIST[0], num: 99 })).toBe(k);
    // An account with no address keeps the slot name, which is never written down.
    expect(rowKey({ num: 7, email: null })).toBe("slot:7");
  });

  it("says nothing is all open when there is nothing to open", () => {
    expect(allOpen(toggleAll(NONE_OPEN, LIST), [])).toBe(false);
  });
});

describe("what the browser keeps", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
      },
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("keeps the open rows between reloads, with no address in them", () => {
    const s = toggleOne(toggleAll(NONE_OPEN, LIST), LIST[3]);
    saveOpenness(s);
    expect(loadOpenness()).toEqual(s);
    expect(store.get("agent-dag.otherAccountsOpen")).not.toContain("@");
  });

  it("never writes a slot's name down, since whoever stands there next is not who was opened (#542)", () => {
    saveOpenness({ mode: "some", keys: ["slot:4", rowKey(LIST[0])] });
    expect(loadOpenness()).toEqual({ mode: "some", keys: [rowKey(LIST[0])] });
  });

  it("falls back to nothing open for what it cannot read", () => {
    expect(loadOpenness()).toEqual(NONE_OPEN);
    for (const raw of ["not json", "null", '{"mode":"every","keys":[]}', '{"mode":"all","keys":[1,2]}', '{"mode":"all"}']) {
      store.set("agent-dag.otherAccountsOpen", raw);
      expect(loadOpenness(), raw).toEqual(NONE_OPEN);
    }
  });

  it("does not take the panel down with a store that throws", () => {
    vi.stubGlobal("window", { get localStorage(): Storage { throw new Error("blocked"); } });
    expect(loadOpenness()).toEqual(NONE_OPEN);
    expect(() => saveOpenness(NONE_OPEN)).not.toThrow();
  });

  it("no longer reads or writes an order (internal #94)", () => {
    const prefs = sourceOf("accounts-prefs.ts");
    expect(prefs).not.toMatch(/export function (load|save)Order/);
    expect(prefs).not.toMatch(/ORDER_KEY/);
  });
});

describe("the fold's own row", () => {
  const props = (over: Record<string, unknown> = {}) => ({
    peers: [], strained: false, armed: false, threshold: null, open: true, onToggle: () => {},
    allOpen: false, onToggleAll: () => {}, ...over,
  });
  const html = (over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(OtherAccounts, props(over)));

  it("draws expand-all only while the list is open", () => {
    expect(html()).toContain('class="ap-rest-all"');
    expect(html({ open: false })).not.toContain("ap-rest-all");
  });

  it("has no order control, open or shut (internal #94)", () => {
    for (const out of [html(), html({ open: false })]) {
      expect(out).not.toContain("ap-rest-sort");
      expect(out).not.toContain('aria-haspopup="menu"');
      expect(out).not.toContain("<select");
    }
  });

  it("keeps expand-all a sibling of the row's button, never inside it", () => {
    const out = html();
    const button = out.slice(out.indexOf('<button type="button" id="ap-rest-entry"'), out.indexOf("</button>") + 9);
    expect(button).not.toContain("ap-rest-all");
    expect(out.indexOf("ap-rest-all")).toBeGreaterThan(out.indexOf("</button>"));
  });

  it("makes expand-all a toggle with one name, pressed while every row is open", () => {
    // A name that changed under focus is one most screen readers never announce.
    expect(html({ allOpen: false })).toMatch(/aria-label="Expand every account" aria-pressed="false" aria-controls="ap-rest-list" title="Expand every account"/);
    expect(html({ allOpen: true })).toMatch(/aria-label="Expand every account" aria-pressed="true" aria-controls="ap-rest-list" title="Collapse every account"/);
  });
});

describe("the row marks no figure as the one it was sorted by", () => {
  const row = (a: Account, opened = false) => renderToStaticMarkup(createElement(AccountRow, {
    a, nowSec: 1_790_000_000, opened, onToggleLanes: () => {}, busy: null, pressProps: () => ({}),
    onSwitch: () => {}, menuOpen: false, onOpenMenu: () => {}, onCloseMenu: () => {}, refusal: null,
    onDismissRefusal: () => {}, switchedHere: false, swapped: null, displaced: undefined,
    issueExpanded: false, onOpenIssue: () => {},
  } as never));

  // CHANGED ON PURPOSE (internal #94): with one order the bold "sorted by"
  // figure has nothing left to say, so no row draws it, shut or open.
  it("shut or open", () => {
    expect(row(LIST[3])).not.toContain("data-sort-key");
    expect(row(LIST[3], true)).not.toContain("data-sort-key");
    expect(sheetText()).not.toContain("data-sort-key");
  });
});

describe("the panel's wiring", () => {
  const panel = sourceOf("components/AccountsPanel.tsx");

  it("starts every visit with the rows folded, and stores no order", () => {
    // CHANGED ON PURPOSE (compact accounts, #2539): the openness is not read
    // back, so every visit opens folded. (internal #94): nor is any order.
    expect(panel).toContain("useState<Openness>(NONE_OPEN)");
    expect(panel).not.toContain("loadOpenness");
    expect(panel).not.toContain("saveOpenness");
    expect(panel).not.toMatch(/loadOrder|saveOrder/);
  });

  it("orders the list usable first, with the row's own reach and rate limit, and holds it while a reader is in it", () => {
    expect(panel).toMatch(/const rest = holdOrder\(byAvailability\(others, a => \(\{\s*reachable: reachable\(a, nowSec\),\s*rateLimited: accountIssue\(a, nowSec\)\?\.kind === "rate",\s*\}\), nowSec\), held\);/);
    expect(panel).toMatch(/<ul className="ap-list ap-others" id="ap-rest-list" \{\.\.\.listHold\}>/);
  });

  it("holds for the pointer, the keyboard's focus only, and a row's open menu", () => {
    // Every way in takes the order once; letting go asks all three.
    expect(panel).toMatch(/onPointerEnter: \(\) => \{ pointerIn\.current = true; take\(\); \}/);
    expect(panel).toMatch(/onPointerLeave: \(\) => \{ pointerIn\.current = false; letGo\(\); \}/);
    expect(panel).toMatch(/if \(\(e\.target as Element\)\.matches\(":focus-visible"\)\) \{ keysIn\.current = true; take\(\); \}/);
    expect(panel).toMatch(/if \(!pointerIn\.current && !keysIn\.current && !popoverIn\.current\) setHeld\(null\);/);
    expect(panel).toMatch(/const popoverHolds = \(menuFor != null && others\.some\(a => a\.num === menuFor\)\)/);
  });

  it("lets go of a list that is not on screen", () => {
    expect(panel).toMatch(/const listShown = restOpen && others\.length > 0;/);
    expect(panel).toMatch(/if \(listShown\) return;\s*pointerIn\.current = keysIn\.current = popoverIn\.current = false;\s*setHeld\(null\);/);
  });

  it("opens the fold as it was left on Claude's side, and keeps nothing else about it", () => {
    // CHANGED ON PURPOSE (remembered fold, 2026-11-24): the fold no longer shuts
    // every time the panel opens. Only its own open or shut is kept, under
    // Claude's key; the rows behind it still open folded (above), and no order
    // is stored.
    expect(panel).toContain('const [restOpen, setRestOpen] = useState<boolean>(() => loadFoldOpen("claude"));');
    expect(panel).not.toContain('loadFoldOpen("codex")');
  });

  it("orders the Codex column by the same rule, with its own row's issue", () => {
    const codex = sourceOf("components/CodexProfilesSection.tsx");
    expect(codex).toMatch(/const rest = byAvailability\(otherAccounts, a => \{/);
    expect(codex).toContain('return { reachable: !a.disabled && !row?.issue?.blocksSwitch, rateLimited: row?.issue?.kind === "rate" };');
    expect(codex).not.toMatch(/loadOrder|saveOrder|sortAccounts|orderChoices/);
  });
});

describe("the sheet", () => {
  const css = sheetText();
  it("draws expand-all quiet at rest and neutral under the pointer, and keeps no order control", () => {
    const MOUSE = "@media (hover: hover) and (pointer: fine) {\n";
    // The keyboard's rule on its own, the pointer's under the mouse query
    // (hover is for mice), both the same neutral edge, text and fill.
    const NEUTRAL = "{ border-color: var(--ctl-edge); color: var(--text); background: var(--ctl-fill); }";
    expect(css).toContain(`.ap-rest-all:focus-visible ${NEUTRAL}`);
    expect(css).toContain(`${MOUSE}.ap-rest-all:hover ${NEUTRAL}\n}`);
    // Pressed — every row open — keeps the fill.
    expect(css).toContain('.ap-rest-all[aria-pressed="true"] { background: var(--ctl-fill); color: var(--text); }');
    expect(css).not.toContain("ap-rest-sort");
    expect(css).not.toContain("ap-sort-pop");
  });
});
