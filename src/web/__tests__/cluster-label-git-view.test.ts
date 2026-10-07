// A session's name on the canvas, while the git view is open beside it.
//
// The pill is drawn whole inside the pane and clear of the chrome over it, or
// not drawn (cluster-label-room.ts). The open git view covers the pane's right
// edge, so it counts as chrome too: a pill under it is not drawn, one that
// would run into it gives up width at its edge, and closing the view gives
// every one back. It counts by the width the view settles at
// (gitViewCover), which the layer subscribes to: the panel is mounted outside
// the pane and slides, so a box measured off it would be taken mid-slide and
// kept after it had gone.
//
// The view's own frame still makes a pill it puts under the panel or under the
// filter bar inert (GitView.tsx, git-view-fit.test.ts); this is the per-frame
// rule beside it, which follows a pan made while the view is open.
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { labelMaxWidth, type Cluster } from "../cluster-bounds";
import { LABEL_EDGE, LABEL_MIN_W, labelRoom, withGitViewCover, type PaneBox } from "../cluster-label-room";
import { gitViewCover, setGitViewFrame, subscribeGitViewCover } from "../git-view-fit";

const component = readFileSync(fileURLToPath(new URL("../components/SessionClusters.tsx", import.meta.url)), "utf8");

/** A one-card cluster: its pill starts at layout x 216 and sits 12px above y 400. */
const C: Cluster = { sessionId: "s1", label: "shop-api", fullLabel: "shop-api", title: "shop-api", x: 200, y: 400, w: 276, h: 210 };
const PANE = { width: 1200, height: 800 };
const Z = 0.5;
/** The camera that puts C's pill at screen `left`, `top` in the pane at zoom Z. */
const at = (left: number, top: number) => ({ x: left - (C.x + 16) * Z, y: top - C.y * Z + 12, zoom: Z });
/** The category filter bar, as it measures at the canvas's top left. */
const BAR: PaneBox = { left: 14, top: 14, right: 231, bottom: 46 };
/** The view open at 504px over the pane's right edge: its left edge at 696. */
const COVER = 504;

afterEach(() => setGitViewFrame(null));

describe("the open git view, as chrome over the pane", () => {
  it("is a band down the pane's right edge, as wide as the view covers", () => {
    expect(withGitViewCover([BAR], PANE, COVER)).toEqual([BAR, { left: 696, top: 0, right: 1200, bottom: 800 }]);
  });

  it("is nothing while the view is shut, or before the pane is measured", () => {
    const chrome = [BAR];
    expect(withGitViewCover(chrome, PANE, 0)).toBe(chrome);
    expect(withGitViewCover(chrome, { width: 0, height: 0 }, COVER)).toBe(chrome);
  });

  it("covers the whole pane when the view is a full sheet", () => {
    expect(withGitViewCover([], PANE, 1400)).toEqual([{ left: 0, top: 0, right: 1200, bottom: 800 }]);
  });

  it("hides a pill that starts under the view, and draws it again once the view is shut", () => {
    const view = at(900, 300);
    expect(labelRoom(C, view, PANE, withGitViewCover([], PANE, COVER)).hidden).toBe(true);
    expect(labelRoom(C, view, PANE, withGitViewCover([], PANE, 0))).toEqual({ hidden: false, maxWidth: labelMaxWidth(C.w, Z) });
  });

  it("stops a pill that runs into the view at its edge, and hides one left too little room", () => {
    const left = 696 - LABEL_EDGE - 100;
    const near = labelRoom(C, at(left, 300), PANE, withGitViewCover([], PANE, COVER));
    expect(near).toEqual({ hidden: false, maxWidth: Math.min(labelMaxWidth(C.w, Z), 100) });
    const nearer = labelRoom(C, at(696 - LABEL_EDGE - (LABEL_MIN_W - 1), 300), PANE, withGitViewCover([], PANE, COVER));
    expect(nearer.hidden).toBe(true);
  });

  it("leaves a pill clear of the view as it was", () => {
    const view = at(300, 300);
    expect(labelRoom(C, view, PANE, withGitViewCover([BAR], PANE, COVER))).toEqual(labelRoom(C, view, PANE, [BAR]));
  });
});

describe("the cover the layer subscribes to", () => {
  it("tells a subscriber when the view opens, takes a new width and closes, and not otherwise", () => {
    const seen: number[] = [];
    const stop = subscribeGitViewCover(() => seen.push(gitViewCover()));
    const frame = () => {};
    setGitViewFrame(frame, COVER);
    setGitViewFrame(frame, COVER);
    setGitViewFrame(() => {}, COVER);
    setGitViewFrame(frame, 620);
    setGitViewFrame(null);
    setGitViewFrame(null);
    stop();
    setGitViewFrame(frame, COVER);
    expect(seen).toEqual([COVER, 620, 0]);
  });

  it("is read by the layer and folded into the chrome it measures, before the pills are placed", () => {
    expect(component).toContain("const gitCover = useSyncExternalStore(subscribeGitViewCover, gitViewCover, gitViewCover);");
    expect(component).toMatch(/useLayoutEffect\(\(\) => \{[\s\S]{0,300}const next = withGitViewCover\(paneChrome\(host\), pane, gitCover\);/);
    // Called before the layer's early return, as every hook must be.
    expect(component.indexOf("useSyncExternalStore(subscribeGitViewCover")).toBeLessThan(component.indexOf("if (clusters.length <= 1) return null;"));
  });
});
