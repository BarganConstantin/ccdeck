// The occasional doors behind a More on each stripe (V4 design review, point 4).
//
// Fifteen doors stood on the two stripes even on an empty board, the ones used
// every hour beside the ones used once a week. Each stripe now keeps the doors
// used all day — Sessions, Accounts and the connected trackers on the left; the
// Inspector, Usage and This machine on the right — and a More at its foot for
// the rest, on the side where their dialogs belong: the capacity reports,
// Explore and Radio on the left; the three records and the two watchers on the
// right. Every door keeps its key and its row in Quick open.
//
// Pinned here, run on fake-react.ts's React: what each stripe draws and what
// its More holds, in which runs; that a More with nothing in it is not drawn;
// the count and the dot on More; its open look while a dialog behind it is up;
// a menu row's key, seen and not said; focus handed back to More before a
// dialog opens; Up and Down left to the stripe's toolbar; the menu opening
// over the canvas; and that the keys and Quick open still reach every door.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { all, mount, one, textOf, type Drawn } from "./fake-react";
import { sheetRules } from "./sheet-cascade";
import { sourceOf } from "./client-source";

vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("react-dom", async (orig) => ({ ...(await orig<typeof import("react-dom")>()), createPortal: (node: unknown) => node }));
let singleKeys = true;
vi.mock("../use-single-key-shortcuts", () => ({ useSingleKeyShortcuts: () => singleKeys }));
/** What each hint was bound to, newest last. */
let hints: unknown[] = [];
vi.mock("../components/use-hint", () => ({
  useHint: () => ({ bind: (spec: unknown) => { hints.push(spec); return { onFocus: () => {} }; }, node: null }),
}));

const { EdgeDock, EdgeRail } = await import("../components/EdgeRails");
const { default: AnchoredPopover } = await import("../components/AnchoredPopover");
const { railItems } = await import("../rail-items");

const noop = () => {};
const ref = () => ({ current: null });
type Args = Parameters<typeof railItems>[0];

/** The doors as App.tsx defines them, every dialog wired, with what a case asks for. */
function rails(over: Partial<Args> = {}, providers = { claude: true, codex: true }) {
  return railItems({
    providers: { kind: "reported", ...providers },
    sessionListOpen: false, toggleSessionList: noop, accountsPanelOpen: false, toggleAccountsPanel: noop,
    usagePanelOpen: false, setUsagePanelOpen: noop, machinePanelOpen: false, setMachinePanelOpen: noop,
    setUsageHistoryOpen: noop, watchOn: false, watchUnseen: 0, setBrowserWatchOpen: noop,
    setTrafficRadarOpen: noop, setRadioOpen: noop, openToolActivity: noop, openCapacity: noop,
    openSettings: noop, onFeedback: noop, openQuickOpen: noop, openExploreIntegrations: noop,
    toggles: { sessionList: ref(), usage: ref(), accounts: ref(), machine: ref() },
    ...over,
  } as unknown as Args);
}
const jira = { provider: { kind: "jira" as const, label: "Jira", Glyph: () => null, shortcut: "i", detail: { key: "x" } as never }, onPress: noop };

/** The window as matchMedia and the store read it: wide, words on unless said. */
function browser(seed: Record<string, string> = {}) {
  const stored = { ...seed };
  vi.stubGlobal("window", {
    localStorage: { getItem: (k: string) => stored[k] ?? null, setItem: (k: string, v: string) => { stored[k] = v; }, removeItem: noop },
    innerWidth: 1440,
    matchMedia: (q: string) => ({ matches: /min-width/.test(q), addEventListener: noop, removeEventListener: noop }),
    addEventListener: noop, removeEventListener: noop, dispatchEvent: noop,
  });
}
let focused: string[] = [];
beforeEach(() => {
  focused = [];
  hints = [];
  singleKeys = true;
  browser();
  vi.stubGlobal("document", {
    getElementById: (id: string) => ({ focus: () => focused.push(id) }),
    activeElement: null,
    body: {},
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

/** Both stripes exactly as App.tsx draws them. */
function stripes(r = rails()) {
  return {
    left: mount(EdgeRail, { side: "left" as const, label: "Panels and tools", groups: r.leftStripe, more: r.leftMore, foot: r.leftFoot }).tree,
    right: mount(EdgeRail, { side: "right" as const, label: "Usage and activity", groups: r.rightStripe, more: r.rightMore }).tree,
  };
}
const isMore = (e: Drawn) => typeof e.type === "function" && "items" in e.props && "index" in e.props;
/** What a stripe draws, top to bottom: each door by its id, its More as "more", the switch. */
function drawn(tree: unknown): string[] {
  return all(tree, e => (typeof e.type === "function" && "item" in e.props) || isMore(e) || e.props["data-rail-item"] === "stripe-words")
    .map(e => isMore(e) ? "more" : (e.props.item as { id: string } | undefined)?.id ?? "stripe-words");
}
const moreOf = (tree: unknown) => one(tree, isMore);

/** A More run on its own, with its button and, once open, its menu. */
function openMore(tree: unknown) {
  const more = moreOf(tree)!;
  const view = mount(more.type as (p: Record<string, unknown>) => unknown, more.props);
  const button = () => one(view.tree, e => e.type === "button" && e.props["data-rail-item"] === "more")!;
  const menu = () => one(view.tree, e => e.type === AnchoredPopover);
  const press = () => (button().props.onClick as () => void)();
  /** The menu's rows by their words, a rule as "—". */
  const rows = () => all(menu(), e => e.props.role === "menuitem" || e.props.role === "separator")
    .map(e => e.props.role === "separator" ? "—" : textOf((e.props.children as unknown[])[0]));
  const row = (id: string) => one(menu(), e => e.props.role === "menuitem" && e.props["data-rail-item"] === id)!;
  return { view, button, menu, press, rows, row };
}

const OCCASIONAL_LEFT = ["account-capacity", "reset-calendar", "explore-integrations", "radio"];
const OCCASIONAL_RIGHT = ["history", "tool-activity", "skill-activity", "browser-watch", "traffic-radar"];

describe("each stripe keeps its everyday doors, and a More at its foot for the rest", () => {
  it("draws Sessions, Accounts, More, Settings and the switch on the left, and none of the occasional four", () => {
    const { left } = stripes();
    expect(drawn(left)).toEqual(["session-list", "accounts", "more", "settings", "stripe-words"]);
    for (const id of OCCASIONAL_LEFT) expect(drawn(left)).not.toContain(id);
    // More leads the foot, which is pushed down below the doors.
    const foot = one(left, e => e.props.className === "rail-foot")!;
    expect(drawn(foot)).toEqual(["more", "settings", "stripe-words"]);
  });

  it("keeps a connected tracker a door on the left stripe, after Accounts and above the foot", () => {
    const { left } = stripes(rails({ integrations: [jira] }));
    expect(drawn(left)).toEqual(["session-list", "accounts", "integration-jira", "more", "settings", "stripe-words"]);
  });

  it("draws the Inspector, Usage, This machine and More on the right, More alone in its foot, and none of the five", () => {
    const { right } = stripes();
    expect(drawn(right)).toEqual(["inspector", "usage", "machine", "more"]);
    for (const id of OCCASIONAL_RIGHT) expect(drawn(right)).not.toContain(id);
    const foot = one(right, e => e.props.className === "rail-foot")!;
    expect(drawn(foot)).toEqual(["more"]);
    // One control is no group: the foot is the More itself to a screen reader.
    expect(foot.props.role).toBeUndefined();
    expect(foot.props["aria-label"]).toBeUndefined();
  });

  it("lists each More's doors in order, the runs a rule apart", () => {
    const { left, right } = stripes();
    const l = openMore(left);
    l.press();
    expect(l.rows()).toEqual(["Account capacity", "Reset calendar", "—", "Explore integrations", "—", "Radio"]);
    const r = openMore(right);
    r.press();
    expect(r.rows()).toEqual(["Usage history", "Tool activity", "Skill activity", "—", "Browser watch", "Telemetry Radar"]);
    // The separator is the menus' own rule, and no row the arrows land on.
    expect(all(r.menu(), e => e.props.role === "separator").every(e => e.props.className === "ap-menu-sep")).toBe(true);
  });

  it("hides a door in the menu by the rule that hides it today, and a More with nothing is not drawn", () => {
    // No Claude Code: no capacity run, and the left More holds Explore and Radio.
    const codexOnly = stripes(rails({}, { claude: false, codex: true }));
    const l = openMore(codexOnly.left);
    l.press();
    expect(l.rows()).toEqual(["Explore integrations", "—", "Radio"]);
    // Nothing behind it at all: no More, and the foot is Settings and the switch.
    const bare = rails({ openCapacity: undefined, openExploreIntegrations: undefined, setRadioOpen: undefined });
    expect(bare.leftMore).toEqual([]);
    const { left } = stripes(bare);
    expect(moreOf(left)).toBeNull();
    expect(drawn(left)).toEqual(["session-list", "accounts", "settings", "stripe-words"]);
    expect(one(left, e => e.props.className === "rail-foot")!.props["aria-label"]).toBe("Settings, Hide words");
  });

  it("gives every door one place: on a stripe, in a More, or at the foot", () => {
    const r = rails({ integrations: [jira] });
    const placed = [...r.leftStripe.flat(), ...r.leftMore.flat(), ...r.leftFoot, ...r.rightStripe.flat(), ...r.rightMore.flat()].map(i => i.id);
    expect(new Set(placed).size).toBe(placed.length);
    // The fifteen doors every deck has, and the tracker someone connected: all
    // kept, seven of them drawn as doors (the tracker among them) and the
    // other nine behind the two Mores.
    expect(placed).toHaveLength(16);
    expect([...r.leftStripe.flat(), ...r.leftFoot, ...r.rightStripe.flat()]).toHaveLength(7);
  });
});

describe("More on a stripe", () => {
  it("is a menu button named by what it holds, its word 'More' while the words show", () => {
    const { right } = stripes();
    const { button } = openMore(right);
    expect(button().props["aria-haspopup"]).toBe("menu");
    expect(button().props["aria-expanded"]).toBe(false);
    expect(button().props["aria-label"]).toBe("More: Usage history, Tool activity, Skill activity, Browser watch, not watching, Telemetry Radar");
    expect(button().props.className).toBe("rail-btn rail-btn-stripe");
    expect(textOf(one(button(), e => e.props.className === "rail-word"))).toBe("More");
    expect(button().props.id).toBe("rail-more-right");
    expect(button().props["data-more-holds"]).toBe(OCCASIONAL_RIGHT.join(" "));
  });

  it("shows only its glyph with the words hidden, its name and the doors behind it in its hint", () => {
    browser({ "agent-dag.stripeWords": "off" });
    const { left } = stripes();
    expect(moreOf(left)!.props.word).toBeNull();
    hints = [];
    const { button } = openMore(left);
    expect(one(button(), e => e.props.className === "rail-word")).toBeNull();
    expect(hints.at(-1)).toEqual({ label: "More", detail: "Account capacity, Reset calendar, Explore integrations, Radio" });
  });

  it("says in its hint only the doors behind it while its word shows", () => {
    const { left } = stripes();
    hints = [];
    openMore(left);
    expect(hints.at(-1)).toEqual({ label: "", detail: "Account capacity, Reset calendar, Explore integrations, Radio" });
  });

  it("carries the sum of what is unread behind it, in the chrome's grey, and the row says it in words", () => {
    const { right } = stripes(rails({ watchUnseen: 3 }));
    const { button, press, rows } = openMore(right);
    expect(textOf(one(button(), e => e.props.className === "rail-badge"))).toBe("3");
    expect(button().props["aria-label"]).toContain("Browser watch, not watching, 3 unread");
    press();
    expect(rows()).toContain("Browser watch · 3 unread");
    // Nothing unread, no badge.
    expect(one(openMore(stripes().right).button(), e => e.props.className === "rail-badge")).toBeNull();
  });

  it("wears the open look while a dialog behind it is up, and only that More", () => {
    const quiet = stripes();
    expect(openMore(quiet.right).button().props["data-up"]).toBeUndefined();
    const historyUp = stripes(rails({ dialogsUp: { history: true } }));
    expect(openMore(historyUp.right).button().props["data-up"]).toBe(true);
    expect(openMore(historyUp.left).button().props["data-up"]).toBeUndefined();
    const radioUp = stripes(rails({ dialogsUp: { radio: true } }));
    expect(openMore(radioUp.left).button().props["data-up"]).toBe(true);
    // Each view of a door that has two: Skill activity's, the calendar's.
    expect(openMore(stripes(rails({ dialogsUp: { toolActivity: "skills" } })).right).button().props["data-up"]).toBe(true);
    expect(openMore(stripes(rails({ dialogsUp: { capacity: "calendar" } })).left).button().props["data-up"]).toBe(true);
    // Drawn, never said: More's aria-expanded is its own menu's.
    expect(openMore(historyUp.right).button().props["aria-expanded"]).toBe(false);
  });

  it("draws the open look as a stripe door's: the --selected fill and the line on the canvas side", () => {
    const rules = sheetRules().filter(r => r.media === null);
    const body = (selector: string) => rules.filter(r => r.selectors.includes(selector)).map(r => r.body).join(";");
    expect(body(".rail-btn-stripe[data-up]")).toMatch(/background:\s*var\(--selected\)/);
    expect(body(".rail-btn-stripe[data-up]")).toMatch(/color:\s*var\(--text\)/);
    expect(body(".rail-btn-stripe[data-up]::before")).toMatch(/opacity:\s*1/);
  });

  it("opens its menu over the canvas: from the left stripe start-aligned, from the right one end-aligned", () => {
    const { left, right } = stripes();
    const l = openMore(left);
    l.press();
    expect(l.menu()!.props.align).toBe("start");
    expect(l.menu()!.props.id).toBe("rail-more-left-menu");
    expect(l.button().props["aria-controls"]).toBe("rail-more-left-menu");
    expect(l.menu()!.props.className).toBe("ap-pop");
    const r = openMore(right);
    r.press();
    expect(r.menu()!.props.align).toBe("end");
    expect(r.menu()!.props.start).toBe("first");
  });

  it("leaves Up and Down to the stripe's toolbar, so the arrows walk past it to Settings", () => {
    const { left } = stripes();
    const { button, menu } = openMore(left);
    let prevented = 0;
    for (const key of ["ArrowDown", "ArrowUp"]) {
      (button().props.onKeyDown as (e: unknown) => void)({ key, preventDefault: () => { prevented++; } });
    }
    expect(menu()).toBeNull();
    expect(prevented).toBe(0);
    // The dock's More, in a horizontal toolbar, still opens on them.
    const dock = mount(EdgeDock, { items: [], more: rails().rightMore.flat() }).tree;
    const d = openMore(dock);
    (d.button().props.onKeyDown as (e: unknown) => void)({ key: "ArrowUp", preventDefault: noop });
    expect(d.menu()!.props.start).toBe("last");
  });

  it("takes its place in the stripe's arrows, after the doors and before the foot", () => {
    const { left } = stripes();
    const more = moreOf(left)!;
    expect(more.props.index).toBe(2);
    expect(more.props.tabbable).toBe(false);
    const settings = all(left, e => typeof e.type === "function" && "item" in e.props).find(e => (e.props.item as { id: string }).id === "settings")!;
    expect(settings.props.index).toBe(3);
    const wordSwitch = one(left, e => e.props["data-rail-item"] === "stripe-words")!;
    expect(wordSwitch.props.tabIndex).toBe(-1);
  });

  it("hands focus back to More before the dialog opens, so the dialog gives it back there", () => {
    const opened: string[] = [];
    const { right } = stripes(rails({ setUsageHistoryOpen: () => { opened.push(`history after ${focused.join(",")}`); } }));
    const { press, row, menu } = openMore(right);
    press();
    (row("history").props.onClick as () => void)();
    expect(opened).toEqual(["history after rail-more-right"]);
    expect(menu()).toBeNull();
  });
});

describe("a menu row's key: seen at its end, said by aria-keyshortcuts", () => {
  it("ends Usage history's and Browser watch's rows in their keys, and the rest in none", () => {
    const { right } = stripes();
    const { press, row } = openMore(right);
    press();
    const keyOf = (id: string) => one(row(id), e => e.props.className === "rail-menu-key");
    expect(textOf(keyOf("history"))).toBe("H");
    expect(textOf(keyOf("browser-watch"))).toBe("B");
    expect(keyOf("tool-activity")).toBeNull();
    // Out of the row's name: hidden from assistive tech, which hears the key
    // from aria-keyshortcuts instead.
    expect(keyOf("history")!.props["aria-hidden"]).toBe(true);
    expect(row("history").props["aria-keyshortcuts"]).toBe("H");
    expect(row("tool-activity").props["aria-keyshortcuts"]).toBeUndefined();
  });

  it("drops the keys with the single-key shortcuts off", () => {
    singleKeys = false;
    const { right } = stripes();
    const { press, row } = openMore(right);
    press();
    expect(one(row("history"), e => e.props.className === "rail-menu-key")).toBeNull();
    expect(row("history").props["aria-keyshortcuts"]).toBeUndefined();
  });

  it("draws no key in the phone dock's menu, whose rows stay their words", () => {
    const dock = mount(EdgeDock, { items: [], more: rails().rightMore.flat() }).tree;
    const d = openMore(dock);
    d.press();
    expect(all(d.menu(), e => e.props.className === "rail-menu-key")).toEqual([]);
    expect(d.rows()[0]).toBe("Usage history");
  });

  it("keeps the key muted at the row's end, in the sheet", () => {
    const rule = sheetRules().find(r => r.media === null && r.selectors.includes(".rail-menu-key"));
    expect(rule?.body).toMatch(/margin-inline-start:\s*auto/);
  });
});

describe("every door keeps its key and its Quick open row", () => {
  it("answers H and B where it always did, with the setters the More's rows press", () => {
    const keys = sourceOf("use-deck-shortcuts.ts");
    expect(keys).toContain('if (e.key === "h" || e.key === "H") setUsageHistoryOpen(o => !o);');
    expect(keys).toContain('if (e.key === "b" || e.key === "B") setBrowserWatchOpen(o => !o);');
    // The keys read no stripe and no More: moving a door moves no key.
    expect(keys).not.toMatch(/leftStripe|rightStripe|leftMore|rightMore/);
    // And the row presses the same setter the key does.
    const pressed: string[] = [];
    const r = rails({ setUsageHistoryOpen: () => { pressed.push("history"); } });
    r.rightMore.flat().find(i => i.id === "history")!.onPress();
    expect(pressed).toEqual(["history"]);
  });

  it("lists every door behind a More in the lists Quick open reads, never the stripes", () => {
    const quick = sourceOf("quick-open-items.tsx");
    expect(quick).toContain("...src.rails.left, ...(src.rails.codexDoor ?? []), ...src.rails.capacity, ...src.rails.right.flat(),");
    expect(quick).not.toMatch(/leftStripe|rightStripe|leftMore|rightMore/);
    const r = rails();
    const reachable = new Set([...r.left, ...r.capacity, ...r.right.flat(), ...r.integrations, ...r.explore, ...r.utilities].map(i => i.id));
    for (const id of [...r.leftMore.flat(), ...r.rightMore.flat()].map(i => i.id)) expect(reachable, id).toContain(id);
  });

  it("is wired in App: each stripe takes its More, and the dialogs' state reaches it", () => {
    const app = sourceOf("App.tsx");
    expect(app).toContain("groups={rails.leftStripe} more={rails.leftMore} foot={rails.leftFoot}");
    expect(app).toContain("groups={rails.rightStripe} more={rails.rightMore}");
    expect(app).toMatch(/dialogsUp: \{\s*history: dialogs\.usageHistoryOpen, browserWatch: dialogs\.browserWatchOpen, radar: dialogs\.trafficRadarOpen,\s*radio: radioOpen, explore: exploreIntegrationsOpen, toolActivity: toolAuditView, capacity: capacityView,\s*\}/);
  });

  it("gives focus back to the More on a dialog's own side when its opener is gone", () => {
    expect(sourceOf("components/RadioPanel.tsx")).toContain(`'[data-rail-item="radio"], [data-more-holds~="radio"]'`);
    expect(sourceOf("components/ToolAuditModal.tsx")).toContain('`[data-rail-item="${viewDoor[door]}"], [data-more-holds~="${viewDoor[door]}"]`');
  });
});
