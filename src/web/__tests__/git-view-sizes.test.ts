// The git view's sizes: 60% of the window by default, floors that keep every
// pane readable and the canvas beside it usable, dividers that step from the
// keyboard, and a remembered choice that survives a bad value in the store.
import { describe, expect, it } from "vitest";
import {
  CANVAS_MIN, FK_HISTORY_MIN, FK_INSPECTOR_MIN, GIT_VIEW_DEFAULTS, PANE_MIN, PANEL_MIN, SIDE_HISTORY_MIN, SIDEBAR_MAX, SIDEBAR_MIN, SPLIT_BAND, edgeBounds,
  filesBounds, fkGraphBounds, graphBounds, isSheet, isSidebarFloating, panelWidth, parseGitViewPrefs, sidebarBounds, sidebarLayout, sidebarShownFor, splitterTarget,
} from "../git-view-sizes";

describe("the panel's width", () => {
  it("takes 60% of a 1440px window by default", () => {
    expect(panelWidth(GIT_VIEW_DEFAULTS.w, 1440, 1440)).toBe(864);
  });

  it("never goes under 560px, and never leaves the canvas under 360px", () => {
    expect(panelWidth(0.1, 1440, 1440)).toBe(PANEL_MIN);
    expect(panelWidth(0.95, 1440, 1440)).toBe(1440 - CANVAS_MIN);
    // A session list takes 240px of the window: the canvas keeps its floor first.
    expect(panelWidth(0.6, 1100, 860)).toBe(860 - CANVAS_MIN);
  });

  it("is a full sheet below 1100px", () => {
    expect(isSheet(1099)).toBe(true);
    expect(isSheet(1100)).toBe(false);
  });
});

describe("the dividers' floors", () => {
  it("keeps the history at 120px or more and the panes under it at 220px or more", () => {
    expect(graphBounds(700)).toEqual({ min: 120, max: 700 - SPLIT_BAND - PANE_MIN });
  });

  it("keeps the files list and the diff at 220px or more, the list at 520px or less", () => {
    expect(filesBounds(600)).toEqual({ min: PANE_MIN, max: 600 - SPLIT_BAND - PANE_MIN });
    expect(filesBounds(1400)).toEqual({ min: PANE_MIN, max: 520 });
  });
});

describe("a divider from the keyboard", () => {
  const edge = edgeBounds(1440, 1440);
  it("widens the panel when its left edge moves left", () => {
    expect(splitterTarget("edge", { step: -16 }, 864, edge, 864)).toBe(880);
    expect(splitterTarget("edge", { step: 64 }, 864, edge, 864)).toBe(800);
  });

  it("gives the panel its least width on Home and its most on End, as its aria-valuenow says", () => {
    // WAI-ARIA window splitter: Home moves to the position that gives the
    // controlled pane its smallest size, so valuenow lands on valuemin.
    expect(splitterTarget("edge", { to: "min" }, 864, edge, 864)).toBe(edge.min);
    expect(splitterTarget("edge", { to: "max" }, 864, edge, 864)).toBe(edge.max);
  });

  it("grows the pane above or left of the other dividers when they move down or right", () => {
    const g = graphBounds(700);
    expect(splitterTarget("graph", { step: 16 }, 300, g, 294)).toBe(316);
    expect(splitterTarget("graph", { to: "min" }, 300, g, 294)).toBe(120);
    expect(splitterTarget("files", { step: -64 }, 300, filesBounds(800), 320)).toBe(236);
  });

  it("stops at the floors and goes back to the default on Enter", () => {
    expect(splitterTarget("files", { step: -64 }, 230, filesBounds(800), 320)).toBe(PANE_MIN);
    expect(splitterTarget("graph", { to: "reset" }, 120, graphBounds(700), 294)).toBe(294);
  });
});

describe("the remembered sizes", () => {
  it("reads what was stored", () => {
    expect(parseGitViewPrefs(JSON.stringify({ w: 0.5, graphH: 0.3, filesW: 0.35 })))
      .toEqual({ ...GIT_VIEW_DEFAULTS, w: 0.5, graphH: 0.3, filesW: 0.35 });
  });

  it("falls back per field, and on a store that is not JSON at all", () => {
    expect(parseGitViewPrefs(JSON.stringify({ w: 7, graphH: "x", filesW: 0.3 })))
      .toEqual({ ...GIT_VIEW_DEFAULTS, filesW: 0.3 });
    expect(parseGitViewPrefs("{not json")).toEqual(GIT_VIEW_DEFAULTS);
    expect(parseGitViewPrefs(null)).toEqual(GIT_VIEW_DEFAULTS);
  });
});

describe("the Fork look's sizes", () => {
  it("opens in the deck look, and remembers the Fork look once chosen", () => {
    expect(GIT_VIEW_DEFAULTS.look).toBe("deck");
    expect(parseGitViewPrefs(JSON.stringify({ look: "fork" })).look).toBe("fork");
    expect(parseGitViewPrefs(JSON.stringify({ look: "bogus" })).look).toBe("deck");
  });

  it("takes 72% of the window and gives the history 35% of its height, without moving the deck look's sizes", () => {
    expect(panelWidth(GIT_VIEW_DEFAULTS.fkW, 1440, 1440)).toBe(1037);
    expect(GIT_VIEW_DEFAULTS.fkGraphH).toBe(0.35);
    const p = parseGitViewPrefs(JSON.stringify({ w: 0.5, fkW: 0.8 }));
    expect([p.w, p.fkW]).toEqual([0.5, 0.8]);
  });

  it("keeps the history over 110px and the inspector over 160px", () => {
    expect(fkGraphBounds(700)).toEqual({ min: FK_HISTORY_MIN, max: 700 - FK_INSPECTOR_MIN });
    expect(fkGraphBounds(200)).toEqual({ min: FK_HISTORY_MIN, max: FK_HISTORY_MIN });
  });

  it("draws a 264px sidebar column, resizable between 176 and 436px, never leaving the history beside it under 600px", () => {
    expect(GIT_VIEW_DEFAULTS.sidebarW).toBe(264);
    expect(sidebarBounds(1200)).toEqual({ min: SIDEBAR_MIN, max: SIDEBAR_MAX });
    // A 1280px window's panel: past 320px the sidebar would float, and hide.
    expect(sidebarBounds(920)).toEqual({ min: SIDEBAR_MIN, max: 920 - SIDE_HISTORY_MIN });
    expect(sidebarBounds(700)).toEqual({ min: SIDEBAR_MIN, max: SIDEBAR_MIN });
    // The divider is drawn only beside the history: no step of it floats the sidebar away.
    for (let panelW = SIDEBAR_MIN + SIDE_HISTORY_MIN; panelW <= 1600; panelW += 7) {
      expect(isSidebarFloating(panelW, sidebarBounds(panelW).max, false), `${panelW}px`).toBe(false);
    }
    expect(parseGitViewPrefs(JSON.stringify({ sidebarW: 9000 })).sidebarW).toBe(SIDEBAR_MAX);
  });

  it("shows the sidebar beside a history that keeps 600px unless the reader hid it, and keeps that choice", () => {
    expect(sidebarShownFor({ sidebarShown: null }, false, false)).toBe(true);
    expect(sidebarShownFor({ sidebarShown: false }, false, false)).toBe(false);
    expect(sidebarShownFor({ sidebarShown: true }, false, false)).toBe(true);
    // Floating, it is out only while the reader has it out, whatever was remembered.
    expect(sidebarShownFor({ sidebarShown: true }, true, false)).toBe(false);
    expect(sidebarShownFor({ sidebarShown: false }, true, true)).toBe(true);
  });

  it("narrows a sidebar chosen on a wider panel to what keeps it beside a narrower one, and keeps the choice", () => {
    // Widened to its most on a 1440px window (a 1037px panel)…
    expect(sidebarLayout(SIDEBAR_MAX, 1037, false)).toEqual({ width: SIDEBAR_MAX, floating: false });
    // …it stays beside the history on a 1280px window, as wide as the history leaves it.
    expect(sidebarLayout(SIDEBAR_MAX, 920, false)).toEqual({ width: 920 - SIDE_HISTORY_MIN, floating: false });
    // The panel's edge one step narrower: still beside it.
    expect(sidebarLayout(SIDEBAR_MAX, 1021, false)).toEqual({ width: 1021 - SIDE_HISTORY_MIN, floating: false });
    // A narrower choice is kept as it is.
    expect(sidebarLayout(240, 920, false)).toEqual({ width: 240, floating: false });
    // Narrowed no further than the default: where the default would float, a widened one floats too, at the width chosen.
    const def = GIT_VIEW_DEFAULTS.sidebarW;
    expect(sidebarLayout(SIDEBAR_MAX, def + SIDE_HISTORY_MIN - 1, false)).toEqual({ width: SIDEBAR_MAX, floating: true });
    expect(sidebarLayout(def, def + SIDE_HISTORY_MIN - 1, false).floating).toBe(true);
    expect(sidebarLayout(264, 1300, true)).toEqual({ width: 264, floating: true });
    // Widening it never floats it where the default width stays beside the history.
    for (let panelW = SIDEBAR_MIN + SIDE_HISTORY_MIN; panelW <= 1600; panelW += 7) {
      for (const stored of [SIDEBAR_MIN, def, 320, SIDEBAR_MAX]) {
        const atDefault = sidebarLayout(Math.min(stored, def), panelW, false).floating;
        expect(sidebarLayout(stored, panelW, false).floating, `${stored} in ${panelW}px`).toBe(atDefault);
      }
    }
  });

  it("floats the sidebar over the history on a sheet and wherever the history beside it would be under 600px", () => {
    expect(isSidebarFloating(1037, 264, false)).toBe(false);
    expect(isSidebarFloating(864, 264, false)).toBe(false);
    expect(isSidebarFloating(863, 264, false)).toBe(true);
    expect(isSidebarFloating(1300, 264, true)).toBe(true);
  });

  it("remembers the inspector's tab and whether it is folded, and opens on Changes", () => {
    expect(GIT_VIEW_DEFAULTS.inspectorTab).toBe("changes");
    expect(parseGitViewPrefs(JSON.stringify({ inspectorTab: "commit", inspectorCollapsed: true })))
      .toMatchObject({ inspectorTab: "commit", inspectorCollapsed: true });
    expect(parseGitViewPrefs(JSON.stringify({ inspectorTab: 3 })).inspectorTab).toBe("changes");
  });
});
