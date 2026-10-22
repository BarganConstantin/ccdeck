// What a phone opens by itself when the deck loads.
//
// A first run opens Accounts, Usage and the machine panel, and each stays open
// across reloads until the reader closes it — the layout for a window with a
// canvas to sit beside. Under 641px nothing sits beside anything: the left
// column is a drawer over the canvas, Usage takes the top of the screen and the
// machine panel its foot. A 390px load opened all three, with the accounts
// drawer over Usage and no part of the board in sight.
//
// A phone's load opens one sheet at most: Usage when it is wanted, the machine
// panel when only it is, and never the drawer, which opens from the dock. What
// is stored is not touched — a held panel is not the reader closing it — so a
// wider window opens what it always did, and the reader's own open or close of
// a held panel is written as ever.
//
// Run, not read: both hooks on fake-react.ts's React, against a stubbed store
// and a matchMedia that answers the dock's breakpoint (edge-dock-phone.test.ts
// pins it to the sheet's).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);
// A panel shown is a feature the usage reports name; not what this is about.
vi.mock("../feature-use", () => ({ useFeatureUse: () => {} }));

const { useRightPanels } = await import("../use-right-panels");
const { useLeftColumn } = await import("../use-left-column");

const KEYS = {
  sessionList: "agent-dag.sessionListOpen",
  accounts: "agent-dag.accountsPanelOpen",
  usage: "agent-dag.usagePanelOpen",
  machine: "agent-dag.systemPanelOpen",
} as const;
type Panel = keyof typeof KEYS;

let stored: Record<string, string> = {};
let writes: Array<[string, string]> = [];

/** A window at `width` px, with `saved` in its store. No matchMedia at all
 *  when `width` is null: a browser that cannot be asked is not a phone. */
function windowAt(width: number | null, saved: Partial<Record<Panel, "0" | "1">> = {}) {
  stored = {};
  writes = [];
  for (const [panel, v] of Object.entries(saved)) stored[KEYS[panel as Panel]] = v as string;
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => stored[k] ?? null,
      setItem: (k: string, v: string) => { stored[k] = v; writes.push([k, v]); },
    },
    ...(width === null ? {} : {
      matchMedia: (q: string) => ({ matches: q === "(max-width: 640px)" && width <= 640 }),
    }),
  });
}

/** The deck's panels as App.tsx restores them: the right ones, then the left
 *  column, read after every render. */
function load() {
  let right!: ReturnType<typeof useRightPanels>;
  let left!: ReturnType<typeof useLeftColumn>;
  mount(() => { right = useRightPanels(); left = useLeftColumn(); return null; }, {});
  return {
    get open() {
      return { sessionList: left.sessionListOpen, accounts: left.accountsPanelOpen,
               usage: right.usagePanelOpen, machine: right.machinePanelOpen };
    },
    get right() { return right; },
    get left() { return left; },
  };
}

/** What is stored for a panel now. */
const kept = (panel: Panel) => stored[KEYS[panel]] ?? null;

beforeEach(() => { stored = {}; writes = []; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("a phone's load opens one sheet at most", () => {
  it("opens Usage alone on a first run at 390px", () => {
    windowAt(390);
    expect(load().open).toEqual({ sessionList: false, accounts: false, usage: true, machine: false });
  });

  it("opens Usage alone when every panel was left open", () => {
    windowAt(390, { sessionList: "1", accounts: "1", usage: "1", machine: "1" });
    expect(load().open).toEqual({ sessionList: false, accounts: false, usage: true, machine: false });
  });

  it("opens the machine panel when it is the one sheet wanted", () => {
    windowAt(390, { accounts: "1", usage: "0", machine: "1" });
    expect(load().open).toEqual({ sessionList: false, accounts: false, usage: false, machine: true });
  });

  it("never opens the drawer by itself, whichever panel of the column was left open", () => {
    windowAt(390, { sessionList: "1", usage: "0", machine: "0" });
    expect(load().open.sessionList).toBe(false);
    windowAt(390, { accounts: "1", usage: "0", machine: "0" });
    expect(load().open.accounts).toBe(false);
  });

  it("holds at the dock's own breakpoint, and not a pixel wider", () => {
    windowAt(640);
    expect(load().open).toEqual({ sessionList: false, accounts: false, usage: true, machine: false });
    windowAt(641);
    expect(load().open).toEqual({ sessionList: false, accounts: true, usage: true, machine: true });
  });
});

describe("a held panel is not the reader closing it", () => {
  it("writes nothing for a held panel, so a first run is still a first run elsewhere", () => {
    windowAt(390);
    load();
    expect(kept("accounts")).toBeNull();
    expect(kept("machine")).toBeNull();
    expect(writes.filter(([k]) => k === KEYS.accounts || k === KEYS.machine)).toEqual([]);
  });

  it("keeps an open panel on record as open", () => {
    windowAt(390, { sessionList: "1", accounts: "1", usage: "1", machine: "1" });
    load();
    expect(kept("sessionList")).toBe("1");
    expect(kept("accounts")).toBe("1");
    expect(kept("machine")).toBe("1");
  });

  it("writes the reader's own open and close of a held panel, as ever", () => {
    windowAt(390, { accounts: "1", usage: "1", machine: "1" });
    const deck = load();
    deck.left.toggleAccountsPanel();
    expect(deck.open.accounts).toBe(true);
    expect(kept("accounts")).toBe("1");
    deck.left.toggleAccountsPanel();
    expect(deck.open.accounts).toBe(false);
    expect(kept("accounts")).toBe("0");

    deck.right.setMachinePanelOpen(true);
    expect(deck.open.machine).toBe(true);
    deck.right.setMachinePanelOpen(false);
    expect(kept("machine")).toBe("0");
  });

  it("writes the reader's open of a held session list", () => {
    windowAt(390, { sessionList: "1" });
    const deck = load();
    deck.left.toggleSessionList();
    expect(deck.open.sessionList).toBe(true);
    expect(kept("sessionList")).toBe("1");
    deck.left.toggleSessionList();
    expect(kept("sessionList")).toBe("0");
  });
});

describe("a wider window loads as it always did", () => {
  it("opens Accounts, Usage and the machine panel on a first run at 1440px, and writes them down", () => {
    windowAt(1440);
    expect(load().open).toEqual({ sessionList: false, accounts: true, usage: true, machine: true });
    expect(kept("accounts")).toBe("1");
    expect(kept("usage")).toBe("1");
    expect(kept("machine")).toBe("1");
  });

  it("keeps the list's eviction of the accounts panel at 1440px", () => {
    windowAt(1440, { sessionList: "1", accounts: "1" });
    const deck = load();
    expect(deck.open).toMatchObject({ sessionList: true, accounts: false });
    deck.left.closeSessionList();
    expect(deck.open.accounts).toBe(true);
  });

  it("is a wide window where the browser cannot be asked", () => {
    windowAt(null);
    expect(load().open).toEqual({ sessionList: false, accounts: true, usage: true, machine: true });
  });
});
