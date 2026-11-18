// One side column at a time between 641 and 839px (owner, drawn in Figma). At
// 720px with the Sessions rail and the Inspector open the board had 56px; now
// the side opened last is drawn and the other folds to its stripe, and closing
// the one drawn brings the other back. A fold is display only: the stored
// flags stay, so a window widened to 840 shows both as the reader left them.
// The phone (640 and under), 840 and up, and Workspace are as they were.
//
// The rule is three pure functions, run as tables; the hook runs on
// fake-react.ts's React beside the panels' own hooks, against a stubbed store
// and a matchMedia that answers by the window's width; App's wiring is read
// where it lives.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mount } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);
// A panel shown is a feature the usage reports name; not what this is about.
vi.mock("../feature-use", () => ({ useFeatureUse: () => {} }));

const { ONE_SIDE_QUERY, foldAwarePress, foldAwareSet, lastOpenedSide, sideColumnsShown, useOneSideColumn } = await import("../one-side-column");
const { PHONE_QUERY } = await import("../phone-load");
const { useLeftColumn, leftColumnWidth } = await import("../use-left-column");
const { useRightPanels } = await import("../use-right-panels");
type Side = import("../one-side-column").Side;

const code = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the rule", () => {
  const shown = (narrow: boolean, leftOpen: boolean, rightOpen: boolean, lastOpened: Side) =>
    sideColumnsShown({ narrow, leftOpen, rightOpen, lastOpened });

  it("840 and up: both columns stand as they are open, whichever opened last", () => {
    expect(shown(false, true, true, "left")).toEqual({ left: true, right: true });
    expect(shown(false, true, true, "right")).toEqual({ left: true, right: true });
    expect(shown(false, true, false, "right")).toEqual({ left: true, right: false });
    expect(shown(false, false, true, "left")).toEqual({ left: false, right: true });
    expect(shown(false, false, false, "left")).toEqual({ left: false, right: false });
  });

  it("in the band, one open column is drawn whichever side it is", () => {
    expect(shown(true, true, false, "right")).toEqual({ left: true, right: false });
    expect(shown(true, false, true, "left")).toEqual({ left: false, right: true });
    expect(shown(true, false, false, "right")).toEqual({ left: false, right: false });
  });

  it("in the band, with both open, only the one opened last", () => {
    expect(shown(true, true, true, "left")).toEqual({ left: true, right: false });
    expect(shown(true, true, true, "right")).toEqual({ left: false, right: true });
  });

  it("the side opened last: an open, not a close, and the right when both open at once", () => {
    const was = (left: boolean, right: boolean, last: Side) => ({ left, right, last });
    expect(lastOpenedSide(was(true, false, "left"), { left: true, right: true })).toBe("right");
    expect(lastOpenedSide(was(false, true, "right"), { left: true, right: true })).toBe("left");
    // A load with both open, or anything that opens both in one go.
    expect(lastOpenedSide(was(false, false, "left"), { left: true, right: true })).toBe("right");
    // Nothing opened: a close, or nothing moved.
    expect(lastOpenedSide(was(true, true, "left"), { left: true, right: false })).toBe("left");
    expect(lastOpenedSide(was(true, true, "right"), { left: false, right: true })).toBe("right");
    expect(lastOpenedSide(was(true, true, "left"), { left: true, right: true })).toBe("left");
  });

  it("closing the column drawn gives the band to the other, which never closed", () => {
    // The right opened over the left, then closed.
    const last = lastOpenedSide({ left: true, right: false, last: "left" }, { left: true, right: true });
    expect(shown(true, true, true, last)).toEqual({ left: false, right: true });
    const after = lastOpenedSide({ left: true, right: true, last }, { left: true, right: false });
    expect(shown(true, true, false, after)).toEqual({ left: true, right: false });
    // And the other way round.
    const l = lastOpenedSide({ left: false, right: true, last: "right" }, { left: true, right: true });
    expect(shown(true, true, true, l)).toEqual({ left: true, right: false });
    expect(shown(true, false, true, lastOpenedSide({ left: true, right: true, last: l }, { left: false, right: true })))
      .toEqual({ left: false, right: true });
  });

  it("the band starts the pixel after a phone's and ends under 840", () => {
    expect(ONE_SIDE_QUERY).toBe("(min-width: 641px) and (max-width: 839px)");
    expect(PHONE_QUERY).toBe("(max-width: 640px)");
    for (const [w, band] of [[640, false], [641, true], [720, true], [839, true], [840, false], [1280, false]] as const) {
      expect(matchesAt(ONE_SIDE_QUERY, w), `${w}px`).toBe(band);
    }
  });
});

describe("a press on a folded side", () => {
  it("a setter goes through untouched while its side is drawn", () => {
    const set = vi.fn();
    const raise = vi.fn();
    const toggle = (o: boolean) => !o;
    foldAwareSet(set, () => false, raise)(toggle);
    expect(set).toHaveBeenCalledWith(toggle);
    expect(raise).not.toHaveBeenCalled();
  });

  it("folded, a toggle opens and brings the side back; an open does too; a close closes", () => {
    const set = vi.fn();
    const raise = vi.fn();
    const folded = foldAwareSet(set, () => true, raise);
    folded(o => !o);
    expect(set).toHaveBeenLastCalledWith(true);
    expect(raise).toHaveBeenCalledTimes(1);
    folded(true);
    expect(set).toHaveBeenLastCalledWith(true);
    expect(raise).toHaveBeenCalledTimes(2);
    folded(false);
    expect(set).toHaveBeenLastCalledWith(false);
    expect(raise).toHaveBeenCalledTimes(2);
  });

  it("a left door: drawn, its own press; folded on its panel, back alone; folded on the other, back and switched", () => {
    const press = vi.fn();
    const raise = vi.fn();
    foldAwarePress(press, { folded: () => false, holds: () => true, raise })();
    expect([press.mock.calls.length, raise.mock.calls.length]).toEqual([1, 0]);
    foldAwarePress(press, { folded: () => true, holds: () => true, raise })();
    expect([press.mock.calls.length, raise.mock.calls.length]).toEqual([1, 1]);
    foldAwarePress(press, { folded: () => true, holds: () => false, raise })();
    expect([press.mock.calls.length, raise.mock.calls.length]).toEqual([2, 2]);
  });
});

// ── the hook, run ────────────────────────────────────────────────────────────

/** Whether a width query holds at `width`: the min-width and max-width parts. */
function matchesAt(query: string, width: number): boolean {
  const min = /min-width:\s*(\d+)px/.exec(query);
  const max = /max-width:\s*(\d+)px/.exec(query);
  if (!min && !max) return false;
  return (!min || width >= Number(min[1])) && (!max || width <= Number(max[1]));
}

const KEYS = { sessionList: "agent-dag.sessionListOpen", usage: "agent-dag.usagePanelOpen", detail: "agent-dag.detailOpen" } as const;
let stored: Record<string, string> = {};
let width = 1280;
let lists: Array<{ query: string; was: boolean; listeners: Set<() => void> }> = [];

/** A window `at` px wide with `saved` in its store. */
function windowAt(at: number, saved: Record<string, string> = {}) {
  stored = { ...saved };
  width = at;
  lists = [];
  vi.stubGlobal("window", {
    innerWidth: at,
    localStorage: {
      getItem: (k: string) => stored[k] ?? null,
      setItem: (k: string, v: string) => { stored[k] = v; },
    },
    dispatchEvent: () => true,
    matchMedia: (query: string) => {
      const list = { query, was: matchesAt(query, width), listeners: new Set<() => void>() };
      lists.push(list);
      return {
        get matches() { return matchesAt(query, width); },
        addEventListener: (_: string, fn: () => void) => list.listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => list.listeners.delete(fn),
      };
    },
  });
}

/** What is stored for the list and Usage now. */
const kept = () => ({ list: stored[KEYS.sessionList], usage: stored[KEYS.usage] });

/** The window resized: every query whose answer moved says so. */
function resize(to: number) {
  width = to;
  for (const list of lists) {
    const now = matchesAt(list.query, to);
    if (now === list.was) continue;
    list.was = now;
    for (const fn of [...list.listeners]) fn();
  }
}

/** The deck's two sides as App wires them: the list on the left, Usage and the
 *  detail panel (with a session selected) on the right. */
function deck(view: { board: boolean } = { board: true }) {
  let out!: {
    fold: { left: boolean; right: boolean };
    left: ReturnType<typeof useLeftColumn>;
    right: ReturnType<typeof useRightPanels>;
    pressList: () => void;
    setUsage: (v: boolean | ((o: boolean) => boolean)) => void;
    setDetail: (v: boolean | ((o: boolean) => boolean)) => void;
  };
  mount(() => {
    const left = useLeftColumn();
    const right = useRightPanels(leftColumnWidth(left.panel));
    const sides = useOneSideColumn({ left: left.panel !== null, right: right.usagePanelOpen, board: view.board });
    const folded = (side: Side) => () => sides.foldRef.current[side];
    out = {
      fold: sides.fold, left, right,
      pressList: foldAwarePress(left.toggleSessionList, { folded: folded("left"), holds: () => left.panel === "session-list", raise: () => sides.raise("left") }),
      setUsage: foldAwareSet(right.setUsagePanelOpen, folded("right"), () => sides.raise("right")),
      setDetail: foldAwareSet(right.setDetailOpen, folded("right"), () => sides.raise("right")),
    };
    sides.settle({ left: left.panel !== null, right: right.usagePanelOpen || right.detailOpen, board: view.board });
    return null;
  }, {});
  return {
    get fold() { return out.fold; },
    /** What is on screen: open, and not folded. */
    get drawn() {
      return {
        list: out.left.sessionListOpen && !out.fold.left,
        usage: out.right.usagePanelOpen && !out.fold.right,
        detail: out.right.detailOpen && !out.fold.right,
      };
    },
    get d() { return out; },
  };
}

beforeEach(() => { stored = {}; lists = []; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the hook, at 720px", () => {
  it("a load with both sides open draws the right and folds the left, storing nothing", () => {
    windowAt(720, { [KEYS.sessionList]: "1", [KEYS.usage]: "1" });
    const view = deck();
    expect(view.fold).toEqual({ left: true, right: false });
    expect(view.drawn).toEqual({ list: false, usage: true, detail: false });
    expect(kept()).toEqual({ list: "1", usage: "1" });
  });

  it("opening the left (L, its door) folds the right; closing the left brings the right back", () => {
    windowAt(720, { [KEYS.sessionList]: "1", [KEYS.usage]: "1" });
    const view = deck();
    // The Sessions door reads closed while folded, and its press opens it.
    view.d.pressList();
    expect(view.drawn).toEqual({ list: true, usage: false, detail: false });
    expect(stored[KEYS.sessionList]).toBe("1");
    expect(stored[KEYS.usage]).toBe("1");
    // Its press now closes the list, for good, and the right comes back.
    view.d.pressList();
    expect(view.drawn).toEqual({ list: false, usage: true, detail: false });
    expect(stored[KEYS.sessionList]).toBe("0");
    expect(stored[KEYS.usage]).toBe("1");
  });

  it("opening the right while the left is drawn folds the left; closing the right brings it back", () => {
    windowAt(720, { [KEYS.sessionList]: "1" });
    const view = deck();
    expect(view.drawn).toEqual({ list: true, usage: false, detail: false });
    view.d.setUsage(o => !o);
    expect(view.drawn).toEqual({ list: false, usage: true, detail: false });
    expect(stored[KEYS.sessionList]).toBe("1");
    view.d.setUsage(o => !o);
    expect(view.drawn).toEqual({ list: true, usage: false, detail: false });
    expect(kept()).toEqual({ list: "1", usage: "0" });
  });

  it("a folded right reads closed: its key or door opens it over the left, and a selection does", () => {
    windowAt(720, { [KEYS.sessionList]: "1", [KEYS.usage]: "1" });
    const view = deck();
    view.d.pressList();
    expect(view.fold.right).toBe(true);
    // U, read against the screen: Usage is closed there, so U opens it.
    view.d.setUsage(o => !o);
    expect(view.drawn).toEqual({ list: false, usage: true, detail: false });
    expect(stored[KEYS.usage]).toBe("1");
    view.d.pressList();
    // A session picked from the list opens the detail panel over it.
    view.d.setDetail(true);
    expect(view.drawn).toEqual({ list: false, usage: true, detail: true });
  });

  it("widening past 839 shows both as the reader left them, and narrowing folds again", () => {
    windowAt(720, { [KEYS.sessionList]: "1", [KEYS.usage]: "1" });
    const view = deck();
    resize(1024);
    expect(view.fold).toEqual({ left: false, right: false });
    expect(view.drawn).toEqual({ list: true, usage: true, detail: false });
    resize(840);
    expect(view.drawn).toEqual({ list: true, usage: true, detail: false });
    resize(839);
    expect(view.drawn).toEqual({ list: false, usage: true, detail: false });
    expect(kept()).toEqual({ list: "1", usage: "1" });
  });

  it("the most recent open wins across a resize: the left opened while wide is the one drawn narrow", () => {
    windowAt(1280, { [KEYS.usage]: "1" });
    const view = deck();
    view.d.pressList();
    expect(view.drawn).toEqual({ list: true, usage: true, detail: false });
    resize(720);
    expect(view.drawn).toEqual({ list: true, usage: false, detail: false });
  });
});

describe("outside the band", () => {
  it("840 and up opens the right beside the left, as it always did", () => {
    windowAt(1024, { [KEYS.sessionList]: "1" });
    const view = deck();
    view.d.setUsage(true);
    expect(view.fold).toEqual({ left: false, right: false });
    expect(view.drawn).toEqual({ list: true, usage: true, detail: false });
  });

  it("640 and under is the phone's: nothing folds", () => {
    windowAt(640, { [KEYS.usage]: "1" });
    const view = deck();
    view.d.setUsage(true);
    view.d.setDetail(true);
    expect(view.fold).toEqual({ left: false, right: false });
  });

  it("Workspace keeps its own sheets at these widths: nothing folds", () => {
    windowAt(720, { [KEYS.sessionList]: "1", [KEYS.usage]: "1" });
    const view = deck({ board: false });
    expect(view.fold).toEqual({ left: false, right: false });
    view.d.pressList();
    view.d.pressList();
    expect(view.fold).toEqual({ left: false, right: false });
  });
});

describe("App's wiring", () => {
  const app = code("App.tsx");

  it("the left column's panels, width and doors follow the fold", () => {
    expect(app).toContain("const listOnScreen = sessionListOpen && !sideFold.left;");
    expect(app).toContain("const accountsOnScreen = accountsPanelOpen && !sideFold.left;");
    expect(app).toContain("const leftColumnTarget = sideFold.left ? 0 : leftColumnWanted;");
    expect(app).toMatch(/sessionListOpen: listOnScreen, toggleSessionList: pressSessionList,\s*accountsPanelOpen: accountsOnScreen, toggleAccountsPanel: pressAccounts,/);
    expect(app).toContain("toggleSessionList: pressSessionsKey, toggleAccountsPanel: pressAccounts,");
  });

  it("the right column's panels and doors follow the fold; the stage and the panels' own fold read the reader's flags", () => {
    expect(app).toContain("const detailShown = detailWanted && !sideFold.right;");
    expect(app).toContain("usePanelPresence(usagePanelOpen && !sideFold.right, railExitMs)");
    expect(app).toContain("usePanelPresence(machinePanelOpen && !sideFold.right, railExitMs)");
    expect(app).toContain("const usageRail = { shown: usageAsked.shown && !sideFold.right, set: setUsageRail };");
    expect(app).toContain("detailShown: detailWanted, setDetailOpen,");
    expect(app).toContain("useInspectorFold(!phone && detailWanted,");
    // The selection, D and the Inspector's door reach the fold-aware setter;
    // a synced setting is the stored flag's.
    expect(app).toContain("useSelection(stateRef, setDetailOpen)");
    expect(app).toContain("\"panels.detail\": v => setDetailStored(v === true),");
  });

  it("settles on the open flags once the selection and the stage are known, on the Board only", () => {
    expect(app).toMatch(/sides\.settle\(\{\s*left: leftColumnWanted > 0,\s*right: !phone && \(detailWanted \|\| usageAsked\.shown \|\| machineAsked\.shown\),\s*board: !inWorkspace,\s*\}\);/);
  });
});
