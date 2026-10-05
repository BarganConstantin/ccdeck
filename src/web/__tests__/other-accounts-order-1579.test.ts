// #1579: with nine or more accounts in Other accounts, the list stood in slot
// order and every row had to be opened on its own — and shut again with the
// panel. It can now be ordered by how full each account is, every row opened
// or shut at once, and both are kept between reloads.
//
// What these pin: the orders on offer and what each does, including where an
// unread account goes; "expand all" as a mode that a row's own press still
// works inside; the hold that keeps rows still under a reader; what is kept in
// the browser and what an unreadable store falls back to; and the controls in
// the fold's row, which the issue asked for instead of a row of buttons.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Account } from "../claude-accounts";
import { laneKey } from "../lane-open";
import {
  allOpen, holdOrder, isOpen, NONE_OPEN, orderChoices, orderKey, rowKey, SLOT_ORDER, sortAccounts, toggleAll,
  toggleOne, trimOpenness, validOrder, type Openness,
} from "../other-accounts-order";
import AccountRow from "../components/AccountRow";
import { loadOpenness, loadOrder, saveOpenness, saveOrder } from "../accounts-prefs";
import OtherAccounts from "../components/OtherAccounts";
import { sourceOf } from "./client-source";
import { sheetText } from "./sheet-source";

const lane = (id: string, label: string, pct: number) => ({ id, label, pct, resetAt: null });
function acct(num: number, p5: number | null, p7: number | null, models: [string, number][] = []): Account {
  const lanes = [
    ...(p5 == null ? [] : [lane("five_hour", "5h", p5)]),
    ...(p7 == null ? [] : [lane("seven_day", "7d", p7)]),
    ...models.map(([m, p], i) => lane(`scoped-${i}`, m, p)),
  ];
  return {
    num, email: `a${num}@x.io`, alias: null, org: null, active: false, disabled: false, lanes,
    headroom: lanes.length ? 100 - Math.max(...lanes.map(l => l.pct)) : null,
    fetchedAt: null, nextAt: null, stale: false, error: null,
  };
}

const LIST = [acct(5, 12, 48, [["Opus", 30]]), acct(8, 97, 88), acct(9, 0, 5), acct(10, 45, 91, [["Sonnet", 60]]), acct(16, 100, 57)];
const nums = (xs: Account[]) => xs.map(a => a.num);

describe("the orders on offer", () => {
  it("are slot, fullest and emptiest by each window the accounts have, and room", () => {
    expect(orderChoices(LIST).map(c => c.id)).toEqual([
      "slot", "5h:full", "5h:empty", "7d:full", "7d:empty",
      "Opus:full", "Opus:empty", "Sonnet:full", "Sonnet:empty", "room",
    ]);
    expect(orderChoices(LIST).find(c => c.id === "7d:empty")?.label).toBe("7d · emptiest");
  });

  it("offer no model a store does not have", () => {
    expect(orderChoices([acct(1, 10, 10)]).map(c => c.id)).toEqual(["slot", "5h:full", "5h:empty", "7d:full", "7d:empty", "room"]);
  });
});

describe("sorting", () => {
  it("is the roster's own order for slot — claude-swap's sequence, which the live row follows too", () => {
    expect(nums(sortAccounts(LIST, SLOT_ORDER))).toEqual([5, 8, 9, 10, 16]);
    expect(nums(sortAccounts([...LIST].reverse(), SLOT_ORDER))).toEqual([16, 10, 9, 8, 5]);
  });

  it("puts the fullest first, or the emptiest", () => {
    expect(nums(sortAccounts(LIST, "5h:full"))).toEqual([16, 8, 10, 5, 9]);
    expect(nums(sortAccounts(LIST, "5h:empty"))).toEqual([9, 5, 10, 8, 16]);
    expect(nums(sortAccounts(LIST, "7d:full"))).toEqual([10, 8, 16, 5, 9]);
  });

  it("sorts by a model window, and puts the accounts without one last", () => {
    // Two Opus readings that run against slot order, so the sort has to act.
    const opus = [acct(2, 1, 1, [["Opus", 20]]), acct(3, 1, 1), acct(4, 1, 1, [["Opus", 80]])];
    expect(nums(sortAccounts(opus, "Opus:full"))).toEqual([4, 2, 3]);
    expect(nums(sortAccounts(opus, "Opus:empty"))).toEqual([2, 4, 3]);
    expect(nums(sortAccounts(LIST, "Sonnet:empty"))).toEqual([10, 5, 8, 9, 16]);
  });

  it("puts the accounts nobody can switch to after the rest, in the two orders that answer 'where next'", () => {
    const can = (a: Account) => a.num !== 9;
    // Emptiest first and most room: 9 is the emptiest, and held out.
    expect(nums(sortAccounts(LIST, "5h:empty", can))).toEqual([5, 10, 8, 16, 9]);
    expect(nums(sortAccounts(LIST, "room", can))).toEqual([5, 10, 8, 16, 9]);
    // Fullest first is what is about to run out, and every account is in that answer.
    expect(nums(sortAccounts(LIST, "5h:full", can))).toEqual([16, 8, 10, 5, 9]);
    expect(nums(sortAccounts(LIST, "7d:full", can))).toEqual([10, 8, 16, 5, 9]);
  });

  it("names what it sorts by, for the rows to mark", () => {
    expect(orderKey("5h:full")).toBe("5h");
    expect(orderKey("Opus:empty")).toBe("Opus");
    expect(orderKey("room")).toBe("room");
    expect(orderKey(SLOT_ORDER)).toBeNull();
  });

  it("puts an unread account last in either direction, never at the top of 'emptiest'", () => {
    const withUnread = [...LIST, acct(3, null, null)];
    expect(nums(sortAccounts(withUnread, "5h:empty"))[0]).toBe(9);
    expect(nums(sortAccounts(withUnread, "5h:empty")).at(-1)).toBe(3);
    expect(nums(sortAccounts(withUnread, "5h:full")).at(-1)).toBe(3);
    expect(nums(sortAccounts(withUnread, "room")).at(-1)).toBe(3);
  });

  it("orders by room the way the deck ranks where to go: the most headroom first", () => {
    expect(nums(sortAccounts(LIST, "room"))).toEqual([9, 5, 10, 8, 16]);
  });

  it("keeps the roster's order between two accounts at the same reading", () => {
    expect(nums(sortAccounts([acct(12, 40, 0), acct(3, 40, 0), acct(7, 40, 0)], "5h:full"))).toEqual([12, 3, 7]);
  });

  it("falls back to slot order for an order it does not know or can no longer apply", () => {
    for (const o of ["", "bogus", "Opus:sideways", "Haiku:full", "constructor"]) {
      expect(nums(sortAccounts(LIST, o)), o).toEqual([5, 8, 9, 10, 16]);
    }
    expect(validOrder("Haiku:full", LIST)).toBe(SLOT_ORDER);
    expect(validOrder("Opus:full", LIST)).toBe("Opus:full");
    expect(validOrder(null, LIST)).toBe(SLOT_ORDER);
  });
});

describe("the hold", () => {
  it("keeps the order the reader found, through a poll that moves the numbers", () => {
    const found = sortAccounts(LIST, "5h:full");
    const held = found.map(laneKey);
    const polled = sortAccounts([acct(9, 99, 5), ...LIST.filter(a => a.num !== 9)], "5h:full");
    expect(nums(holdOrder(polled, held))).toEqual(nums(found));
    // And lets the fresh order land once nobody is there.
    expect(nums(holdOrder(polled, null))).toEqual([16, 9, 8, 10, 5]);
  });

  it("adds an account that arrived at the end, and drops one that left", () => {
    const held = LIST.map(laneKey);
    const now = [...LIST.filter(a => a.num !== 8), acct(2, 50, 50)];
    expect(nums(holdOrder(sortAccounts(now, SLOT_ORDER), held))).toEqual([5, 9, 10, 16, 2]);
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

  it("keeps the order and the open rows between reloads", () => {
    saveOrder("7d:empty");
    const s = toggleOne(toggleAll(NONE_OPEN, LIST), LIST[3]);
    saveOpenness(s);
    expect(loadOrder()).toBe("7d:empty");
    expect(loadOpenness()).toEqual(s);
    expect(store.get("agent-dag.otherAccountsOpen")).not.toContain("@");
  });

  it("never writes a slot's name down, since whoever stands there next is not who was opened (#542)", () => {
    saveOpenness({ mode: "some", keys: ["slot:4", rowKey(LIST[0])] });
    expect(loadOpenness()).toEqual({ mode: "some", keys: [rowKey(LIST[0])] });
  });

  it("falls back to slot order and nothing open for what it cannot read", () => {
    expect(loadOrder()).toBe(SLOT_ORDER);
    expect(loadOpenness()).toEqual(NONE_OPEN);
    for (const raw of ["not json", "null", '{"mode":"every","keys":[]}', '{"mode":"all","keys":[1,2]}', '{"mode":"all"}']) {
      store.set("agent-dag.otherAccountsOpen", raw);
      expect(loadOpenness(), raw).toEqual(NONE_OPEN);
    }
    store.set("agent-dag.otherAccountsOrder", "x".repeat(500));
    expect(loadOrder()).toBe(SLOT_ORDER);
  });

  it("does not take the panel down with a store that throws", () => {
    vi.stubGlobal("window", { get localStorage(): Storage { throw new Error("blocked"); } });
    expect(loadOrder()).toBe(SLOT_ORDER);
    expect(loadOpenness()).toEqual(NONE_OPEN);
    expect(() => saveOrder("5h:full")).not.toThrow();
  });
});

describe("the controls, in the fold's own row", () => {
  const props = (over: Record<string, unknown> = {}) => ({
    peers: [], strained: false, armed: false, threshold: null, open: true, onToggle: () => {},
    order: "5h:full", choices: orderChoices(LIST), onOrder: () => {}, allOpen: false, onToggleAll: () => {},
    ...over,
  });
  const html = (over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(OtherAccounts, props(over)));

  it("are drawn only while the list is open", () => {
    expect(html()).toContain('class="ap-rest-tools"');
    expect(html({ open: false })).not.toContain("ap-rest-tools");
  });

  it("are siblings of the row's button, never inside it", () => {
    const out = html();
    const button = out.slice(out.indexOf('<button type="button" id="ap-rest-entry"'), out.indexOf("</button>") + 9);
    expect(button).not.toContain("ap-rest-tools");
    expect(out.indexOf("ap-rest-tools")).toBeGreaterThan(out.indexOf("</button>"));
  });

  it("show the order the list is in, and every order on offer", () => {
    const out = html();
    expect(out).toContain('aria-label="Order of the other accounts"');
    expect(out).toContain('<option value="5h:full" selected="">5h · fullest</option>');
    expect(out.match(/<option /g)).toHaveLength(orderChoices(LIST).length);
    // Sorted is said at full contrast; slot is the quiet default.
    expect(out).toContain("data-sorted");
    expect(html({ order: SLOT_ORDER })).not.toContain("data-sorted");
  });

  it("make expand-all a toggle with one name, pressed while every row is open", () => {
    // A name that changed under focus is one most screen readers never announce.
    expect(html({ allOpen: false })).toMatch(/aria-label="Expand every account" aria-pressed="false" aria-controls="ap-rest-list" title="Expand every account"/);
    expect(html({ allOpen: true })).toMatch(/aria-label="Expand every account" aria-pressed="true" aria-controls="ap-rest-list" title="Collapse every account"/);
  });

  it("mark the order held, and say why, while the reader is in the list", () => {
    expect(html({ held: true })).toContain("data-held");
    expect(html({ held: true })).toContain('title="5h · fullest — held where it was while you are in the list"');
    expect(html({ held: false })).not.toContain("data-held");
    expect(html({ held: false })).toContain('title="5h · fullest"');
  });
});

describe("the row marks the number it was placed by", () => {
  const row = (a: Account, sortKey: string | null, opened = false) => renderToStaticMarkup(createElement(AccountRow, {
    a, nowSec: 1_790_000_000, opened, onToggleLanes: () => {}, busy: null, pressProps: () => ({}),
    onSwitch: () => {}, menuOpen: false, onOpenMenu: () => {}, onCloseMenu: () => {}, refusal: null,
    onDismissRefusal: () => {}, switchedHere: false, swapped: null, displaced: undefined,
    issueExpanded: false, onOpenIssue: () => {}, sortKey,
  } as never));
  const marked = (html: string) => [...html.matchAll(/class="ap-(?:q|lane)" data-sort-key=""[^]*?(?:ap-q-label|ap-lane-label)[^>]*>([^<]+)</g)].map(m => m[1]);

  it("in the shut line and on the bars", () => {
    expect(marked(row(LIST[3], "7d"))).toEqual(["7d"]);
    expect(marked(row(LIST[3], "7d", true))).toEqual(["7d"]);
  });

  it("marks the tightest window under 'room', and nothing in slot order", () => {
    expect(marked(row(LIST[3], "room"))).toEqual(["7d"]);
    expect(row(LIST[3], null)).not.toContain("data-sort-key");
  });
});

describe("the panel's wiring", () => {
  const panel = sourceOf("components/AccountsPanel.tsx");

  it("reads the rows' openness and the order from the browser's store, and writes them back", () => {
    expect(panel).toContain("useState<Openness>(loadOpenness)");
    expect(panel).toContain("useEffect(() => { saveOpenness(openness); }, [openness]);");
    expect(panel).toContain("useState<string>(loadOrder)");
    expect(panel).toContain("useEffect(() => { saveOrder(order); }, [order]);");
  });

  it("orders the list with reachability, and holds it while a reader is in it", () => {
    expect(panel).toMatch(/const rest = holdOrder\(sortAccounts\(others, shownOrder, a => reachable\(a, nowSec\), nowSec\), held\);/);
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

  it("still shuts the fold every time the panel opens", () => {
    expect(panel).toContain("const [restOpen, setRestOpen] = useState(false);");
  });
});

describe("the sheet", () => {
  const css = sheetText();
  it("draws the controls quiet at rest and neutral under the pointer", () => {
    expect(css).toMatch(/\.ap-rest-sort select \{[^}]*border: 1px solid transparent;[^}]*color: var\(--muted\);/);
    expect(css).toContain(".ap-rest-sort select:hover,\n.ap-rest-sort select:focus-visible { border-color: var(--ctl-edge); color: var(--text); background: var(--ctl-fill); }");
    expect(css).toContain(".ap-rest-all:hover,\n.ap-rest-all:focus-visible { border-color: var(--ctl-edge); color: var(--text); background: var(--ctl-fill); }");
  });
});
