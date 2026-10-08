// A session's note answers the pointer the way its card does.
//
// The note beside a card on the canvas is dragged, clicked and double-clicked
// like the card, and it never visibly answered a pointer resting on it. At the
// full size it had no hover rule at all. Zoomed out, the tint written for every
// face (`.react-flow__node:hover .lod-face`) lost to the note face's own
// background, `.lod-face.recap-face`, which is the heavier selector, so the
// note stayed flat while the card beside it lit up. And the note's box declared
// `cursor: grab` on itself, which hid the closed hand React Flow puts on the
// node it is dragging: a dragged card showed `grabbing`, a dragged note kept
// the open hand.
//
// What a pointer gets now: the card's lift at the full size, and at every
// distance the card face's hover tint on the note's plate and the note's own
// edge (the session's hue) drawn firmer. A shadow is next to invisible on the
// dark canvas, so at the full size the tint is what says the note heard the
// pointer. Behind `(hover: hover)`, so a tap on a touch screen does not leave
// it lit. The hand stays an open hand at rest and closes during a drag, and
// nothing on the canvas promises a click with `cursor: pointer`, which this
// sheet keeps for controls that press (canvas-motion.test.ts).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { declared, el, mediaApplies, selects, sheetRules, splitTop, type El } from "./sheet-cascade";

const reactFlowCss = readFileSync(
  fileURLToPath(new URL("../../../node_modules/reactflow/dist/style.css", import.meta.url)), "utf8");

type Theme = "dark" | "light";
type Lod = "detail" | "compact" | "overview";
const THEMES: Theme[] = ["dark", "light"];
const DISTANCES: Lod[] = ["compact", "overview"];
const DESKTOP = 1440;

/** A mouse: the width queries a desktop window matches, and `(hover: hover)`. */
const mouse = (q: string | null) => q === "(hover: hover)" || mediaApplies(q, DESKTOP);
/** A touch screen: the same window, and no hover. */
const touch = (q: string | null) => mediaApplies(q, DESKTOP);

/** What the cascade gives `prop` on the chain's last element under `media`. */
function cascadeOn(chain: readonly El[], prop: string, media: (q: string | null) => boolean): string | null {
  let best: { spec: number; order: number; value: string } | null = null;
  for (const r of sheetRules()) {
    if (!media(r.media)) continue;
    const value = declared(r.body, prop);
    if (value == null) continue;
    for (const s of r.selectors) {
      const spec = selects(s, chain);
      if (spec == null) continue;
      if (!best || spec > best.spec || (spec === best.spec && r.order > best.order)) best = { spec, order: r.order, value };
    }
  }
  return best?.value ?? null;
}

/** The canvas down to a node's wrapper. A pointer on the note is on every
 *  element above it as well, so `hovered` puts the whole chain in `:hover`. */
function canvasTo(type: string, theme: Theme, lod: Lod, hovered: boolean, extra: string[] = []): El[] {
  const states = hovered ? ["hover"] : [];
  return [
    el("html", [], { attrs: { "data-theme": theme }, states: ["root", ...states] }),
    el("body", [], { states }),
    el("div", ["canvas-wrap"], { attrs: { "data-lod": lod }, states }),
    el("div", ["react-flow"], { states }),
    el("div", ["react-flow__renderer"], { states }),
    el("div", ["react-flow__viewport"], { states }),
    el("div", ["react-flow__nodes"], { states }),
    el("div", ["react-flow__node", `react-flow__node-${type}`, "nopan", ...extra], { states }),
  ];
}

const NOTE_KINDS: string[][] = [["recap-note"], ["recap-note", "is-status", "status-now"]];

function note(theme: Theme, lod: Lod, hovered: boolean, kind = NOTE_KINDS[0]): El[] {
  return [...canvasTo("recapNote", theme, lod, hovered), el("div", kind, { states: hovered ? ["hover"] : [] })];
}
function noteFace(theme: Theme, lod: Lod, hovered: boolean, kind = NOTE_KINDS[0]): El[] {
  return [...note(theme, lod, hovered, kind), el("div", ["lod-face", "recap-face"], { states: hovered ? ["hover"] : [] })];
}
function cardFace(theme: Theme, lod: Lod, hovered: boolean): El[] {
  const states = hovered ? ["hover"] : [];
  return [...canvasTo("agent", theme, lod, hovered), el("div", ["agent-node", "state-done"], { states }), el("div", ["lod-face"], { states })];
}
function card(theme: Theme, hovered: boolean): El[] {
  return [...canvasTo("agent", theme, "detail", hovered), el("div", ["agent-node", "state-done"], { states: hovered ? ["hover"] : [] })];
}

describe("a zoomed-out note under the pointer", () => {
  for (const theme of THEMES) for (const lod of DISTANCES) for (const kind of NOTE_KINDS) {
    const name = `${theme}, ${lod}, ${kind.join(".")}`;

    it(`takes the card's hover tint over its own resting plate (${name})`, () => {
      const rest = cascadeOn(noteFace(theme, lod, false, kind), "background", mouse);
      const hovered = cascadeOn(noteFace(theme, lod, true, kind), "background", mouse);
      expect(rest, "the face's resting plate").toBe("var(--panel)");
      expect(hovered, "the plate under the pointer").not.toBe(rest);
      expect(hovered).toBe(cascadeOn(cardFace(theme, lod, true), "background", mouse));
    });

    it(`draws its edge, the session's hue, firmer (${name})`, () => {
      const rest = cascadeOn(noteFace(theme, lod, false, kind), "--lod-edge", mouse);
      const hovered = cascadeOn(noteFace(theme, lod, true, kind), "--lod-edge", mouse);
      expect(hovered).not.toBe(rest);
      expect(hovered).toMatch(/var\(--accent\)/);
      expect(hovered, "orange is kept for a session waiting on you").not.toMatch(/--warn/);
    });

    it(`keeps the note's own box out of sight, lift and all (${name})`, () => {
      expect(cascadeOn(note(theme, lod, true, kind), "box-shadow", mouse)).toBe("none");
      expect(cascadeOn(note(theme, lod, true, kind), "border-color", mouse)).toBe("transparent");
    });

    it(`stays as it rests after a tap on a touch screen (${name})`, () => {
      for (const prop of ["background", "--lod-edge"])
        expect(cascadeOn(noteFace(theme, lod, true, kind), prop, touch), prop).toBe(cascadeOn(noteFace(theme, lod, false, kind), prop, touch));
    });
  }
});

describe("a full-size note under the pointer", () => {
  for (const theme of THEMES) for (const kind of NOTE_KINDS) {
    const name = `${theme}, ${kind.join(".")}`;

    it(`takes the card face's hover tint on its plate (${name})`, () => {
      const rest = cascadeOn(note(theme, "detail", false, kind), "background", mouse);
      const hovered = cascadeOn(note(theme, "detail", true, kind), "background", mouse);
      expect(rest, "the note's resting plate").toBe("var(--panel)");
      expect(hovered, "the plate under the pointer").not.toBe(rest);
      expect(hovered).toBe(cascadeOn(cardFace(theme, "compact", true), "background", mouse));
    });

    it(`lifts as the card lifts (${name})`, () => {
      expect(cascadeOn(note(theme, "detail", false, kind), "box-shadow", mouse)).toBe(cascadeOn(card(theme, false), "box-shadow", mouse));
      expect(cascadeOn(note(theme, "detail", true, kind), "box-shadow", mouse)).toBe(cascadeOn(card(theme, true), "box-shadow", mouse));
    });

    it(`draws its edge, the session's hue, firmer (${name})`, () => {
      const rest = cascadeOn(note(theme, "detail", false, kind), "border-color", mouse);
      const hovered = cascadeOn(note(theme, "detail", true, kind), "border-color", mouse);
      expect(hovered).not.toBe(rest);
      expect(hovered).toMatch(/var\(--accent\)/);
      expect(hovered, "orange is kept for a session waiting on you").not.toMatch(/--warn/);
    });

    it(`stays as it rests after a tap on a touch screen (${name})`, () => {
      for (const prop of ["background", "box-shadow", "border-color"])
        expect(cascadeOn(note(theme, "detail", true, kind), prop, touch), prop).toBe(cascadeOn(note(theme, "detail", false, kind), prop, touch));
    });
  }

  it("fades into the hover on what changes, and moves nothing", () => {
    const eased = (cascadeOn(note("dark", "detail", false), "transition", mouse) ?? "none");
    const props = splitTop(eased).map(p => p.split(/\s+/)[0]);
    expect(props).toEqual(expect.arrayContaining(["background-color", "border-color", "box-shadow"]));
    for (const moving of ["all", "transform", "translate", "scale", "top", "left", "margin", "width", "height"])
      expect(props, `the hover would carry the note through ${moving}`).not.toContain(moving);
  });

  it("is not selection: the hover draws no ring, which is selection's and the keyboard's", () => {
    for (const theme of THEMES) {
      expect(cascadeOn(note(theme, "detail", true), "outline", mouse), theme).toBeNull();
      for (const lod of DISTANCES) expect(cascadeOn(noteFace(theme, lod, true), "outline", mouse), `${theme} ${lod}`).toBeNull();
    }
  });
});

describe("the hand over a note", () => {
  it("is React Flow's: an open hand on a node, a closed one on the node being dragged", () => {
    const flat = reactFlowCss.replace(/\s+/g, " ");
    expect(flat).toMatch(/\.react-flow__node \{[^}]*cursor: grab;/);
    expect(flat).toMatch(/\.react-flow__node\.dragging \{[^}]*cursor: grabbing;/);
  });

  it("is not overridden on the note's box, its face or its lines, so a drag shows the closed hand", () => {
    for (const lod of ["detail", "compact"] as Lod[]) for (const dragging of [false, true]) {
      const wrapper = canvasTo("recapNote", "dark", lod, true, dragging ? ["dragging"] : []);
      const box = [...wrapper, el("div", ["recap-note"], { states: ["hover"] })];
      const where = `${lod}${dragging ? ", dragging" : ""}`;
      expect(cascadeOn(wrapper, "cursor", mouse), `the wrapper, ${where}`).toBeNull();
      expect(cascadeOn(box, "cursor", mouse), `.recap-note, ${where}`).toBeNull();
      for (const inner of [["recap-note-head"], ["recap-note-text"], ["recap-note-reply"], ["lod-face", "recap-face"]])
        expect(cascadeOn([...box, el("div", inner, { states: ["hover"] })], "cursor", mouse), `${inner.join(".")}, ${where}`).toBeNull();
    }
  });

  it("is never a pointer on any node, which would promise a click the canvas keeps for buttons", () => {
    const NODE = /\.react-flow__node(?:-[\w]+)?(?![\w-])/;
    const offenders = sheetRules()
      .filter(r => declared(r.body, "cursor") === "pointer")
      .flatMap(r => r.selectors.filter(s => NODE.test(s)));
    expect(offenders).toEqual([]);
  });
});
