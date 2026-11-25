import { describe, expect, it } from "vitest";
import type { StageTarget } from "../stage-shell";
import {
  arrange, focusSplit, insertPane, movePane, paneIds, removePane,
  sessionPaneLinks, singleSplit, withFocusedTarget, type SplitState,
} from "../workspace-split";

const session = (id: string): StageTarget => ({ kind: "session", id });
const MIN = { w: 354, h: 224 };
const DESKTOP = { w: 1200, h: 800 };

function two(): SplitState {
  return insertPane(withFocusedTarget(singleSplit(), session("saved")), "p0", "right", session("right"))!.state;
}

function grid(): SplitState {
  const state = insertPane(two(), "p0", "bottom", session("bottom-left"))!.state;
  return insertPane(state, "p1", "bottom", session("bottom-right"))!.state;
}

describe("sessions linked to Workspace panes", () => {
  // CHANGED ON PURPOSE (pane tabs): a session the focused pane showed before
  // the shell's live one is not stale, it is a tab of that pane, still open.
  it("marks the live shell session active, and the focused pane's earlier session as its tab", () => {
    const links = sessionPaneLinks(two(), session("live"));
    expect(Object.fromEntries(links)).toEqual({
      saved: { number: 1, active: false },
      live: { number: 1, active: true },
      right: { number: 2, active: false },
    });
  });

  it.each<StageTarget>([
    { kind: "empty" },
    { kind: "launch", agent: "claude", cwd: "/project", key: "launch-1" },
  ])("badges no session for a live focused target that is $kind, and keeps the pane's tabs", target => {
    expect(Object.fromEntries(sessionPaneLinks(two(), target))).toEqual({
      saved: { number: 1, active: false },
      right: { number: 2, active: false },
    });
    const emptied = { ...two(), tabs: { ...two().tabs, p0: [] } };
    expect(Object.fromEntries(sessionPaneLinks(emptied, target))).toEqual({
      right: { number: 2, active: false },
    });
  });

  it("uses the stored target when no live shell target is supplied", () => {
    expect(Object.fromEntries(sessionPaneLinks(two(), null))).toEqual({
      saved: { number: 1, active: true },
      right: { number: 2, active: false },
    });
  });

  it("counts panes across rows rather than following the split tree's depth-first order", () => {
    const state = grid();
    const arrangement = arrange(state, DESKTOP, MIN);
    expect(paneIds(state.root)).toEqual(["p0", "p2", "p1", "p3"]);
    expect(arrangement.order).toEqual(["p0", "p1", "p2", "p3"]);
    expect(Object.fromEntries(sessionPaneLinks(state, session("live"), arrangement.order))).toEqual({
      saved: { number: 1, active: false },
      live: { number: 1, active: true },
      right: { number: 2, active: false },
      "bottom-left": { number: 3, active: false },
      "bottom-right": { number: 4, active: false },
    });
  });

  it("renumbers moved panes by their new positions while keeping the focused session active", () => {
    const moved = movePane(grid(), "p0", "p3", "here");
    const arrangement = arrange(moved, DESKTOP, MIN);
    expect(arrangement.order).toEqual(["p3", "p1", "p2", "p0"]);
    expect(Object.fromEntries(sessionPaneLinks(moved, session("live"), arrangement.order))).toEqual({
      "bottom-right": { number: 1, active: false },
      right: { number: 2, active: false },
      "bottom-left": { number: 3, active: false },
      saved: { number: 4, active: false },
      live: { number: 4, active: true },
    });
  });

  it.each([
    { label: "maximized", box: DESKTOP, max: "p0", why: "max" },
    { label: "390px", box: { w: 390, h: 800 }, max: null, why: "narrow" },
    { label: "320px", box: { w: 320, h: 800 }, max: null, why: "narrow" },
  ])("retains all reading-order references in the $label pane strip", ({ box, max, why }) => {
    const state = movePane(grid(), "p0", "p3", "here");
    const split = arrange(state, DESKTOP, MIN);
    const strip = arrange({ ...state, max }, box, MIN);
    expect(strip.mode).toBe("strip");
    expect(strip.why).toBe(why);
    expect(strip.order).toEqual(["p3", "p1", "p2", "p0"]);
    const links = sessionPaneLinks(state, session("live"), strip.order);
    expect(links).toEqual(sessionPaneLinks(state, session("live"), split.order));
    expect(links.size).toBe(5);
    expect(links.get("live")).toEqual({ number: 4, active: true });
    expect(links.get("saved")).toEqual({ number: 4, active: false });
  });

  it("moves the active reference with focus and remembers the session the shell just left", () => {
    const focused = focusSplit(two(), "p1", session("live"));
    expect(Object.fromEntries(sessionPaneLinks(focused, session("right")))).toEqual({
      saved: { number: 1, active: false },
      live: { number: 1, active: false },
      right: { number: 2, active: true },
    });
  });

  it("keeps empty and launching panes in the count without creating session references for them", () => {
    const state = grid();
    const launching = { kind: "launch", agent: "codex", cwd: "/project", key: "launch-2" } as const;
    const targets = { ...state.targets, p0: session("live"), p1: { kind: "empty" } as const, p2: launching };
    const tabs = { ...state.tabs, p0: [session("live")], p1: [], p2: [launching] };
    expect(Object.fromEntries(sessionPaneLinks({ ...state, targets, tabs }, session("live"), arrange(state, DESKTOP, MIN).order))).toEqual({
      live: { number: 1, active: true },
      "bottom-right": { number: 4, active: false },
    });
  });

  it("has no badge in a single pane, including after its last neighbour closes", () => {
    const single = withFocusedTarget(singleSplit(), session("saved"));
    const closed = removePane(two(), "p1");
    for (const state of [single, closed]) {
      const arrangement = arrange(state, DESKTOP, MIN);
      expect(arrangement.mode).toBe("one");
      expect(sessionPaneLinks(state, session("live")).size).toBe(0);
      expect(sessionPaneLinks(state, session("live"), arrangement.order).size).toBe(0);
    }
  });
});
