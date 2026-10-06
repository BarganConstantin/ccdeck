// The git view's sizes: 60% of the window by default, floors that keep every
// pane readable and the canvas beside it usable, dividers that step from the
// keyboard, and a remembered choice that survives a bad value in the store.
import { describe, expect, it } from "vitest";
import {
  CANVAS_MIN, GIT_VIEW_DEFAULTS, PANE_MIN, PANEL_MIN, SPLIT_BAND, edgeBounds, filesBounds, graphBounds, isSheet,
  panelWidth, parseGitViewPrefs, splitterTarget,
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
      .toEqual({ w: 0.5, graphH: 0.3, filesW: 0.35 });
  });

  it("falls back per field, and on a store that is not JSON at all", () => {
    expect(parseGitViewPrefs(JSON.stringify({ w: 7, graphH: "x", filesW: 0.3 })))
      .toEqual({ ...GIT_VIEW_DEFAULTS, filesW: 0.3 });
    expect(parseGitViewPrefs("{not json")).toEqual(GIT_VIEW_DEFAULTS);
    expect(parseGitViewPrefs(null)).toEqual(GIT_VIEW_DEFAULTS);
  });
});
