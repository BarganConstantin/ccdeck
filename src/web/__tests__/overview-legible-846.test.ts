// #846: at overview zoom the canvas was unreadable.
//
// A real board settles at about 0.32, in the far detail tier. There a card's
// 12px name drew at about 4px, and cluster labels — scaled by min(1, zoom) on
// screen — at about 3px. The far tier hid a card's details but never enlarged
// what it kept, so "what are my agents doing right now" could not be answered
// at a glance on exactly the view a busy board lives in.
//
// Two things are drawn at a fixed on-screen size now: the cluster label, at 1×
// at every zoom, and a card's title row at the far tier, at about 11px. Both by
// transform, so nothing's measured size changes and the graph never reflows on
// a zoom.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const clusters = read("../components/SessionClusters.tsx");
const app = read("../App.tsx");
const css = read("../styles.css").replace(/\/\*[\s\S]*?\*\//g, "");

describe("cluster labels stay readable at any zoom (#846)", () => {
  it("draws the label at 1× on screen, not min(1, zoom)", () => {
    expect(clusters).toMatch(/transform: `scale\(\$\{1 \/ \(zoom \|\| 1\)\}\)`/);
    expect(clusters).not.toMatch(/Math\.min\(1, zoom\) \/ \(zoom \|\| 1\)/);
  });

  it("divides the lift out too, so the tab keeps its 1× geometry", () => {
    expect(clusters).toMatch(/top: c\.y - LABEL_LIFT \/ \(zoom \|\| 1\)/);
  });
});

describe("what a card keeps at a distance is drawn at a size that reads (#846)", () => {
  // The far tier kept the title row at the canvas's scale and scaled it back up
  // by 0.9 / zoom — a state pill and one character of a name. The distances
  // below the full card draw a face in its place instead, laid out in screen
  // pixels (AgentNode's NodeFace); adaptive-graph.test.ts holds the rest of it.
  const face = /\.canvas-wrap\[data-lod="compact"\] \.lod-face,\s*\.canvas-wrap\[data-lod="overview"\] \.lod-face\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

  it("sizes the face to the card's box times the zoom and scales it back by the inverse", () => {
    expect(face).toMatch(/width:\s*calc\(\(100% \+ 2px\) \* var\(--zoom, 1\)\)/);
    expect(face).toMatch(/height:\s*calc\(\(100% \+ 2px\) \* var\(--zoom, 1\)\)/);
    expect(face).toMatch(/transform:\s*scale\(calc\(1 \/ var\(--zoom, 1\)\)\)/);
    expect(face).toMatch(/transform-origin:\s*left top/);
  });

  it("is positioned over the card, so no card's measured size changes", () => {
    expect(face).toMatch(/position:\s*absolute/);
    expect(css).not.toMatch(/data-lod="(compact|overview)"\][^{]*\.agent-node\s*\{[^}]*(?:^|[;\s])(?:height|width|padding|font-size):/m);
  });

  it("gets its zoom from the canvas, written where the mode is", () => {
    expect(app).toMatch(/style\.setProperty\("--zoom", String\(vp\.zoom\)\)/);
  });
});
