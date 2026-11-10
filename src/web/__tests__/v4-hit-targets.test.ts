// Every control a pointer presses has a target of at least 24 x 24 CSS px
// (WCAG 2.5.8), and none of them changes how it looks to get it.
//
// Measured on the live deck at 1440 x 900, nine controls had a box under 24.
// Five of them already drew a larger target round the box with an invisible
// pseudo-element, which a box measurement does not see; four did not. Each
// now has one: `position: relative` on the control and an `::after` with no
// paint, sized by insets or centred at a fixed size. The two on the canvas
// are drawn at the canvas's zoom, so theirs grows by 1 / --zoom and stays 24
// on screen at every zoom they are drawn at.
//
// Plain node, no layout engine: this reads the sheet and pins the rules that
// make the targets, the way touch-targets-884.test.ts pins the switch's.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sheetText } from "./sheet-source";

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");

/** The sheet without any `@media` block in it: what applies to every pointer. */
function withoutMedia(src: string): string {
  let out = "", i = 0;
  while (i < src.length) {
    const at = src.indexOf("@media", i);
    if (at < 0) { out += src.slice(i); break; }
    out += src.slice(i, at);
    let depth = 0, j = src.indexOf("{", at);
    for (; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}" && --depth === 0) break;
    }
    i = j + 1;
  }
  return out;
}

const RULES = [...withoutMedia(strip(sheetText())).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m, at) => ({
  at,
  sels: m[1].split(",").map(s => s.trim().replace(/\s+/g, " ")).filter(Boolean),
  body: m[2],
}));

/** The declarations every top-level rule naming `sel` gives it, the later winning. */
function decls(sel: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of RULES.filter(r => r.sels.includes(sel))) {
    for (const d of r.body.matchAll(/([\w-]+)\s*:\s*([^;]+?)\s*(?:;|$)/g)) out[d[1]] = d[2].replace(/\s+/g, " ");
  }
  return out;
}
const firstRule = (sel: string) => RULES.findIndex(r => r.sels.includes(sel));

/** The px of one `inset` side, as a positive reach outward ("-4px" is 4). */
const reach = (v: string) => {
  const m = /^(-?\d+(?:\.\d+)?)px$|^0$/.exec(v);
  if (!m) throw new Error(`not a plain inset: ${v}`);
  return m[1] ? -Number(m[1]) : 0;
};
/** `inset: a`, `inset: a b` or `inset: a b c d` as [top, right, bottom, left]. */
function insets(v: string): [number, number, number, number] {
  const p = v.split(" ").map(reach);
  if (p.length === 1) return [p[0], p[0], p[0], p[0]];
  if (p.length === 2) return [p[0], p[1], p[0], p[1]];
  if (p.length === 4) return [p[0], p[1], p[2], p[3]];
  throw new Error(`unexpected inset: ${v}`);
}

// The controls whose target is the box pushed out by a fixed inset. `box` is
// the size measured on the live deck (w x h); the target is the box plus the
// inset on each side, and both sides must come to 24 or more.
const INSET: { control: string; target: string; box: [number, number]; inset: string }[] = [
  // .ap-telemetry, the telemetry mark in an account's row: 12 x 12 -> 24 x 24.
  { control: ".ap-marks .ap-more.ap-telemetry", target: ".ap-marks .ap-more.ap-telemetry::after", box: [12, 12], inset: "-6px" },
  // The version at the right end of the status bar: 54 x 16 -> 54 x 24, the
  // Compact bar's whole height.
  { control: ".statusbar-version", target: ".statusbar-version::after", box: [54, 16], inset: "-4px 0" },
  // Resume in the board's "Auto-fit off" chip: 45 x 16 -> 53 x 24, the chip's
  // outer edge.
  { control: ".autofit-resume", target: ".autofit-resume::after", box: [45, 16], inset: "-4px -4px" },
  // The Inspector's tabs (Agents, Time, Context): ~70 x 20 -> ~72 x 24, the
  // pill's outer edge; 1px each side meets the next tab's in their 2px gap.
  { control: ".insp-tab", target: ".insp-tab::after", box: [70, 20], inset: "-2px -1px" },
  // The accounts panel's Claude | Codex sides: 48 x 20 -> 48 x 24, the group's
  // outer edge; not wider, because the two sides touch.
  { control: ".ap-side", target: ".ap-side::after", box: [48, 20], inset: "-2px 0" },
];

// The controls whose target is a box of its own, centred on the control.
const CENTRED: { control: string; target: string; width: string; height: string; why: string }[] = [
  // The "runs out in 1h 24m" / "11% over pace" notes on the quota bars:
  // ~98 x 16 -> ~98 x 24.
  { control: "button.qb-pace", target: "button.qb-pace::after", width: "max(100%, 24px)", height: "24px", why: "quota pace note" },
  // V4's switch: a 32 x 18 track -> 32 x 24.
  { control: ".switch", target: ".switch::after", width: "max(100%, 24px)", height: "24px", why: "switch" },
  // The context ring on a root card: 26 x 26 in the card, 23 x 23 on screen at
  // zoom 0.88 -> 24 x 24 on screen at every zoom down to 0.6, where the card
  // gives way to its face; 26 x 26 at 1 and above.
  { control: ".ctx-donut", target: ".ctx-donut::after", width: "max(100%, calc(24px / var(--zoom, 1)))", height: "max(100%, calc(24px / var(--zoom, 1)))", why: "context donut" },
  // A recap note's close, a `.glyph-btn`: 24 x 24 in the note, 21 x 21 on
  // screen at 0.88. `.glyph-btn`'s own 28 x 32 target, which grows to 24 on
  // screen at any zoom the note is drawn at.
  { control: ".recap-note-close", target: ".recap-note-close::after", width: "max(calc(100% + 4px), calc(24px / var(--zoom, 1)))", height: "max(calc(100% + 8px), calc(24px / var(--zoom, 1)))", why: "recap note close" },
];

describe("every pressable control has a 24 x 24 target (WCAG 2.5.8)", () => {
  it.each(INSET)("$control: an invisible ::after at inset $inset", ({ control, target, box, inset }) => {
    const pseudo = decls(target);
    expect(pseudo["content"], target).toBe('""');
    expect(pseudo["position"], target).toBe("absolute");
    expect(pseudo["inset"], target).toBe(inset);
    // Nothing painted: the target is a place to press, not a shape.
    expect(pseudo["background"], target).toBeUndefined();
    expect(pseudo["border"], target).toBeUndefined();
    // Anchored to its own control.
    expect(decls(control)["position"], control).toBe("relative");
    const [top, right, bottom, left] = insets(inset);
    expect(box[0] + left + right, `${control} width`).toBeGreaterThanOrEqual(24);
    expect(box[1] + top + bottom, `${control} height`).toBeGreaterThanOrEqual(24);
  });

  it.each(CENTRED)("$control: an invisible ::after centred on it ($why)", ({ control, target, width, height }) => {
    const pseudo = decls(target);
    expect(pseudo["content"] ?? decls(".glyph-btn::after")["content"], target).toBe('""');
    expect(pseudo["position"] ?? decls(".glyph-btn::after")["position"], target).toBe("absolute");
    expect(pseudo["top"], target).toBe("50%");
    expect(pseudo["left"], target).toBe("50%");
    expect(pseudo["transform"], target).toBe("translate(-50%, -50%)");
    expect(pseudo["width"], target).toBe(width);
    expect(pseudo["height"], target).toBe(height);
    expect(pseudo["background"], target).toBeUndefined();
    expect(decls(control)["position"] ?? decls(":where(.glyph-btn)")["position"], control).toBe("relative");
  });

  it("lets the recap note's close replace .glyph-btn's inset, which it ties with on specificity", () => {
    // Same specificity, so the later rule wins: the note's must come after.
    expect(firstRule(".glyph-btn::after")).toBeGreaterThan(-1);
    expect(firstRule(".recap-note-close::after")).toBeGreaterThan(firstRule(".glyph-btn::after"));
    expect(decls(".recap-note-close::after")["inset"]).toBe("auto");
  });

  it("keeps the canvas controls' targets at 24 on screen: 24px / zoom is 24 x zoom on screen", () => {
    // The two canvas targets are drawn at the canvas's zoom. At 0.6, the lowest
    // zoom the full card and the note are drawn at, 24 / 0.6 = 40px in the
    // card is 24 on screen; at 0.88 it is 27.3px, 24 on screen.
    for (const zoom of [0.6, 0.75, 0.88, 1]) {
      expect(Math.max(26, 24 / zoom) * zoom, `donut at ${zoom}`).toBeGreaterThanOrEqual(24 - 1e-9);
      expect(Math.max(24 + 4, 24 / zoom) * zoom, `close width at ${zoom}`).toBeGreaterThanOrEqual(24 - 1e-9);
      expect(Math.max(24 + 8, 24 / zoom) * zoom, `close height at ${zoom}`).toBeGreaterThanOrEqual(24 - 1e-9);
    }
  });

  it("keeps the status bar's target where its own test reads it and without motion", () => {
    // v4-status-bar.test.ts reads the rules before the first @media, and the
    // bar's sheet moves nothing.
    const bar = strip(readFileSync(fileURLToPath(new URL("../styles/status-bar.css", import.meta.url)), "utf8"));
    const head = bar.slice(0, bar.indexOf("@media"));
    expect(head).toMatch(/\.statusbar-version::after\s*\{[^}]*inset:\s*-4px 0/);
    expect(bar).not.toMatch(/\b(transition|animation|transform)\s*:/);
  });
});
