// The stage's open and close (stage-morph.ts): a window cut out of the canvas
// cell that grows from the clicked card into the stage's column and shrinks
// back, the name riding between them, and the board's fade on the fold's own
// frames.
import { describe, expect, it } from "vitest";
import { flipFrame, planFlip, easeOut, FLIP_OPEN_MS, FLIP_CLOSE_MS } from "../navigator-flip";
import {
  clipInset,
  columnSeed,
  COLUMN_SEED_INSET,
  lerpRect,
  localRect,
  morphFrame,
  MORPH_RADIUS,
  HEADER_LATE,
  type MorphPlan,
} from "../stage-morph";

// v3's 1440 × 900 window: a 1440 × 848 canvas cell, a 1004px stage on its right.
const W = 1440, H = 848;
const column = { x: W - 1004, y: 0, w: 1004, h: H };
const card = { x: 520, y: 180, w: 240, h: 92 };
const cardName = { x: 536, y: 190, w: 64, h: 15 };
const headerName = { x: W - 1004 + 24, y: 12, w: 80, h: 20 };

const opening: MorphPlan = { direction: "open", w: W, h: H, from: card, to: column, rider: { card: cardName, header: headerName } };
const closing: MorphPlan = { direction: "close", w: W, h: H, from: column, to: card, rider: { card: cardName, header: headerName } };

describe("the window", () => {
  it("is exactly the card on the first frame of an open, with the card's corner", () => {
    const f = morphFrame(opening, 0);
    expect(f.clip).toBe(clipInset(card, W, H, MORPH_RADIUS));
    expect(f.clip).toBe(`inset(180px ${W - 760}px ${H - 272}px 520px round 10px)`);
    expect(f.edge.opacity, "the window's edge is drawn in full as it leaves the card").toBe(1);
  });

  it("is exactly the column on its last, square, with no edge left", () => {
    const f = morphFrame(opening, 1);
    expect(f.clip).toBe(`inset(0px 0px 0px ${W - 1004}px round 0px)`);
    expect(f.edge.opacity).toBe(0);
  });

  it("runs the same way back on a close", () => {
    expect(morphFrame(closing, 0).clip).toBe(`inset(0px 0px 0px ${W - 1004}px round 0px)`);
    expect(morphFrame(closing, 1).clip).toBe(clipInset(card, W, H, MORPH_RADIUS));
    expect(morphFrame(closing, 0).edge.opacity, "no edge on the column it leaves").toBe(0);
    expect(morphFrame(closing, 1).edge.opacity, "nor on the card it lands in").toBe(0);
    expect(morphFrame(closing, 0.3).edge.opacity).toBeGreaterThan(0);
  });

  it("moves through every rect in between, never outside the two ends", () => {
    for (let e = 0; e <= 1; e += 0.125) {
      const r = lerpRect(card, column, e);
      expect(r.x).toBeGreaterThanOrEqual(Math.min(card.x, column.x));
      expect(r.x + r.w).toBeLessThanOrEqual(Math.max(card.x + card.w, column.x + column.w) + 1e-9);
      expect(morphFrame(opening, e).edge.rect).toEqual(r);
    }
  });
});

describe("what the window shows", () => {
  it("never shows an empty box nor a finished stage before it has arrived", () => {
    expect(morphFrame(opening, 0).content).toBe(0);
    expect(morphFrame(opening, 0.4).content).toBe(0);
    expect(morphFrame(opening, 0.6).content).toBeGreaterThan(0);
    expect(morphFrame(opening, 0.6).content).toBeLessThan(1);
    expect(morphFrame(opening, 0.85).content).toBe(1);
  });

  it("keeps the session in sight going home, then lets it go", () => {
    expect(morphFrame(closing, 0.3).content, "held until 0.30").toBe(1);
    expect(morphFrame(closing, 0.62).content, "gone by 0.62").toBe(0);
    expect(morphFrame(closing, 0.69).stage).toBe(1);
    expect(morphFrame(closing, 1).stage, "the window itself is gone on the last frame").toBe(0);
    expect(morphFrame(opening, 0.9).stage).toBe(1);
  });

  it("prints nothing under or beside the rider's landing until the handover", () => {
    // The content is whole by 0.85; the state line and the chip wait for the
    // rider, or the flying name prints over them.
    expect(morphFrame(opening, 0.85).content).toBe(1);
    expect(morphFrame(opening, 0.9)).toMatchObject({ late: 0, chip: 0 });
    expect(morphFrame(opening, HEADER_LATE).late).toBe(0);
    expect(morphFrame(opening, 0.99).late).toBeGreaterThan(0);
    expect(morphFrame(opening, 0.98).chip).toBe(0);
    expect(morphFrame(opening, 1)).toMatchObject({ late: 1, chip: 1 });
  });

  it("clears the rider's way the moment it sets off home", () => {
    expect(morphFrame(closing, 0)).toMatchObject({ late: 1, chip: 1 });
    expect(morphFrame(closing, 0.04)).toMatchObject({ late: 0, chip: 0 });
    expect(morphFrame(closing, 0.2).content, "while the session itself is still in sight").toBe(1);
  });

  it("keeps the rider inside the window the whole way, so the window never clips it", () => {
    for (const plan of [opening, closing]) {
      for (let i = 0; i <= 20; i++) {
        const e = i / 20;
        const f = morphFrame(plan, e);
        const [, x, y] = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(f.rider!.transform)!.map(Number);
        const win = lerpRect(plan.from, plan.to, e);
        expect(x, `${plan.direction} ${e}`).toBeGreaterThanOrEqual(win.x - 0.01);
        expect(y, `${plan.direction} ${e}`).toBeGreaterThanOrEqual(win.y - 0.01);
      }
    }
  });
});

describe("the board under it", () => {
  it("leaves on the fold's own frames, so a stage with no navigator beside it still fades it in step", () => {
    // The navigator's fold draws the board's fade when there is a navigator;
    // the morph draws it otherwise. Same curve, same frames.
    for (const [dir, plan, ms] of [["open", opening, FLIP_OPEN_MS], ["close", closing, FLIP_CLOSE_MS]] as const) {
      const fold = planFlip({ board: new Map(), nav: new Map(), direction: dir, reduced: false });
      for (let t = 0; t <= ms; t += 20) {
        const f = flipFrame(fold, t);
        expect(morphFrame(plan, easeOut(t / ms)).board, `${dir} at ${t}ms`).toBeCloseTo(f.board, 9);
      }
    }
  });

  it("is gone by halfway open, and back only in the close's second half", () => {
    expect(morphFrame(opening, 0).board).toBe(1);
    expect(morphFrame(opening, 0.5).board).toBe(0);
    expect(morphFrame(closing, 0.5).board).toBe(0);
    expect(morphFrame(closing, 1).board).toBe(1);
  });
});

describe("the rider", () => {
  it("starts on the card's name at the card's size and lands on the header's at its own", () => {
    const first = morphFrame(opening, 0).rider!;
    expect(first.transform).toBe(`translate(536px, 190px) scale(${15 / 20})`);
    const last = morphFrame(opening, 1).rider!;
    expect(last.transform).toBe(`translate(${headerName.x}px, 12px) scale(1)`);
    expect(last.opacity).toBe(1);
  });

  it("flies home on a close and fades as it lands", () => {
    expect(morphFrame(closing, 0).rider!.transform).toBe(`translate(${headerName.x}px, 12px) scale(1)`);
    const home = morphFrame(closing, 1).rider!;
    expect(home.transform).toBe(`translate(536px, 190px) scale(${15 / 20})`);
    expect(home.opacity).toBe(0);
    expect(morphFrame(closing, 0.7).rider!.opacity).toBe(1);
  });

  it("is not there for a stage that is no card's", () => {
    expect(morphFrame({ ...opening, rider: null }, 0.5).rider).toBeNull();
  });
});

describe("where a stage with no card grows from", () => {
  it("is inside its own column, a short grow rather than nothing", () => {
    const seed = columnSeed(column);
    expect(seed).toEqual({ x: column.x + COLUMN_SEED_INSET, y: COLUMN_SEED_INSET, w: 1004 - 48, h: H - 48 });
  });

  it("never turns inside out in a tiny column", () => {
    const seed = columnSeed({ x: 0, y: 0, w: 40, h: 40 });
    expect(seed.w).toBeGreaterThanOrEqual(0);
    expect(seed.h).toBeGreaterThanOrEqual(0);
  });

  it("measures page rects from the box the window is cut from", () => {
    expect(localRect({ x: 700, y: 300, w: 10, h: 20 }, { x: 288, y: 52 })).toEqual({ x: 412, y: 248, w: 10, h: 20 });
  });
});
