// A session's name on the canvas could not be clicked.
//
// WHAT WAS OBSERVED, in Chromium on a board of nine sessions at 1440×900, at
// the opening fit and zoomed out: `document.elementFromPoint` at the centre of
// every pill returned React Flow's pane, a mouse click there left the camera
// where it was, the pill's hover never lit and its tooltip never showed. Only
// Tab and Enter reached it, so the one control that takes the reader to a
// session worked from the keyboard alone.
//
// React Flow draws what it owns inside `.react-flow__renderer`, which its own
// stylesheet stacks at z-index 4 and fills with the pane. The pills were in the
// cluster layer, a child of <ReactFlow> beside the renderer at z-index 0: under
// the pane, so every pointer event over a pill went to the pane. Raising the
// layer would not have done: the renderer is a stacking context, so a layer
// outside it is either under all of it or over all of it, and over it the pills
// would cover the cards, which have to win where the two overlap.
//
// So the pills are drawn inside React Flow's viewport, through a portal: over
// the pane and under the cards, in the element whose transform is already the
// camera. The layer takes no pointer events and the pills take them back, so
// the empty canvas around and between them still pans and selects as before.
// The tinted boxes stay where they were; nothing presses them.
//
// Pure functions, the sheets and the component's source, like the rest of this
// suite: no DOM, no layout engine. The browser half was checked with a real
// mouse at six widths, both themes, zoomed in, zoomed out and panned.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Node } from "reactflow";
import { sessionGroupNodes } from "../session-group-nodes";
import type { AgentNodeData } from "../types";
import { declared, sheetRules } from "./sheet-cascade";

const at = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
/** Comments out, since the notes quote the markup they explain. */
const component = at("../components/SessionClusters.tsx")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
/** React Flow's own stylesheet, the one main.tsx imports. */
const reactFlowCss = at("../../../node_modules/reactflow/dist/style.css");

const rule = (sel: string) => {
  const found = sheetRules().filter(r => r.selectors.includes(sel));
  expect(found.length, `the sheet has no rule for ${sel}`).toBeGreaterThan(0);
  return found.map(r => r.body).join("\n");
};
const reactFlowRule = (sel: string) => {
  const m = new RegExp(`(?:^|\\})\\s*${sel.replace(/[.]/g, "\\.")}\\s*\\{([^}]*)\\}`).exec(reactFlowCss);
  expect(m, `React Flow's sheet has no rule for ${sel}`).toBeTruthy();
  return m![1];
};

/** The markup from the `<div>` whose class list starts with `cls` to the
 *  `</div>` that closes it. */
function element(cls: string): string {
  const open = component.search(new RegExp(`<div className="${cls}[" ]`));
  if (open < 0) return "";
  let depth = 0;
  const tag = /<(\/?)div\b[^>]*?(\/?)>/g;
  tag.lastIndex = open;
  for (let m = tag.exec(component); m; m = tag.exec(component)) {
    if (m[2]) continue; // self-closing
    depth += m[1] ? -1 : 1;
    if (depth === 0) return component.slice(open, m.index + m[0].length);
  }
  throw new Error(`unbalanced <div> after className="${cls}…"`);
}

describe("why the pill could not be hit where it was", () => {
  it("React Flow stacks its renderer, pane and all, over its other children", () => {
    // A child of <ReactFlow> is rendered beside .react-flow__renderer, not in
    // it. The renderer is positioned with a z-index, so it is a stacking
    // context: nothing outside it can be drawn between its pane and its nodes.
    expect(declared(reactFlowRule(".react-flow__renderer"), "z-index")).toBe("4");
    expect(declared(reactFlowRule(".react-flow__pane"), "z-index")).toBe("1");
    expect(declared(reactFlowRule(".react-flow__viewport"), "z-index")).toBe("2");
  });

  it("so the box layer beside it, under it at 0, holds nothing a pointer is meant to reach", () => {
    expect(declared(rule(".session-clusters"), "z-index")).toBe("0");
    const boxes = element("session-clusters");
    expect(boxes, "the box layer is not in the component").not.toBe("");
    expect(boxes).toContain('className="cluster-card"');
    expect(boxes, "a pill in the box layer is under the pane again").not.toContain("<button");
    expect(boxes).not.toContain("onClick");
  });
});

describe("the pills are drawn in React Flow's viewport", () => {
  it("through a portal into the element that carries the camera", () => {
    expect(component).toMatch(/import \{ createPortal \} from "react-dom";/);
    expect(component).toMatch(/s\.domNode\?\.querySelector<HTMLElement>\("\.react-flow__viewport"\)/);
    expect(component).toMatch(/createPortal\(\s*<div className="cluster-labels nopan">/);
  });

  it("every pill, and nothing else, in a layer of their own", () => {
    const labels = element("cluster-labels");
    expect(labels, "the pill layer is not in the component").not.toBe("");
    expect(labels).toContain('className="cluster-label"');
    expect(labels).toContain("onClick={e => pressSession(e, c.sessionId)}");
    expect(labels).not.toContain("cluster-card");
  });

  it("with no camera of its own: the viewport's transform is already the camera", () => {
    // A second translate and scale here would apply the camera twice.
    const labels = element("cluster-labels");
    expect(labels.slice(0, labels.indexOf(">") + 1)).toBe('<div className="cluster-labels nopan">');
    const body = rule(".cluster-labels");
    for (const prop of ["transform", "will-change", "transition", "animation"])
      expect(declared(body, prop), prop).toBeUndefined();
  });
});

describe("over the pane, under the cards", () => {
  it("lets the empty canvas through and takes pointer events back on the pills alone", () => {
    expect(declared(rule(".cluster-labels"), "pointer-events")).toBe("none");
    expect(declared(rule(".cluster-label"), "pointer-events")).toBe("auto");
  });

  it("sits at the session drag handle's level, which is under every card", () => {
    // A card is drawn at React Flow's default z-index of 0 and the handle
    // behind a session's cards at -1. The layer is appended to the viewport
    // after React Flow's nodes, so at the same -1 it is drawn and hit above the
    // handle and below every card: a card a pill overlaps still takes its
    // click, and a pill over its own session's handle still takes its own.
    const [handle] = sessionGroupNodes([
      { id: "a", position: { x: 0, y: 0 }, width: 240, height: 130, data: { sessionId: "s1" } as AgentNodeData } as Node,
    ]);
    expect(handle.zIndex).toBe(-1);
    expect(declared(rule(".cluster-labels"), "z-index")).toBe(String(handle.zIndex));
    expect(declared(rule(".cluster-labels"), "position")).toBe("absolute");
  });

  it("is a button to React Flow's gestures, and a scroll over it still pans", () => {
    // React Flow's pan listens on the renderer, around the viewport, so a press
    // on a pill started one as well: a pointer that moved a pixel between
    // press and release panned instead of clicking, and a double-click's second
    // press stopped the camera on its way to the session and zoomed in where it
    // was. `nopan` on the layer is the opt-out its draggable cards carry, and it
    // covers every pill in it. `nowheel` would also stop a scroll over a pill
    // from panning, which it has always done: the canvas pans on scroll.
    expect(element("cluster-labels")).toMatch(/^<div className="cluster-labels nopan">/);
    expect(component).not.toMatch(/\bnowheel\b|\bnodrag\b/);
    expect(at("../components/BoardFlow.tsx")).toMatch(/^\s*panOnScroll$/m);
  });
});

describe("a double-click under reduced motion", () => {
  // Animated, the camera has barely begun to move when a double-click's second
  // press lands, so it lands on the same pill and frames the same session.
  // Under reduced motion the camera jumps on the first press instead, and the
  // second landed on whatever the jump put under the pointer: the empty canvas,
  // which zoomed in there, or another session's card, which it selected. A
  // pointer's press holds its jump for the length of a double-click, the way a
  // card's does (focus-hold.ts); a key's press, which has no second press to
  // wait for (`detail` is 0), goes at once, as Enter always has.
  it("holds a pointer press's jump and lets a key's go at once", () => {
    expect(component).toMatch(/import \{ createFocusHold \} from "\.\.\/focus-hold";/);
    expect(component).toMatch(/import \{ prefersReducedMotion \} from "\.\.\/viewport-motion";/);
    expect(component).toMatch(/const \[hold\] = useState\(\(\) => createFocusHold\(\{/);
    expect(component).toMatch(/useEffect\(\(\) => \(\) => hold\.cancel\(\), \[hold\]\);/);
    expect(component).toMatch(/if \(e\.detail > 0 && prefersReducedMotion\(\)\) hold\.hold\(sessionId\);\s*else focusSession\(sessionId\);/);
    expect(element("cluster-labels")).toContain("onClick={e => pressSession(e, c.sessionId)}");
  });

  it("is made before the layer can return nothing, so the hooks run on every render", () => {
    const early = component.indexOf("if (clusters.length <= 1) return null;");
    expect(early).toBeGreaterThan(0);
    for (const hook of ["const [hold] = useState(", "useEffect(() => () => hold.cancel()"]) {
      expect(component.indexOf(hook), hook).toBeGreaterThan(0);
      expect(component.indexOf(hook), hook).toBeLessThan(early);
    }
  });
});
