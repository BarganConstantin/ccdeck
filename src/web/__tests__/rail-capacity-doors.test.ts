// Account capacity and Reset calendar on the left stripe.
//
// Both were only behind the gauge in the accounts panel's header, and the
// calendar a tab further inside its dialog; users said they could not find
// them. The stripe now carries a door to each, between Accounts and Session
// list, and each opens its own view, titled for itself, without touching the
// left column. The gauge and the tabs are gone. On a phone the dock keeps its
// five slots and the two are the first rows under More.
//
// These pin the order, the press, the view each door opens on, and the order
// the rows come in when there is no panel to take it from.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mount, one } from "./fake-react";
import type { Account } from "../claude-accounts";

vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("react-dom", async (orig) => ({ ...(await orig<typeof import("react-dom")>()), createPortal: (node: unknown) => node }));
vi.mock("../use-single-key-shortcuts", () => ({ useSingleKeyShortcuts: () => true }));

const { railItems } = await import("../rail-items");
const { EdgeDock } = await import("../components/EdgeRails");
const { default: AccountsUsageReport } = await import("../components/AccountsUsageReport");
const { panelOrder } = await import("../components/AccountCapacityDialog");
const { laneKey } = await import("../lane-open");

const noop = () => {};
const ref = () => ({ current: null });
const toggles = { sessionList: ref(), usage: ref(), accounts: ref(), machine: ref() };

function rails({ claude = true, openCapacity = noop as (view: string) => void } = {}) {
  return railItems({
    providers: { kind: "reported", claude, codex: true },
    sessionListOpen: false, toggleSessionList: noop, accountsPanelOpen: false, toggleAccountsPanel: noop,
    usagePanelOpen: false, setUsagePanelOpen: noop, machinePanelOpen: false, setMachinePanelOpen: noop,
    setUsageHistoryOpen: noop, watchOn: false, watchUnseen: 0, setBrowserWatchOpen: noop,
    openSettings: noop, onFeedback: noop, toggles, openCapacity,
  } as unknown as Parameters<typeof railItems>[0]);
}

const ids = (items: { id: string }[]) => items.map(i => i.id);

describe("the left stripe's two doors into Account capacity", () => {
  it("stand between Accounts and Session list, in the owner's order", () => {
    expect(ids(rails().leftStripe)).toEqual(["accounts", "account-capacity", "reset-calendar", "session-list"]);
  });

  it("go with the accounts button on a machine without Claude Code", () => {
    const r = rails({ claude: false });
    expect(ids(r.leftStripe)).toEqual(["session-list"]);
    expect(r.capacity).toEqual([]);
  });

  it("open the dialog on the view each one names, as a dialog and not a panel", () => {
    const opened: string[] = [];
    const [capacity, calendar] = rails({ openCapacity: v => opened.push(v) }).capacity;
    capacity.onPress();
    calendar.onPress();
    expect(opened).toEqual(["accounts", "calendar"]);
    expect([capacity.kind, calendar.kind]).toEqual(["dialog", "dialog"]);
    expect([capacity.ariaLabel, calendar.ariaLabel]).toEqual(["Account capacity", "Reset calendar"]);
  });

  it("leave the phone's dock its five slots and lead its More", () => {
    const r = rails();
    const view = mount(EdgeDock, {
      items: [...r.left, ...r.right[0], r.utilities[0]],
      more: [...r.capacity, ...r.right.slice(1).flat(), ...r.integrations, r.utilities[1]],
    });
    const buttons = (view.tree as { props: { children: unknown[] } }).props.children;
    const dockIds = (buttons[0] as { props: { item: { id: string } } }[]).map(b => b.props.item.id);
    expect(dockIds).toEqual(["accounts", "session-list", "usage", "machine", "settings"]);
    const more = one(view.tree, e => typeof e.type === "function" && "items" in e.props && "index" in e.props)!;
    expect(ids(more.props.items as { id: string }[]).slice(0, 2)).toEqual(["account-capacity", "reset-calendar"]);
  });
});

describe("the dialog opens on the view it was asked for", () => {
  beforeEach(() => {
    vi.stubGlobal("document", {
      activeElement: null, body: {},
      addEventListener: noop, removeEventListener: noop,
    });
    vi.stubGlobal("window", { addEventListener: noop, removeEventListener: noop, requestAnimationFrame: () => 0, cancelAnimationFrame: noop, matchMedia: () => ({ matches: true }) });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const opened = (view: "accounts" | "calendar") => {
    const drawn = mount(AccountsUsageReport, { accounts: [], order: [], failed: null, nowSec: 0, onClose: noop, view });
    const dialog = one(drawn.tree, e => e.props.role === "dialog")!;
    const title = one(drawn.tree, e => e.props.id === "ap-report-title")!;
    // No tab strip: each door opens one view, and the dialog has no way to the other.
    const tabs = one(drawn.tree, e => typeof e.props.className === "string" && e.props.className.startsWith("ap-report-view"));
    return { view: dialog.props["data-view"], title: title.props.children, tabs };
  };

  it("the rows, titled Account capacity", () => {
    expect(opened("accounts")).toEqual({ view: "accounts", title: "Account capacity", tabs: null });
  });

  it("the calendar, titled Reset calendar", () => {
    expect(opened("calendar")).toEqual({ view: "calendar", title: "Reset calendar", tabs: null });
  });
});

describe("the rows come in the panel's order with no panel to take it from", () => {
  const acct = (num: number, active: boolean, sevenDay: number): Account => ({
    num, email: `a${num}@example.test`, alias: null, org: null, orgUuid: `org-${num}`, active, disabled: false,
    stale: false, error: null, fetchedAt: 0, nextAt: null, headroom: 100 - sevenDay,
    lanes: [{ id: "seven_day", label: "7d", pct: sevenDay, resetAt: null }],
  });
  const keys = (...rows: Account[]) => rows.map(laneKey);

  it("puts the live account first, then the others in the stored order", () => {
    const [a1, a2, a3] = [acct(1, false, 20), acct(2, true, 50), acct(3, false, 90)];
    expect(panelOrder([a1, a2, a3], "7d:full", 0)).toEqual(keys(a2, a3, a1));
    expect(panelOrder([a1, a2, a3], "slot", 0)).toEqual(keys(a2, a1, a3));
  });

  it("keeps the roster's own order while nobody is live", () => {
    const [a3, a1] = [acct(3, false, 90), acct(1, false, 20)];
    expect(panelOrder([a3, a1], "7d:empty", 0)).toEqual(keys(a3, a1));
  });
});
