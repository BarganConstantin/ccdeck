// The rail's header, usage meter and row motion as V4's Figma and V4's motion
// spec have them: the meter's box, bar and parts, the split rule, the figure's
// levels, the header's two 24 buttons and the Plus, the decision label and
// outcome corner, the meter motion, and the rows joining and leaving.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COUNT_MS } from "../count-up";
import { railSegments } from "../rail-usage";
import { quotaLevel } from "../components/QuotaBar";
import { JUMP_UNDER, movesBetween } from "../components/FadeFigure";
import { RAIL_CROSSFADE_AT, RAIL_LONG_LIST, joinMotion, releaseMotion } from "../rail-model";
import { LEAVE_SPACE_DELAY_MS, leaveHoldMs } from "../rail-motion";
import { sheetRules } from "./sheet-cascade";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const source = (p: string) => readFileSync(here(p), "utf8");
const rules = sheetRules();
function decl(selector: string, prop: string, media: string | null = null): string | undefined {
  let found: string | undefined;
  for (const r of rules) {
    if (r.media !== media || !r.selectors.includes(selector)) continue;
    const m = [...r.body.matchAll(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`, "g"))].at(-1);
    if (m) found = m[1].trim();
  }
  return found;
}
const tokens = source("../styles/tokens.css");
const token = (name: string) => new RegExp(`${name}:\\s*(\\d+)ms`).exec(tokens)?.[1];

describe("the meter's box and bar (V4's Figma)", () => {
  it("is a panel's round, padded 8 and 12, 4 between lines; the foot gives back the list's 1px border", () => {
    // CHANGED ON PURPOSE (owner 2026-11-10 critique: type scale 11/12/13/16/22, radii 4/8/pill): the box is a panel at 8, not V4's 9.
    expect(decl(".session-list .sl-usage-btn", "border-radius")).toBe("var(--r-panel)");
    expect(decl(".session-list .sl-usage-btn", "padding")).toBe("8px 12px");
    expect(decl(".session-list .sl-usage-btn", "gap")).toBe("4px");
    expect(decl(".session-list .sl-usage", "padding")).toBe("4px");
    expect(decl(".session-list .sl-usage", "margin-right")).toBe("-1px");
    // 8 + 17 + 4 + 4 + 4 + 16 + 8 = 61
    expect(decl(".session-list .sl-usage-line1", "height")).toBe("17px");
  });
  it("draws the bar 4 tall on --line-soft, parts 2 apart, the track in --line taking the rest, at least 1px", () => {
    expect(decl(".session-list .sl-usage-bar", "height")).toBe("4px");
    expect(decl(".session-list .sl-usage-bar", "gap")).toBe("2px");
    expect(decl(".session-list .sl-usage-bar", "border-radius")).toBe("var(--r-tag)");
    expect(decl(".session-list .sl-usage-bar", "overflow")).toBe("hidden");
    expect(decl(".session-list .sl-usage-bar", "background")).toBe("var(--line-soft)");
    expect(decl(".session-list .sl-usage-fill", "gap")).toBe("2px");
    expect(decl(".session-list .sl-usage-track", "background")).toBe("var(--line)");
    expect(decl(".session-list .sl-usage-track", "min-width")).toBe("1px");
  });
  // CHANGED ON PURPOSE (V4 top-10 #9): five data colours for the parts → no
  // part colour of its own, because colour on this meter now says the level only.
  it("names no part colour: every part is drawn in the meter's one fill colour", () => {
    const parts = source("../components/RailParts.tsx");
    expect(parts).toMatch(/className="sl-usage-seg" style=\{\{ flexGrow: seg\.share, background: meter\.color \}\}/);
    expect(source("../rail-usage.ts")).not.toMatch(/SEGMENT_TOKENS|--usage-(?:cyan|indigo|lime|pink|orange)/);
  });
});

describe("the split", () => {
  // CHANGED ON PURPOSE (V4 top-10 #9): one cyan part → one part, with no
  // colour of its own, because the fill's colour is the reading's level.
  it("is one part without an honest split", () => {
    expect(railSegments()).toEqual([{ share: 1 }]);
    expect(railSegments([])).toEqual([{ share: 1 }]);
    expect(railSegments([5])).toEqual([{ share: 1 }]);
  });
  it("goes largest first, in order, and the fifth is everything left", () => {
    const parts = railSegments([1, 8, 2, 4, 3, 1]);
    expect(parts).toHaveLength(5);
    expect(parts.map(p => p.share * 19)).toEqual([8, 4, 3, 2, 2].map(n => expect.closeTo(n, 9)));
    expect(parts.reduce((a, p) => a + p.share, 0)).toBeCloseTo(1, 9);
  });
  it("draws as many parts as there are sessions up to four", () => {
    expect(railSegments([3, 1])).toEqual([{ share: 0.75 }, { share: 0.25 }]);
  });
});

describe("the figure's levels", () => {
  // CHANGED ON PURPOSE (V4 top-10 #9): quiet under 70, plain to 89, error from
  // 90 → the Usage panel's level (quotaLevel): plain under 70, the warning mark,
  // "high" and --warn from 70, --err from 90, because 86% read calm here and
  // "⚠ 86% · high" in the Usage panel.
  it("takes the Usage panel's level: plain under 70, the warning from 70, the error from 90", () => {
    expect([0, 69, 70, 89, 90, 100].map(p => quotaLevel(p))).toEqual([null, null, "warn", "warn", "err", "err"]);
    expect(decl(".session-list .sl-usage-btn[data-level=\"low\"] .sl-usage-pct", "color")).toBeUndefined();
    expect(decl(".session-list .sl-usage-btn[data-level=\"high\"] .sl-usage-pct", "color")).toBeUndefined();
    expect(decl(".session-list .sl-usage-pct", "color")).toBe("var(--text)");
    expect(decl(".session-list .level-mark > .sl-usage-pct", "color")).toBe("inherit");
  });
  // CHANGED ON PURPOSE (V4 top-10 #9): the fill had no level colour → the fill
  // is the level's (accent, --warn, --err), set inline from the meter, because
  // the same number has the same colour on every quota meter.
  it("colours the bar's fill from the meter, never from the sheet", () => {
    const parts = source("../components/RailParts.tsx");
    expect(parts).toMatch(/background: meter\.color/);
    expect(decl(".session-list .sl-usage-fill", "background")).toBeUndefined();
    expect(decl(".session-list .sl-usage-seg", "background")).toBeUndefined();
  });
});

describe("the header", () => {
  const list = source("../components/SessionList.tsx");
  it("is --pane-head-h tall, padded 0 6 0 12, with a --line-soft rule", () => {
    expect(decl(".session-list .sl-header", "height")).toBe("var(--pane-head-h)");
    expect(decl(".session-list .sl-header", "padding")).toBe("0 6px 0 12px");
    expect(decl(".session-list .sl-header", "border-bottom")).toBe("1px solid var(--line-soft)");
  });
  it("ends in 24 x 24 radius 6 buttons 2 apart, no fill", () => {
    expect(decl(".session-list .sl-header-end", "gap")).toBe("2px");
    expect(decl(".session-list .sl-icon-btn", "width")).toBe("24px");
    expect(decl(".session-list .sl-icon-btn", "height")).toBe("24px");
    // CHANGED ON PURPOSE (owner 2026-11-10 critique: type scale 11/12/13/16/22, radii 4/8/pill): an icon button is a control, at 4.
    expect(decl(".session-list .sl-icon-btn", "border-radius")).toBe("var(--r-ctl)");
    expect(decl(".session-list .sl-icon-btn", "background")).toBe("transparent");
  });
  it("wires the Plus to the Command Panel's own new-session launch, only where it exists", () => {
    expect(list).toMatch(/\{onNewSession && \(\s*<button[^>]*RAIL_NEW_SESSION_ID[^>]*onClick=\{e => onNewSession\(e\.currentTarget\)\}/);
    expect(source("../App.tsx")).toContain("onNewSession={inWorkspace && stage.enabled ? stage.newSessionFrom : undefined}");
  });
  it("invents no Group control", () => {
    expect(list).not.toMatch(/sl-group-btn|groupBy|toggleGroup/);
  });
  it("keeps the × for the phone drawer: 24 to see, 44 to press, header unchanged", () => {
    expect(decl(".session-list .sl-close", "display")).toBe("none");
    expect(decl(".session-list .sl-close", "display", "(max-width: 640px)")).toBe("inline-flex");
    // CHANGED ON PURPOSE (the owner's phone layout): 6 above the 24 and 14 below
    // it, so the 44 target is whole (10 above ran past the panel's top edge and
    // was cut off there); the header rises over the list so the target reaches
    // down over its first rows.
    expect(decl(".session-list .sl-icon-btn::after", "inset", "(max-width: 640px)")).toBe("-6px -10px -14px");
    expect((list.match(/className="sl-icon-btn sl-close"/g) ?? []).length).toBe(1);
  });
});

describe("the decision card", () => {
  const css = source("../components/decision/decision.css").replace(/\/\*[\s\S]*?\*\//g, "");
  it("keeps an unselected option's label --text after a pick", () => {
    expect(css).not.toMatch(/aria-checked="false"\]\s+\.dc-opt-label\s*\{[^}]*color/);
  });
  it("draws the outcome box with a panel's corner", () => {
    // CHANGED ON PURPOSE (owner 2026-11-10 critique: type scale 11/12/13/16/22, radii 4/8/pill): the box is a panel at 8, not V4's 9.
    expect(/\.dc-out \{[^}]*border-radius: var\(--r-panel\)/.test(css)).toBe(true);
  });
});

describe("the meter's motion (V4's motion spec)", () => {
  it("counts for as long as --dur-slow", () => {
    expect(String(COUNT_MS)).toBe(token("--dur-slow"));
  });
  it("jumps for a change under a point and for reduced motion, and moves otherwise", () => {
    expect(JUMP_UNDER).toBe(1);
    expect(movesBetween(50, 50.5, false)).toBe(false);
    expect(movesBetween(50, 52, false)).toBe(true);
    expect(movesBetween(50, 90, true)).toBe(false);
  });
  it("eases the fill on --dur-slow and the figure's tone on --dur-fast, with a jump and a reduced answer", () => {
    expect(decl(".session-list .sl-usage-fill", "transition")).toBe("width var(--dur-slow) var(--ease)");
    expect(decl(".session-list .sl-usage-fill[data-jump]", "transition")).toBe("none");
    expect(decl(".session-list .sl-usage-pct", "transition")).toBe("color var(--dur-fast) var(--ease)");
    expect(decl(".qb-fill[data-jump]", "transition")).toBe("none");
    expect(source("../styles/session-list.css")).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^@]*\.sl-usage-fill[^@]*\.sl-usage-pct/);
  });
  it("crossfades the figure on --dur-base with opacity alone", () => {
    const fade = source("../components/FadeFigure.tsx");
    expect(fade).toContain('tokenMs("--dur-base")');
    expect(fade).toMatch(/\[\{ opacity: 0 \}, \{ opacity: 1 \}\]/);
    expect(fade).toMatch(/\[\{ opacity: 1 \}, \{ opacity: 0 \}\]/);
    expect(source("../components/QuotaBar.tsx")).toContain("<FadeFigure");
  });
});

describe("rows joining and leaving", () => {
  it("opens a joining row's space and fades it in, closes a leaving one after its fade", () => {
    expect(decl(".session-list .sl-row-item", "grid-template-rows")).toBe("1fr");
    expect(decl(".session-list .sl-rows > .sl-row-item.leaving", "grid-template-rows")).toBe("0fr");
    expect(decl(".session-list .sl-rows > .sl-row-item.leaving", "opacity")).toBe("0");
    expect(LEAVE_SPACE_DELAY_MS).toBe(100);
    expect(leaveHoldMs(false)).toBeGreaterThan(leaveHoldMs(true));
  });
  it("joins at once over twenty rows and crossfades the list over twelve moving", () => {
    expect(RAIL_LONG_LIST).toBe(20);
    expect(RAIL_CROSSFADE_AT).toBe(12);
    expect(joinMotion({ rows: 21, reduced: false })).not.toBe("animate");
    expect(joinMotion({ rows: 5, reduced: true })).not.toBe("animate");
    expect(releaseMotion({ moved: 13, reduced: false })).toBe("crossfade");
    expect(releaseMotion({ moved: 12, reduced: false })).toBe("flip");
    expect(releaseMotion({ moved: 3, reduced: true })).toBe("fade-moved");
  });
});
