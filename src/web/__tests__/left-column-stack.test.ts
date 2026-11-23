// Sessions and Accounts, one under the other in the left column (the owner,
// 2026-11-23): "if I press Accounts it should open down here and Sessions
// should not close; both should be here, like on the right side."
//
// The left column used to be one slot the two took turns at: either door
// evicted the other panel (left-column-824.test.ts has the history). Now each
// door toggles its own panel only, and with both open the list is on top and
// Accounts under it, a 1px --line between them, the way Usage stands over This
// machine in the Board's right column (panel-place.css). The column keeps one
// width, the one the two already shared, so opening Accounts under an open list
// does not move the board's edge. A phone is unchanged: Accounts is a sheet
// over the list there, one sheet at a time (use-phone-sheets-run.test.ts).
//
// Run where it can be run — the hook on fake-react.ts's React, against a
// stubbed store — and read where it cannot: the sheet that stacks the two and
// the order App draws them in, since this suite lays nothing out.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "./fake-react";
import { sourceOf } from "./client-source";
import { sheetParts, sheetText } from "./sheet-source";

vi.mock("react", async () => (await import("./fake-react")).react);

const { useLeftColumn, leftColumnWidth, leftColumnPanel } = await import("../use-left-column");

const LIST = "agent-dag.sessionListOpen";
const ACCOUNTS = "agent-dag.accountsPanelOpen";

let stored: Record<string, string> = {};
let writes: Array<[string, string]> = [];

/** A window `width` px wide with `saved` in its store; 640 and under is a phone. */
function windowAt(width: number, saved: Record<string, string> = {}) {
  stored = { ...saved };
  writes = [];
  vi.stubGlobal("window", {
    innerWidth: width,
    matchMedia: (q: string) => ({ matches: q === "(max-width: 640px)" && width <= 640 }),
    localStorage: {
      getItem: (k: string) => stored[k] ?? null,
      setItem: (k: string, v: string) => { stored[k] = v; writes.push([k, v]); },
    },
    dispatchEvent: () => true,
  });
}

/** The left column as App holds it, read after every render. */
function load() {
  let left!: ReturnType<typeof useLeftColumn>;
  mount(() => { left = useLeftColumn(); return null; }, {});
  return {
    get col() { return left; },
    get open() { return { list: left.sessionListOpen, accounts: left.accountsPanelOpen }; },
  };
}

beforeEach(() => { stored = {}; writes = []; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("both open at once", () => {
  it("opens Accounts under an open list, and the list stays", () => {
    windowAt(1440, { [LIST]: "1", [ACCOUNTS]: "0" });
    const deck = load();
    expect(deck.open).toEqual({ list: true, accounts: false });
    deck.col.toggleAccountsPanel();
    expect(deck.open).toEqual({ list: true, accounts: true });
    expect(deck.col.panel, "the list is on top").toBe("session-list");
  });

  it("opens the list over an open Accounts, and Accounts stays", () => {
    windowAt(1440, { [LIST]: "0", [ACCOUNTS]: "1" });
    const deck = load();
    expect(deck.col.panel).toBe("accounts");
    deck.col.toggleSessionList();
    expect(deck.open).toEqual({ list: true, accounts: true });
    expect(deck.col.panel).toBe("session-list");
  });

  it("loads both open when both were left open", () => {
    windowAt(1440, { [LIST]: "1", [ACCOUNTS]: "1" });
    expect(load().open).toEqual({ list: true, accounts: true });
  });
});

describe("each door toggles its own panel only", () => {
  it("the Sessions door (and L) opens and closes the list, and leaves Accounts as it is", () => {
    for (const accounts of ["0", "1"]) {
      windowAt(1440, { [LIST]: "0", [ACCOUNTS]: accounts });
      const deck = load();
      deck.col.toggleSessionList();
      expect(deck.open, `Accounts ${accounts}`).toEqual({ list: true, accounts: accounts === "1" });
      deck.col.toggleSessionList();
      expect(deck.open, `Accounts ${accounts}`).toEqual({ list: false, accounts: accounts === "1" });
    }
  });

  it("the Accounts door (and A) opens and closes Accounts, and leaves the list as it is", () => {
    for (const list of ["0", "1"]) {
      windowAt(1440, { [LIST]: list, [ACCOUNTS]: "0" });
      const deck = load();
      deck.col.toggleAccountsPanel();
      expect(deck.open, `list ${list}`).toEqual({ list: list === "1", accounts: true });
      deck.col.toggleAccountsPanel();
      expect(deck.open, `list ${list}`).toEqual({ list: list === "1", accounts: false });
    }
  });

  it("Settings' door to Accounts opens it, or leaves it open, under the list", () => {
    windowAt(1440, { [LIST]: "1", [ACCOUNTS]: "0" });
    const deck = load();
    deck.col.openAccountsPanel();
    expect(deck.open).toEqual({ list: true, accounts: true });
    deck.col.openAccountsPanel();
    expect(deck.open, "a second press never shuts it").toEqual({ list: true, accounts: true });
  });

  it("each panel's own close closes that panel only", () => {
    windowAt(1440, { [LIST]: "1", [ACCOUNTS]: "1" });
    const deck = load();
    deck.col.closeAccountsPanel();
    expect(deck.open).toEqual({ list: true, accounts: false });
    deck.col.openAccountsPanel();
    deck.col.closeSessionList();
    expect(deck.open).toEqual({ list: false, accounts: true });
    expect(deck.col.panel, "Accounts alone has the column").toBe("accounts");
  });
});

describe("each panel's open flag is remembered on its own", () => {
  it("stores both open, and a reload opens both", () => {
    windowAt(1440, { [LIST]: "0", [ACCOUNTS]: "0" });
    const deck = load();
    deck.col.toggleSessionList();
    deck.col.toggleAccountsPanel();
    expect([stored[LIST], stored[ACCOUNTS]]).toEqual(["1", "1"]);
    // The reload: a new page reads what was stored.
    windowAt(1440, { ...stored });
    expect(load().open).toEqual({ list: true, accounts: true });
  });

  it("stores closing one of the two as that one alone", () => {
    windowAt(1440, { [LIST]: "1", [ACCOUNTS]: "1" });
    const deck = load();
    deck.col.toggleAccountsPanel();
    expect([stored[LIST], stored[ACCOUNTS]]).toEqual(["1", "0"]);
    deck.col.toggleAccountsPanel();
    deck.col.toggleSessionList();
    expect([stored[LIST], stored[ACCOUNTS]]).toEqual(["0", "1"]);
    windowAt(1440, { ...stored });
    expect(load().open).toEqual({ list: false, accounts: true });
  });

  it("opening the second panel writes that panel's flag, and nothing of the first", () => {
    windowAt(1440, { [LIST]: "1", [ACCOUNTS]: "0" });
    const deck = load();
    writes = [];
    deck.col.toggleAccountsPanel();
    expect(writes).toEqual([[ACCOUNTS, "1"]]);
  });
});

describe("a store an earlier build wrote loads into a sensible column", () => {
  // The keys and their values are the ones the one-slot column wrote, so
  // nothing has to be moved or renamed. What changes is how one pair reads.
  it("a list opened over Accounts (the eviction kept Accounts stored open) loads as the two, stacked", () => {
    windowAt(1440, { [LIST]: "1", [ACCOUNTS]: "1" });
    const deck = load();
    expect(deck.open).toEqual({ list: true, accounts: true });
    expect([stored[LIST], stored[ACCOUNTS]], "and is not rewritten as anything else").toEqual(["1", "1"]);
    expect(writes.filter(([, v]) => v !== "1")).toEqual([]);
  });

  it("every other stored pair loads as it stands", () => {
    for (const [list, accounts] of [["1", "0"], ["0", "1"], ["0", "0"]] as const) {
      windowAt(1440, { [LIST]: list, [ACCOUNTS]: accounts });
      expect(load().open, `${list}${accounts}`).toEqual({ list: list === "1", accounts: accounts === "1" });
    }
  });

  it("a first run opens neither", () => {
    windowAt(1440);
    expect(load().open).toEqual({ list: false, accounts: false });
  });

  it("keeps no eviction memory, and reads no key but the two flags", () => {
    const hook = sourceOf("use-left-column.ts");
    expect(hook).not.toMatch(/evict|waiting/i);
    expect(hook.match(/agent-dag\.[\w.]+/g)?.sort()).toEqual([ACCOUNTS, LIST].sort());
  });
});

describe("a phone keeps one at a time", () => {
  it("loads Sessions alone, whatever was stored, and Accounts waits for its door", () => {
    windowAt(390, { [LIST]: "1", [ACCOUNTS]: "1" });
    const deck = load();
    expect(deck.open).toEqual({ list: true, accounts: false });
    expect(stored[ACCOUNTS], "the wider window's choice is kept").toBe("1");
  });

  it("opens Accounts as a sheet over the list, which stays under it", () => {
    windowAt(390, { [LIST]: "1" });
    const deck = load();
    deck.col.toggleAccountsPanel();
    expect(deck.open).toEqual({ list: true, accounts: true });
  });

  it("draws the column with the list alone, and Accounts outside it as a sheet", () => {
    const app = sourceOf("App.tsx");
    // The column's width on a phone is the list's or nothing, never Accounts'.
    expect(app).toContain('phone ? (sessionListOpen ? "session-list" : null)');
    expect(app).toContain("{phone && accountsNodes}");
    expect(app).toContain("{!phone && accountsNodes}");
    // And Accounts is still one of the sheets the phone keeps one of at a time.
    expect(app).toMatch(/usePhoneSheets\(\{\s*phone,\s*open: \{ accounts: accountsDrawn && accountsPanelOpen,/);
    expect(app).toContain("hold: { accounts: holdAccounts,");
  });
});

describe("the column keeps the one width with both open", () => {
  it("is the reader's width whether one panel is open or both", () => {
    windowAt(1440, { [LIST]: "1", [ACCOUNTS]: "0" });
    const deck = load();
    const alone = leftColumnWidth(deck.col.panel, 264, 400);
    deck.col.toggleAccountsPanel();
    const both = leftColumnWidth(deck.col.panel, 264, 400);
    expect(alone).toBe(400);
    expect(both, "opening Accounts under the list does not move the board's edge").toBe(alone);
    deck.col.closeSessionList();
    expect(leftColumnWidth(deck.col.panel, 264, 400), "nor does closing the list over it").toBe(alone);
  });

  it("is the same width at Compact's narrower rail, when nothing was dragged", () => {
    expect(leftColumnWidth(leftColumnPanel(true, true), 264)).toBe(264);
    expect(leftColumnWidth(leftColumnPanel(false, true), 264)).toBe(264);
    expect(leftColumnWidth(leftColumnPanel(true, false), 264)).toBe(264);
  });
});

// ── the stack, as the sheet draws it ────────────────────────────────────────

const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");

/** Top-level rules only, outside every @media: the desktop column. */
function topLevel(src: string): Map<string, string> {
  const out = new Map<string, string>();
  let depth = 0, start = 0, prelude = "";
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "{") {
      if (depth === 0) { prelude = src.slice(start, i).trim(); start = i + 1; }
      depth++;
    } else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        if (!prelude.startsWith("@")) {
          for (const sel of prelude.split(",").map(s => s.replace(/\s+/g, " ").trim())) {
            out.set(sel, `${out.get(sel) ?? ""};${src.slice(start, i)}`);
          }
        }
        start = i + 1;
      }
    }
  }
  return out;
}
const rules = topLevel(css);
const decl = (sel: string, prop: string) =>
  [...(rules.get(sel) ?? "").matchAll(new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`, "g"))].map(m => m[1].trim()).pop() ?? null;

describe("Accounts stands under Sessions, as This machine stands under Usage", () => {
  it("makes the column a stack, top to bottom", () => {
    expect(decl(".left-column", "display")).toBe("flex");
    expect(decl(".left-column", "flex-direction")).toBe("column");
    // Alone, a panel has the whole column, as it always did.
    expect(decl(".left-column > .session-list", "flex")).toBe("1 1 0");
    expect(decl(".left-column > .accounts-panel", "flex")).toBe("1 1 0");
    expect(decl(".left-column > .session-list", "min-height")).toBe("0");
  });

  it("puts Accounts under the list at its content's height, a 1px --line between them, no gap", () => {
    expect(decl(".left-column > .session-list ~ .accounts-panel", "flex")).toBe("0 1 auto");
    expect(decl(".left-column > .session-list ~ .accounts-panel", "border-top")).toBe("1px solid var(--line)");
    expect(decl(".left-column > .session-list ~ .accounts-panel", "margin-top")).toBeNull();
    // The right column's own rule, which this one mirrors with the roles set
    // top and bottom: the part that takes the rest keeps at least half.
    expect(css).toMatch(/\.app\[data-right-col\] > \.right-col > \.detail \{ flex: 1 1 0; min-height: 50%;/);
  });

  it("keeps at least half the column for the list, so Accounts scrolls inside itself past the rest", () => {
    expect(decl(".left-column > .session-list:has(~ .accounts-panel)", "min-height")).toBe("50%");
    // Accounts' own roster is what scrolls; its header and foot stand.
    expect(decl(".ap-scroll", "overflow")).toBe("hidden auto");
    expect(decl(".ap-scroll", "min-height")).toBe("0");
    expect(decl(".accounts-panel", "min-height")).toBe("0");
  });

  it("adds no splitter and no motion of its own", () => {
    const sheet = sourceOf("components/LeftColumn.tsx");
    // The one edge is the column's width's (RailEdge), as before.
    expect(sheet).toContain("{children}");
    expect(sheet).toContain("{edge}");
    const part = (sheetParts().find(([path]) => path === "styles/left-column.css")?.[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
    const own = part.slice(0, part.indexOf("@media (max-width: 640px)"));
    expect(own.length).toBeGreaterThan(0);
    expect(part).not.toMatch(/@keyframes|animation\s*:/);
    // The panel arriving beside an open one fades in where the stack puts it,
    // on the motion the column already had; reduced motion keeps its 140ms
    // opacity alone.
    expect(own).toMatch(/@starting-style \{\s*\.left-column > :only-child \{ transform: translateX\(-100%\); \}\s*\.left-column > :not\(:only-child\) \{ opacity: 0; \}/);
    expect(own).toMatch(/\.left-column > \.accounts-panel \{\s*transition:\s*transform var\(--dur-move\) var\(--ease-stage\),\s*opacity var\(--accounts-fade-in\) var\(--ease-stage\) var\(--delay-step\);/);
  });

  it("draws Sessions before Accounts in the column, so the sheet's order is the screen's and Tab's", () => {
    const app = sourceOf("App.tsx");
    const open = app.indexOf("<LeftColumn width={leftColumnTarget}");
    const close = app.indexOf("</LeftColumn>", open);
    const inColumn = app.slice(open, close);
    expect(open).toBeGreaterThan(0);
    expect(inColumn.indexOf("<SessionList")).toBeGreaterThan(0);
    expect(inColumn.indexOf("{!phone && accountsNodes}")).toBeGreaterThan(inColumn.indexOf("<SessionList"));
  });
});
