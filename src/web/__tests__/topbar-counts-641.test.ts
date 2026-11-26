// From 641px to 1023px, while the version chip was up and a session waited,
// the top bar cut its own mark off, and then the waiting pill.
//
// The full bar's end group (the version chip, Board | Workspace and Search)
// never gives (#849), and the readout gives from the left, so the first thing
// it lost was the mark, then the name, then the waiting pill, the first of the
// three counts, while working and done stayed whole at the other end. Measured
// in headless Chromium on a deck with one session waiting, one working and
// one done, and "4.0.1 is ready" on the chip, the logo's left edge sat at
// -112.9px in English and -200.3 in Portuguese at 641 (-2.8 and -90.2 without
// the chip). The bar still cut it at 760 in English and at 840 in Portuguese,
// and again from 900, where Search widens to 200, to 960 in Portuguese.
//
// Now the counts give first, whole and from their end: done, then working,
// never the waiting pill. From 641 to 689 the name goes too while the chip is
// drawn. What is pinned here is both rules, where they hold, and the
// arithmetic that says the bar holds the mark, the name where it is drawn and
// the widest two-digit count beside the widest end group measured in the ten
// languages, at every width from 641 to 1023. The paddings, gaps and widths
// the sheet declares are read from it; a word's width is the browser's,
// measured.
import { describe, expect, it } from "vitest";
import { cascade, declared, el, mediaApplies, selects, sheetRules, type El, type SheetRule } from "./sheet-cascade";
import { sourceOf } from "./client-source";

/** The kit's small mark, drawn 19px wide at its 16px height (TopbarReadouts.tsx). */
const MARK_PX = 19;
/** The wordmark, "ccdeck" at 13/20 Semibold, measured 44.1. */
const NAME_PX = 45;
/** The widest count pill with two digits, measured: the waiting pill with
 *  "11 aguardando" (pt-BR) at 114.8, and "11 în așteptare" (ro) at 114.1.
 *  Working and done are narrower in every language at the same count. */
const PILL_PX = 115;
/** The widest words the chip has carried: "4.0.1 este gata" (PR #2613's
 *  Romanian) at 79.4 between the chip's paddings; today's "4.0.1 is ready"
 *  is 72. */
const CHIP_WORDS_PX = 80;
/** Board | Workspace at its widest, in Japanese, measured 196.0 (169.8 in
 *  English). Drawn only while the Command Panel is on; the budget assumes it. */
const VIEW_SWITCH_PX = 196;
/** Search under 900px: its glyph and its Kbd ("Shift ×2", the two Shift taps),
 *  measured 99.0; with the chord's "Ctrl+K" it was 85.8. From 900 the sheet
 *  declares its width. */
const SEARCH_COMPACT_PX = 99;

const bar = el("header", ["topbar"]);
const readout = el("div", ["readout"]);
const brand = el("div", ["brand"]);
const counts = [bar, readout, el("div", ["counts"])];
const tbEnd = [bar, el("div", ["tb-end"])];
const chip = [...tbEnd, el("span", ["chip-slot"]), el("span", ["v-group"]), el("button", ["v", "stale"])];
const search = [...tbEnd, el("div", ["actions"]), el("div", ["utility-run"]), el("button", ["rail-btn", "rail-btn-bar", "rail-btn-field"])];
const corner = [bar, el("div", ["tb-corner"])];

const px = (v: string | null | undefined): number => {
  if (v == null || v === "0") return 0;
  const m = /^(-?[\d.]+)px$/.exec(v);
  return m ? Number(m[1]) : NaN;
};
/** A shorthand's sides, top right bottom left, as the browser expands it. */
const sides = (v: string | null) => {
  const p = (v ?? "0").split(/\s+/).map(px);
  return [p[0], p[1] ?? p[0], p[2] ?? p[0], p[3] ?? p[1] ?? p[0]];
};
/** The cascade depends on a width only through which `@media` blocks hold
 *  there, so it is read once per set of them: every width from 641 to 1023 is
 *  checked, at the cost of the few sets the sheet has across them. */
const medias = [...new Set(sheetRules().map(r => r.media).filter((m): m is string => m != null))];
const setsAt = new Map<number, string>();
const setAt = (w: number) => {
  let s = setsAt.get(w);
  if (s == null) setsAt.set(w, s = medias.map(m => (mediaApplies(m, w) ? "1" : "0")).join(""));
  return s;
};
const read = new Map<string, string | null>();
const at = (chain: El[], prop: string, width: number) => {
  const key = `${chain.map(e => [e.tag, ...e.classes].join(".")).join(" ")}|${prop}|${setAt(width)}`;
  if (!read.has(key)) read.set(key, cascade(sel => selects(sel, chain), prop, width));
  return read.get(key) ?? null;
};
/** A token's value on :root, outside any media block. */
const rootToken = (name: string) =>
  sheetRules().filter(r => r.media == null && r.selectors.includes(":root")).map(r => declared(r.body, name)).find(v => v != null);
const resolve = (v: string | null) => (v === "var(--edge-w)" ? rootToken("--edge-w") ?? null : v);

const countRules = sheetRules().filter(r => r.selectors.includes(".topbar .readout .counts"));
const nameRules: SheetRule[] = sheetRules().filter(r => r.selectors.some(s => /\.brand h1$/.test(s) && s.includes(":has(")));

/** What the end group spends at `width` with the widest chip words, the widest
 *  view switch and Search as the sheet draws it there. */
function endAt(width: number): number {
  const gap = px(at(tbEnd, "gap", width));
  const chipPad = sides(at(chip, "padding", width));
  const chipW = chipPad[3] + px(at([...chip, el("span", ["v-icon"])], "width", width)) + px(at(chip, "gap", width)) + CHIP_WORDS_PX + chipPad[1];
  const declaredSearch = at(search, "width", width);
  const searchW = declaredSearch === "auto" ? SEARCH_COMPACT_PX : px(declaredSearch);
  for (const n of [gap, chipW, searchW]) expect(Number.isFinite(n), `the end group at ${width}px`).toBe(true);
  return chipW + gap + VIEW_SWITCH_PX + gap + searchW;
}

/** The readout's room at `width`: the bar less its paddings, its two gaps, the
 *  end group and Feedback's corner cell, which reaches over the end padding. */
function roomAt(width: number): number {
  const pad = sides(at([bar], "padding", width));
  const gap = px(at([bar], "gap", width));
  const cornerMargin = sides(at(corner, "margin", width));
  const cornerW = px(resolve(at(corner, "width", width)));
  for (const n of [gap, cornerW, ...pad, ...cornerMargin]) expect(Number.isFinite(n), `a length at ${width}px`).toBe(true);
  return width - pad[3] - gap - endAt(width) - gap - (cornerMargin[3] + cornerW + cornerMargin[1]) - pad[1];
}

/** What the readout needs at `width` for the mark, the name if it is drawn,
 *  and the widest count pill: the least the counts group can give. */
function needAt(width: number, name: boolean): number {
  const readoutGap = px(at([bar, readout], "gap", width));
  const brandGap = px(at([bar, readout, brand], "gap", width));
  return MARK_PX + (name ? brandGap + NAME_PX : 0) + readoutGap + PILL_PX;
}

const nameDrawnAt = (w: number) => !mediaApplies(nameRules[0].media, w);

describe("the counts from 641 to 1023px", () => {
  it("give whole pills from their end: they may shrink, wrap a pill they have no room for, and clip that line", () => {
    expect(countRules).toHaveLength(1);
    const [rule] = countRules;
    expect(declared(rule.body, "flex")).toBe("0 1 auto");
    expect(declared(rule.body, "flex-wrap")).toBe("wrap");
    // One line drawn: the group is as tall as a pill, so a wrapped pill is
    // never drawn in part.
    expect(declared(rule.body, "height")).toBe(at([...counts, el("span", ["count-pill", "count-working"])], "height", 700));
    // Clip, not hidden: a scroll container's least width is nothing, and the
    // group would then cut into the waiting pill. Clipped, its least is its
    // widest pill.
    expect(declared(rule.body, "overflow")).toBe("clip");
  });

  it("win over the counts' own rule, which comes later in the cascade, at every width it holds", () => {
    for (const w of [641, 700, 839, 900, 1023]) {
      expect(at(counts, "flex", w), `at ${w}px`).toBe("0 1 auto");
      expect(at(counts, "flex-wrap", w), `at ${w}px`).toBe("wrap");
      expect(at(counts, "overflow", w), `at ${w}px`).toBe("clip");
    }
  });

  it("hold from 641 to 1023 and nowhere else, so the phone and the wide bar draw what they drew", () => {
    const [rule] = countRules;
    for (const w of [641, 700, 760, 839, 840, 899, 900, 960, 1023]) expect(mediaApplies(rule.media, w), `at ${w}px`).toBe(true);
    for (const w of [320, 390, 480, 640, 1024, 1280, 1440]) {
      expect(mediaApplies(rule.media, w), `at ${w}px`).toBe(false);
      expect(at(counts, "flex", w), `at ${w}px`).toBe("none");
      expect(at(counts, "flex-wrap", w), `at ${w}px`).toBeNull();
    }
  });

  it("keep the waiting pill on the line that is drawn: it is the group's first pill", () => {
    const readouts = sourceOf("components/TopbarReadouts.tsx");
    const block = readouts.slice(readouts.indexOf('<div className="counts">'), readouts.indexOf("<StatusStrip"));
    expect(block.indexOf("<WaitingStat")).toBeGreaterThan(-1);
    expect(block.indexOf("<WaitingStat")).toBeLessThan(block.indexOf("<CountPill"));
  });
});

describe("the name from 641 to 689px while the version chip is drawn", () => {
  // CHANGED ON PURPOSE (two Shift taps in the field): the band ran to 679;
  // Search under 900 is 13 wider with "Shift ×2" in place of "Ctrl+K", and the
  // arithmetic below now needs the name gone to 689.
  it("goes in the same rule as under 390, and nowhere from 690 up", () => {
    expect(nameRules).toHaveLength(1);
    const [rule] = nameRules;
    for (const w of [641, 660, 679, 689]) expect(mediaApplies(rule.media, w), `at ${w}px`).toBe(true);
    for (const w of [690, 700, 760, 900, 1023, 1024, 1440]) expect(mediaApplies(rule.media, w), `at ${w}px`).toBe(false);
  });

  it("holds the mark, the name where it is drawn and the widest count whole at every width from 641 to 1023", () => {
    for (let w = 641; w <= 1023; w++) {
      expect(needAt(w, nameDrawnAt(w)), `at ${w}px`).toBeLessThanOrEqual(roomAt(w));
    }
  });

  it("starts at the first width of the full bar and ends no narrower than the width that needs it", () => {
    // The widest width at which the mark, the name and the widest count do not
    // fit beside the widest end group: the band has to reach it.
    let widest = 0;
    for (let w = 641; w <= 1023; w++) if (needAt(w, true) > roomAt(w)) widest = w;
    expect(widest, "a width the name has to leave").toBeGreaterThanOrEqual(641);
    expect(nameDrawnAt(widest), `the name at ${widest}px`).toBe(false);
    expect(nameDrawnAt(640), "the phone's bar at 640px").toBe(true);
  });
});
