// The canvas beside the open git view: the session framed in the part the
// panel leaves, agents waiting on the reader kept in that frame while every
// card can keep its full face, and a marker for each one that could not be.
import { afterEach, describe, expect, it } from "vitest";
import {
  foldMarkers, frameForGitView, gitViewCover, gitViewFrame, markerRoom, markerTop, setGitViewFrame, stackMarkers, whollyCovered,
} from "../git-view-fit";
import { DETAIL_ENTER_ZOOM } from "../semantic-zoom";
import { sourceOf } from "./client-source";

const card = (id: string, x: number, y: number) => ({ id, x, y, width: 260, height: 120, lane: 0 });
const pane = { width: 1080, height: 848 };

describe("the frame beside the view", () => {
  const root = card("s1", 0, 0);
  const sub = card("s1::a", 320, 0);

  it("frames the session in the part of the canvas the panel leaves", () => {
    const plan = gitViewFrame({ pane, cover: 504, session: [root, sub], alarms: [], anchor: root });
    const right = plan.viewport.x + (sub.x + sub.width) * plan.viewport.zoom;
    expect(right).toBeLessThanOrEqual(pane.width - 504);
    expect(plan.viewport.zoom).toBeGreaterThanOrEqual(DETAIL_ENTER_ZOOM);
    expect(plan.leftOut).toEqual([]);
  });

  it("keeps a waiting agent in the frame when every card still keeps its face", () => {
    const waiting = card("w", 0, 200);
    const plan = gitViewFrame({ pane, cover: 504, session: [root, sub], alarms: [waiting], anchor: root });
    expect(plan.leftOut).toEqual([]);
    const bottom = plan.viewport.y + (waiting.y + waiting.height) * plan.viewport.zoom;
    expect(bottom).toBeLessThanOrEqual(pane.height);
  });

  it("lets the session win when the waiting agent is too far to fit legibly, and names it", () => {
    const far = card("w", 2400, 1600);
    const plan = gitViewFrame({ pane, cover: 504, session: [root, sub], alarms: [far], anchor: root });
    expect(plan.leftOut).toEqual(["w"]);
    expect(plan.viewport.zoom).toBeGreaterThanOrEqual(DETAIL_ENTER_ZOOM);
  });

  it("zooms out to keep a wide session whole rather than leave part of it under the panel", () => {
    const wide = [card("s1", 0, 0), card("s1::a", 900, 0), card("s1::b", 1500, 300)];
    const plan = gitViewFrame({ pane, cover: 504, session: wide, alarms: [], anchor: wide[0] });
    const right = plan.viewport.x + (1500 + 260) * plan.viewport.zoom;
    expect(right).toBeLessThanOrEqual(pane.width - 504);
    expect(plan.viewport.zoom).toBeLessThan(DETAIL_ENTER_ZOOM);
  });

  it("counts a card's tool lane only at a zoom where the lane is drawn", () => {
    const busy = [{ ...card("s1", 0, 0), lane: 420 }];
    const roomy = gitViewFrame({ pane, cover: 0, session: busy, alarms: [], anchor: busy[0] });
    // 680 flow px of card and lane fit 976px whole: the lane is drawn and counted.
    expect(roomy.viewport.x + 680 * roomy.viewport.zoom).toBeLessThanOrEqual(pane.width - 32);
  });

  it("frames the session's cluster name with it, below the canvas's filter bar", () => {
    const plan = gitViewFrame({ pane, cover: 504, top: 88, session: [root, sub], alarms: [], anchor: root });
    // The cluster tag above the top card is inside the frame, under the bar.
    expect(plan.viewport.y + (root.y - 44) * plan.viewport.zoom).toBeGreaterThanOrEqual(96);
  });

  it("never zooms a card past its natural size", () => {
    const plan = gitViewFrame({ pane, cover: 0, session: [root], alarms: [], anchor: root });
    expect(plan.viewport.zoom).toBeLessThanOrEqual(1);
  });
});

describe("the edge markers", () => {
  it("sit level with their card, inside the pane", () => {
    expect(markerTop({ x: 0, y: 400, width: 260, height: 120 }, { y: 0, zoom: 1 }, 848)).toBe(448);
    expect(markerTop({ x: 0, y: -900, width: 260, height: 120 }, { y: 0, zoom: 1 }, 848)).toBe(72);
    expect(markerTop({ x: 0, y: 9000, width: 260, height: 120 }, { y: 0, zoom: 1 }, 848)).toBe(808);
  });

  it("never land on one another", () => {
    expect(stackMarkers([200, 205, 400], 848)).toEqual([200, 230, 400]);
  });

  it("stand one above another when several cards are below the frame", () => {
    // Every card below the frame is pinned to the pane's foot: they used to
    // collapse onto that one spot, one marker hiding the rest.
    expect(stackMarkers([808, 808, 808], 848)).toEqual([748, 778, 808]);
    expect(stackMarkers([700, 760, 800, 808, 808], 848)).toEqual([688, 718, 748, 778, 808]);
    const tops = stackMarkers([72, 72, 808, 808, 808, 808], 848);
    expect(new Set(tops).size).toBe(6);
    expect(Math.min(...tops)).toBeGreaterThanOrEqual(72);
    expect(Math.max(...tops)).toBeLessThanOrEqual(808);
  });

  it("fold the ones that cannot get a row into one that counts them, waiting before failed", () => {
    const room = markerRoom(848);
    expect(room).toBe(25);
    // As many as fit: nothing folds, and every one gets its own place.
    const fit = Array.from({ length: room }, (_, i) => ({ id: `w${i}`, alarm: "waiting" as const, top: 808 }));
    expect(foldMarkers(fit, room).folded).toEqual([]);
    expect(new Set(stackMarkers(fit.map(m => m.top), 848)).size).toBe(room);
    expect(Math.min(...stackMarkers(fit.map(m => m.top), 848))).toBeGreaterThanOrEqual(72);
    // One more: the last row counts what is left, and a failed agent folds before a waiting one.
    const many = [{ id: "f0", alarm: "failed" as const, top: 100 }, ...fit];
    const { kept, folded } = foldMarkers(many, room);
    expect(kept).toHaveLength(room - 1);
    expect(kept.every(m => m.alarm === "waiting")).toBe(true);
    expect(folded.map(m => m.id)).toEqual(["w24", "f0"]);
  });
});

describe("cards under the panel", () => {
  it("leave the Tab order only when wholly covered", () => {
    expect(whollyCovered({ left: 700, right: 960 }, 576)).toBe(true);
    expect(whollyCovered({ left: 500, right: 760 }, 576)).toBe(false);
  });
});

describe("the camera's own fits while the view is open", () => {
  afterEach(() => setGitViewFrame(null));

  it("frame for the view instead of the whole board", () => {
    const calls: number[] = [];
    expect(frameForGitView(400)).toBe(false);
    setGitViewFrame(ms => calls.push(ms), 504);
    expect(frameForGitView(400)).toBe(true);
    expect(calls).toEqual([400]);
    expect(gitViewCover()).toBe(504);
    setGitViewFrame(null);
    expect(gitViewCover()).toBe(0);
  });

  it("is asked by the fit and by a focus on one card", () => {
    expect(sourceOf("use-camera.ts")).toMatch(/frameForGitView\(duration\)/);
    expect(sourceOf("use-agent-focus.ts")).toMatch(/gitViewCover\(\)/);
  });
});
