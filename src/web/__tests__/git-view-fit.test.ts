// The canvas beside the open git view: the session framed in the part the
// panel leaves, agents waiting on the reader kept in that frame while every
// card can keep its full face, and a marker for each one that could not be.
import { afterEach, describe, expect, it } from "vitest";
import {
  boxesOverlap, clearOfLabels, foldMarkers, frameForGitView, gitViewCover, gitViewFrame, labelTopAt, markerRoom, markerTop, outOfSight, setGitViewFrame, stackMarkers,
  MARKER_H,
} from "../git-view-fit";
import { LABEL_LIFT } from "../session-chrome";
import { DETAIL_ENTER_ZOOM } from "../semantic-zoom";
import { sourceOf } from "./client-source";
import { sheetText } from "./sheet-source";

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

describe("the edge markers beside the cluster name tags", () => {
  // A 1280×340 window: the pane is 288px tall, the marker right-aligned at the
  // canvas's uncovered edge, a cluster's name tag under its top.
  const mark = { top: 72, left: 285, right: 448 };
  const tag = { left: 155, right: 338, top: 93, bottom: 111 };

  it("move off a name tag they would cover, to just under it", () => {
    expect(clearOfLabels([mark], [tag], 288)).toEqual([111 + 4]);
  });

  it("stay where they are beside a tag outside their own width, or clear of it", () => {
    expect(clearOfLabels([mark], [{ ...tag, right: 280 }], 288)).toEqual([72]);
    expect(clearOfLabels([{ ...mark, top: 140 }], [tag], 288)).toEqual([140]);
  });

  it("go above the tag when under it would pass the pane's foot, and stay put when neither way is free", () => {
    const low = { left: 155, right: 338, top: 230, bottom: 250 };
    expect(clearOfLabels([{ ...mark, top: 240 }], [low], 288)).toEqual([230 - 4 - MARKER_H]);
    const tall = { left: 155, right: 338, top: 60, bottom: 260 };
    expect(clearOfLabels([{ ...mark, top: 120 }], [tall], 288)).toEqual([120]);
  });

  it("keep a row apart while they move", () => {
    const tops = clearOfLabels([mark, { ...mark, top: 102 }], [tag], 288);
    expect(tops[0]).toBe(115);
    expect(tops[1]).toBe(145);
  });

  it("know where a tag lands once the camera has moved: on the plane, lifted a fixed height above its box", () => {
    // A tag 12px above a box at plane y 400, drawn at zoom 0.5 with the camera at y 20.
    const was = { y: 20, zoom: 0.5 }, now = { y: -100, zoom: 0.25 };
    const shownTop = was.y + 400 * was.zoom - LABEL_LIFT;
    expect(labelTopAt(shownTop, was, now)).toBe(now.y + 400 * now.zoom - LABEL_LIFT);
  });

  it("are placed clear of the tags the frame put in the canvas, measured as drawn", () => {
    const view = sourceOf("components/GitView.tsx");
    // Where the frame's camera puts each tag: the frame asks with its own move's target.
    expect(view).toMatch(/const tagTop = labelTopAt\(r\.top - rect\.top, was, at\);/);
    expect(view).toMatch(/const boxes = takeOutOfSight\(plan\.viewport, was\);/);
    expect(view).toMatch(/setLabelBoxes\(plan\.leftOut\.length \? boxes : NO_BOXES\);/);
    const edge = view.slice(view.indexOf("function EdgeMarkers("), view.indexOf("// ── the panel"));
    expect(edge).toMatch(/clearOfLabels\(/);
    expect(edge).toMatch(/useLayoutEffect\(/);
  });
});

describe("the canvas's filter bar beside the open view", () => {
  const bar = { left: 0, right: 217, top: 10, bottom: 42 };

  it("covers a name tag that reaches under it, by a pixel or more, and no other", () => {
    expect(boxesOverlap({ left: 121, right: 271, top: 38, bottom: 56 }, bar)).toBe(true);
    expect(boxesOverlap({ left: 121, right: 271, top: 42, bottom: 60 }, bar)).toBe(false);
    expect(boxesOverlap({ left: 217, right: 300, top: 20, bottom: 38 }, bar)).toBe(false);
  });

  it("is counted as covered when the frame places the tags: a tag under it leaves the Tab order and is not drawn", () => {
    const view = sourceOf("components/GitView.tsx");
    expect(view).toMatch(/const underBar = barBox !== null && boxesOverlap\(tag, barBox\);/);
    expect(view).toMatch(/\(covered \|\| underBar \? under : clear\)\.add\(el\);/);
    // Neither is a tag an edge marker has to keep off.
    expect(view).toMatch(/if \(covered \|\| underBar \|\| r\.width <= 0\) continue;/);
    expect(sheetText()).toMatch(/:root\[data-git-view\] \.cluster-label\[inert\] \{ visibility: hidden; \}/);
  });
});

describe("cards the reader cannot see while the view is open", () => {
  // The canvas from x 72 to the panel's edge at 576, y 52 to 900, in screen px.
  const view = { left: 72, right: 576, top: 52, bottom: 900 };
  const at = (left: number, top: number) => ({ left, right: left + 260, top, bottom: top + 120 });

  it("leave the Tab order only when wholly under the panel", () => {
    expect(outOfSight(at(700, 200), view)).toBe(true);
    expect(outOfSight(at(576, 200), view)).toBe(true);
    expect(outOfSight(at(500, 200), view)).toBe(false);
  });

  it("and when wholly off the canvas's left, top or bottom edge, as a pan or the frame leaves them", () => {
    // Off the left: the cards a frame beside the view leaves of the sessions to its left.
    expect(outOfSight(at(-400, 200), view)).toBe(true);
    expect(outOfSight(at(-188, 200), view)).toBe(true);
    expect(outOfSight(at(-187, 200), view)).toBe(false);
    expect(outOfSight(at(200, -68), view)).toBe(true);
    expect(outOfSight(at(200, -67), view)).toBe(false);
    expect(outOfSight(at(200, 900), view)).toBe(true);
    expect(outOfSight(at(200, 899), view)).toBe(false);
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
