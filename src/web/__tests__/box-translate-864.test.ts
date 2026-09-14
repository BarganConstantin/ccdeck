// #864: the canvas session boxes moved by animating left, top, width and
// height. Since #353 those change only when the layout does — a session gaining
// a node, or pushed aside by one that grew — and the box eases them over the
// 320ms the nodes take, so it arrives with its cards rather than ahead of them.
// The position rides a translate now, so that move runs on the compositor; the
// size stays width and height, which change only when a session's membership
// does.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const raw = read("../styles.css");
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
const tsx = read("../components/SessionClusters.tsx");

const card = /(?:^|\n)\.cluster-card\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
const transition = /transition:\s*([^;]+);/.exec(card)?.[1].replace(/\s+/g, " ") ?? "";

describe("the session box moves by translate (#864)", () => {
  it("writes its position as a translate in layout space, from the origin", () => {
    expect(tsx).toMatch(/left: 0,\s*top: 0,\s*transform: `translate\(\$\{c\.x\}px, \$\{c\.y\}px\)`,/);
    expect(tsx).not.toMatch(/left: c\.x,|top: c\.y,/);
  });

  it("eases that translate on the nodes' own curve, and no longer left or top", () => {
    expect(transition).toContain("transform 320ms cubic-bezier(0.22,1,0.36,1)");
    expect(transition).not.toMatch(/\b(left|top) \d+ms/);
    // The size still eases with it, and the fade is not travel.
    expect(transition).toMatch(/width 320ms/);
    expect(transition).toMatch(/height 320ms/);
    expect(transition).toMatch(/opacity 200ms/);
  });

  it("still keeps only the fade during a drag and under reduced motion", () => {
    expect(css).toMatch(/\.canvas-wrap\.dragging-any \.cluster-card\s*\{\s*transition: opacity 200ms ease;\s*\}/);
    expect(raw).toContain("  .cluster-card { transition: opacity 200ms ease; }");
  });
});
