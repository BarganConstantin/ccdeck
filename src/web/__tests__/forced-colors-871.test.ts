// #871: nothing in the deck answered Windows High Contrast. A Contrast theme
// repaints every background colour as Canvas and drops background images and
// shadows, and much of the deck's state is exactly that: status dots, quota
// and machine meters, a switch's knob. Under forced colours they were painted
// over and gone. One `@media (forced-colors: active)` block now redraws them in
// the theme's own system colours, keeps the colour of marks whose colour is the
// information, and outlines each meter's track.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

const OPEN = "@media (forced-colors: active) {";
const start = css.indexOf(OPEN);
const [block, end] = (() => {
  let depth = 0;
  for (let i = start + OPEN.length - 1; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return [css.slice(start + OPEN.length, i), i];
  }
  return ["", -1];
})();
const outside = css.slice(0, start) + css.slice(end + 1);

const rules = [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({
  sels: m[1].split(",").map(s => s.trim().replace(/\s+/g, " ")).filter(Boolean),
  body: m[2],
}));
const bodyOf = (sel: string) => rules.filter(r => r.sels.includes(sel)).map(r => r.body).join("\n");
const background = (sel: string) => /background:\s*([A-Za-z]+)\s*;/.exec(bodyOf(sel))?.[1];
const opts = (sel: string) => /forced-color-adjust:\s*none/.test(bodyOf(sel));

const RESTING_WORDED = [
  ".topbar .status .pill.live::before",
  ".topbar .status .pill.paused::before",
  ".topbar .status .pill.dead::before",
  ".conn-banner .conn-dot",
  ".waiting-dot",
  ".ap-dot",
];
const RESTING = [".sl-dot::before", ".bw-dot", ".bw-mode-dot", ".bw-prof-dot"];
const LIVE = [".sl-dot.state-active::before", ".state-pill.state-active::before", ".bw-mode-dot.on", ".topbar .brand button.v .v-dot"];
const METERS = [".sysdetail .sd-fill", ".sysdetail .sd-core-fill", ".ctx-window-fill", ".session-summary .ss-tt-bar-fill"];
const OWN_COLOUR = [".qb-fill", ".ap-lane-fill", ".uh-bar-seg", ".uh-agent-seg", ".uh-model-bar-fill", ".uh-legend-dot", ".cost-bar .cb-seg"];
const TRACKS = [".qb-track", ".ap-lane-track", ".sd-track", ".sd-core", ".session-summary .ss-tt-bar", ".uh-model-bar", ".uh-agent-bar", ".cost-bar"];

describe("the deck under a Windows Contrast theme (#871)", () => {
  it("answers forced colours in exactly one block", () => {
    expect(start).toBeGreaterThan(-1);
    expect(css.split(OPEN).length - 1).toBe(1);
    expect(rules.length).toBeGreaterThan(5);
  });

  it("redraws every dot whose word carries the state in the text colour", () => {
    for (const sel of RESTING_WORDED) {
      expect(opts(sel), sel).toBe(true);
      expect(background(sel), sel).toBe("CanvasText");
    }
  });

  it("keeps live and resting apart: Highlight against GrayText", () => {
    for (const sel of RESTING) {
      expect(opts(sel), sel).toBe(true);
      expect(background(sel), sel).toBe("GrayText");
    }
    for (const sel of LIVE) {
      expect(opts(sel), sel).toBe(true);
      expect(background(sel), sel).toBe("Highlight");
    }
  });

  it("paints the sheet's own meters in Highlight, gradient included", () => {
    for (const sel of METERS) {
      expect(opts(sel), sel).toBe(true);
      expect(background(sel), sel).toBe("Highlight");
    }
  });

  it("leaves a mark its own colour where the colour is the information", () => {
    for (const sel of OWN_COLOUR) {
      expect(opts(sel), sel).toBe(true);
      expect(bodyOf(sel), sel).not.toMatch(/background/);
    }
  });

  it("outlines every meter's track, so the empty part is still a length", () => {
    for (const sel of TRACKS) expect(bodyOf(sel), sel).toMatch(/outline:\s*1px solid CanvasText/);
  });

  it("keeps a switch's state: the knob survives, and the track fills when it is on", () => {
    expect(background(".switch-knob")).toBe("CanvasText");
    expect(background(".switch:hover:not(:disabled) .switch-knob")).toBe("CanvasText");
    expect(opts(".switch-knob")).toBe(true);
    for (const on of [".switch[aria-checked=\"true\"]", ".switch[aria-checked=\"true\"]:hover:not(:disabled)", ".ver-banner .switch[aria-checked=\"true\"]"]) {
      expect(opts(on), on).toBe(true);
      expect(background(on), on).toBe("Highlight");
      expect(bodyOf(on), on).toMatch(/border-color:\s*Highlight/);
    }
    expect(background(".switch[aria-checked=\"true\"] .switch-knob")).toBe("HighlightText");
    expect(background(".switch[aria-checked=\"true\"]:hover:not(:disabled) .switch-knob")).toBe("HighlightText");
  });

  it("names only selectors the sheet already draws, and outranks nothing by force", () => {
    for (const r of rules) for (const sel of r.sels) expect(outside, sel).toContain(sel);
    expect(block).not.toMatch(/!important/);
  });
});
