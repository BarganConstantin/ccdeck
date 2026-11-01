// The stage's width in whole cells (DESIGN-UI decision 6, v3's stageGeometry).
//
// Run, not read: every case calls the function with a window the deck is
// really opened in — 1440×900 and 1024×768, the two the v3 shots were taken
// at, and 760 for the takeover — and checks the numbers v3 measured there
// (120 columns, a 1004px stage, a 436px navigator, 40 rows at 14px from the
// header). Soft detents are the product's change from v3's hard ones, so the
// magnetism gets its own sweep.
import { describe, it, expect } from "vitest";
import {
  ASSUMED_CELL,
  BAR_H,
  DETENTS,
  DETENT_PULL,
  HEAD_H,
  HEAD_H_MIN,
  INSET_X,
  MIN_COLS,
  NAV_MIN,
  NAV_MIN_RAIL,
  STAGE_COLS_KEY,
  colsAtX,
  colsRange,
  loadStageCols,
  saveStageCols,
  snapCols,
  stageGeometry,
  stageWidthFor,
  stepCols,
  type StageGeometryInput,
} from "../stage-geometry";

/** The body under the 52px topbar, for a window of `w` × `h`. */
const at = (w: number, h: number, over: Partial<StageGeometryInput> = {}): StageGeometryInput => ({
  appW: w, bodyH: h - 52, cellW: ASSUMED_CELL.w, cellH: ASSUMED_CELL.h,
  expanded: false, narrow: w < 1100, storedCols: null, ...over,
});

describe("the default stage at the windows v3 was shot in", () => {
  it("gives 1440×900 the 120 columns, 1004px stage and 436px navigator v3 measured", () => {
    const g = stageGeometry(at(1440, 900));
    expect(g).toMatchObject({ cols: 120, stageW: 1004, navW: 436, density: "tiles", takeover: false, headH: HEAD_H });
    // 848px of body less V4's 44px header and 32px bar is 772; 42 rows of 18
    // leave 16, so the grid starts 8px under the header.
    expect(g.rows, "rows at 1440×900").toBe(42);
    expect(g.termTop, "the grid's first row").toBe(8);
  });

  it("gives a 1024 window a rail beside 100 columns, under the same one-row header", () => {
    const g = stageGeometry(at(1024, 768));
    expect(g).toMatchObject({ cols: 100, density: "rail", takeover: false, headH: HEAD_H });
    expect(g.navW, "the rail keeps its 168px").toBeGreaterThanOrEqual(NAV_MIN_RAIL);
    expect(g.rows).toBe(Math.floor((768 - 52 - HEAD_H - BAR_H - 12) / ASSUMED_CELL.h));
  });

  it("takes the whole body when not even 80 columns fit beside a rail", () => {
    const g = stageGeometry(at(760, 700));
    expect(g.takeover).toBe(true);
    expect(g.stageW, "the stage is the body").toBe(760);
    expect(g.navW).toBe(0);
    expect(g.cols, "whole cells inside the insets").toBe(Math.floor((760 - INSET_X) / ASSUMED_CELL.w));
    expect(g.range, "a takeover has nowhere to drag to").toEqual({ min: g.cols, max: g.cols, detents: [] });
  });
});

describe("whole cells, always", () => {
  it("is exactly the cells plus the two insets, so there is no ragged gutter on the right", () => {
    for (const w of [1100, 1280, 1440, 1680, 1920, 2560]) {
      const g = stageGeometry(at(w, 900));
      expect(g.stageW, `${w}`).toBe(g.cols * ASSUMED_CELL.w + INSET_X);
      expect(g.stageW + g.navW, `${w}: the two halves fill the body`).toBe(w);
    }
  });

  it("quantises to the cell xterm measured, rounding a fractional cell up rather than clipping the last column", () => {
    const g = stageGeometry(at(1440, 900, { cellW: 7.8, cellH: 17 }));
    expect(g.stageW).toBe(Math.ceil(g.cols * 7.8) + INSET_X);
    expect(g.rows).toBe(Math.floor((848 - HEAD_H - BAR_H - 12) / 17));
    expect(stageWidthFor(100, 7.81)).toBe(Math.ceil(781) + INSET_X);
  });

  it("falls back to the assumed cell for a measurement that is not a size", () => {
    for (const bad of [0, -3, NaN, Infinity]) {
      expect(stageGeometry(at(1440, 900, { cellW: bad, cellH: bad })).cols, String(bad)).toBe(120);
    }
  });

  it("keeps the navigator at 320px whatever the reader drags to", () => {
    for (const w of [1100, 1280, 1440, 1920]) {
      const g = stageGeometry(at(w, 900, { storedCols: 400 }));
      expect(g.navW, `${w}`).toBeGreaterThanOrEqual(NAV_MIN);
    }
  });

  it("never asks for more than the room it is given, at any width, stored count or ⤢", () => {
    // The room is what use-stage.ts measured of the canvas; a stage wider
    // than that would be laid past the cell, under the right stripe. The
    // sheet caps the dock at its cell too (stage-shell.css), and this is the
    // half that keeps the columns honest about it: whole cells inside the
    // stage, the navigator never negative.
    for (let w = 0; w <= 3000; w += 7) {
      for (const storedCols of [null, 80, 112, 160, 500]) {
        for (const expanded of [false, true]) {
          const g = stageGeometry(at(w, 900, { storedCols, expanded }));
          const where = `${w}px, stored ${storedCols}, ${expanded ? "⤢" : "plain"}`;
          expect(g.stageW, where).toBeLessThanOrEqual(w);
          expect(g.navW, where).toBeGreaterThanOrEqual(0);
          expect(g.stageW + g.navW, where).toBe(w);
          if (w >= 20 * ASSUMED_CELL.w + INSET_X) expect(Math.ceil(g.cols * ASSUMED_CELL.w) + INSET_X, where).toBeLessThanOrEqual(w);
        }
      }
    }
  });

  it("never gives the grid fewer than five rows, however short the window", () => {
    expect(stageGeometry(at(1440, 200)).rows).toBe(5);
  });
});

describe("the rows fit above the keys bar as it is drawn", () => {
  // A 320px phone's takeover (540px of body, V4's one-row 44px header). The
  // first-run line wraps to a third line there, and the bar grows from 32px
  // to 51px for as long as it is said. The rows were fitted to the nominal
  // bar, so the bar covered some of the last one.
  const phone = { appW: 320, bodyH: 540, cellW: 8, cellH: 18, expanded: false, narrow: true, storedCols: null };

  it("gives the grid only the height left above a bar taller than 32px", () => {
    const plain = stageGeometry(phone);
    expect(plain.rows, "25 rows of 18 under a 32px bar").toBe(25);
    const g = stageGeometry({ ...phone, barH: 51 });
    const room = phone.bodyH - HEAD_H - 51;
    expect(g.termTop + g.rows * phone.cellH, "the last row ends above the bar's top").toBeLessThanOrEqual(room);
    expect(g.rows, "one row fewer while the line is said").toBe(24);
    // Every row that fits is given: one more would leave less than the
    // 12px kept between the grid and the two rules.
    expect((g.rows + 1) * phone.cellH + 12).toBeGreaterThan(room);
    expect(g.termTop, "centred in what is left, as before").toBe(Math.floor((room - g.rows * phone.cellH) / 2));
  });

  it("is the same geometry as before for a bar at its own 32px, given or not", () => {
    for (const [w, h] of [[1440, 900], [1024, 768], [760, 700], [390, 844], [320, 640]] as const) {
      expect(stageGeometry(at(w, h, { barH: BAR_H })), `${w}×${h}`).toEqual(stageGeometry(at(w, h)));
    }
  });

  it("never gives the grid the bar's own 32px, whatever height it is handed", () => {
    // A bar not drawn yet reads 0, and a measurement can be anything: the
    // bar is never less than its 32px, so the grid never gets that room.
    for (const bad of [0, 20, -5, NaN, Infinity]) {
      expect(stageGeometry({ ...phone, barH: bad }), String(bad)).toEqual(stageGeometry(phone));
    }
  });

  it("honours V4's 32px bar, and takes a fingertip's 36px as 36", () => {
    expect(BAR_H).toBe(32);
    const body = { ...phone, bodyH: 600 };
    const base = stageGeometry(body);
    expect(base.rows, "(600 - 44 - 32 - 12) / 18").toBe(Math.floor((600 - HEAD_H - 32 - 12) / 18));
    const touch = stageGeometry({ ...body, barH: 36 });
    expect(touch.termTop + touch.rows * 18, "ends above a 36px bar").toBeLessThanOrEqual(600 - HEAD_H - 36);
    expect(touch.rows).toBe(Math.floor((600 - HEAD_H - 36 - 12) / 18));
  });
});

describe("the rows fit below the header as it is drawn", () => {
  const body = { appW: 1440, bodyH: 848, cellW: 8, cellH: 18, expanded: false, narrow: false, storedCols: null };

  it("gives a measured 36px header (Compact) more rows than the 44px default for the same body", () => {
    expect(HEAD_H).toBe(44);
    expect(stageGeometry(body).headH).toBe(HEAD_H);
    expect(stageGeometry({ ...body, headH: 36 }).headH).toBe(36);
    // 606px of body: 530 left under a 44px header (28 rows), 538 under a 36px
    // one (29 rows) — the 8px Compact saves is a row here.
    const tight = { ...body, bodyH: 606 };
    expect(stageGeometry(tight).rows).toBe(28);
    expect(stageGeometry({ ...tight, headH: 36 }).rows).toBe(29);
  });

  it("uses the same header height in a narrow window as in a wide one", () => {
    for (const bodyH of [540, 700, 848]) {
      expect(stageGeometry({ ...body, appW: 900, narrow: true, bodyH }).headH).toBe(HEAD_H);
      expect(stageGeometry({ ...body, appW: 1440, narrow: false, bodyH }).headH).toBe(HEAD_H);
    }
  });

  it("fills the body: avail is bodyH less the header and the bar, and rows plus termTop sit inside it", () => {
    for (const [bodyH, headH, barH] of [[848, 44, 32], [848, 36, 32], [600, 44, 36], [540, 36, 51]] as const) {
      const g = stageGeometry({ ...body, bodyH, headH, barH });
      const avail = bodyH - headH - barH;
      expect(g.rows, `${bodyH}/${headH}/${barH}`).toBe(Math.floor((avail - 12) / 18));
      expect(g.termTop + g.rows * 18, `${bodyH}/${headH}/${barH}`).toBeLessThanOrEqual(avail);
      expect(g.termTop, `${bodyH}/${headH}/${barH}`).toBe(Math.max(6, Math.floor((avail - g.rows * 18) / 2)));
    }
  });

  it("falls back to HEAD_H for a header height that is not a size, and never goes below 0", () => {
    for (const bad of [0, -4, NaN, Infinity]) {
      expect(stageGeometry({ ...body, headH: bad }), String(bad)).toEqual(stageGeometry(body));
    }
  });

  it("never fits the rows to a header smaller than Compact's, a header not laid out yet", () => {
    expect(HEAD_H_MIN).toBe(36);
    for (const tiny of [1, 12, 35]) {
      const g = stageGeometry({ ...body, headH: tiny });
      expect(g.headH, String(tiny)).toBe(HEAD_H_MIN);
      expect(g, String(tiny)).toEqual(stageGeometry({ ...body, headH: HEAD_H_MIN }));
    }
  });
});

describe("soft detents", () => {
  const range = colsRange(1920, 8, NAV_MIN);

  it("pulls a width within three columns onto 80, 100, 120 or 160", () => {
    for (const d of DETENTS) {
      for (let off = -DETENT_PULL; off <= DETENT_PULL; off++) {
        expect(snapCols(d + off, range), `${d}${off >= 0 ? "+" : ""}${off}`).toBe(d);
      }
    }
  });

  it("leaves every other width where the reader put it, a whole column at a time", () => {
    expect(snapCols(112, range)).toBe(112);
    expect(snapCols(96, range)).toBe(96);
    expect(snapCols(104.4, range)).toBe(104);
    expect(snapCols(140, range)).toBe(140);
  });

  it("holds a wanted width inside what the window allows", () => {
    expect(snapCols(20, range)).toBe(MIN_COLS);
    expect(snapCols(999, range)).toBe(range.max);
    expect(snapCols(NaN, range)).toBe(MIN_COLS);
  });

  it("does not pull toward a detent the window cannot fit", () => {
    const small = colsRange(1440, 8, NAV_MIN);
    expect(small.detents).toEqual([80, 100, 120]);
    expect(snapCols(158, small)).toBe(small.max);
  });

  it("reads the column count off the divider's x, from the right edge in", () => {
    // The 1440 default: the divider at the navigator's 436px edge is 120 cols.
    expect(colsAtX(436, 1440, 8)).toBe(120);
    expect(snapCols(colsAtX(450, 1440, 8), colsRange(1440, 8, NAV_MIN))).toBe(120);
  });
});

describe("the remembered width", () => {
  it("is the reader's own column count when the window allows it", () => {
    expect(stageGeometry(at(1440, 900, { storedCols: 112 })).cols).toBe(112);
    expect(stageGeometry(at(1440, 900, { storedCols: 99 })).cols, "near a detent").toBe(100);
  });

  it("lands on the widest detent that fits when it was chosen on a bigger window", () => {
    expect(stageGeometry(at(1440, 900, { storedCols: 160 })).cols).toBe(120);
  });

  it("gives way to the ⤢ control, which takes everything the rail does not need", () => {
    const g = stageGeometry(at(1440, 900, { storedCols: 100, expanded: true }));
    expect(g.density).toBe("rail");
    expect(g.navW).toBeGreaterThanOrEqual(NAV_MIN_RAIL);
    expect(g.navW - NAV_MIN_RAIL, "less than one more column is left over").toBeLessThan(ASSUMED_CELL.w);
  });

  it("is kept as a column count in the agent-dag.* namespace", () => {
    expect(STAGE_COLS_KEY).toBe("agent-dag.terminal.cols");
    const store = new Map<string, string>();
    saveStageCols(112, (k, v) => store.set(k, v));
    expect(store.get(STAGE_COLS_KEY)).toBe("112");
    expect(loadStageCols(k => store.get(k) ?? null)).toBe(112);
  });

  it("forgets a stored value that is not a sane column count rather than sizing to it", () => {
    for (const raw of [null, "", "abc", "12.5", "-80", "9", "9999", "1e3"]) {
      expect(loadStageCols(() => raw), String(raw)).toBeNull();
    }
    const store = new Map<string, string>();
    saveStageCols(0, (k, v) => store.set(k, v));
    saveStageCols(80.5, (k, v) => store.set(k, v));
    expect(store.size, "nothing that is not a whole column count is written").toBe(0);
  });
});

describe("the divider's keyboard steps", () => {
  const range = colsRange(1920, 8, NAV_MIN);

  it("walks the detents with the arrows and runs to the ends with Home and End", () => {
    expect(range.detents).toEqual([80, 100, 120, 160]);
    expect(stepCols(100, "wider", range)).toBe(120);
    expect(stepCols(112, "wider", range)).toBe(120);
    expect(stepCols(120, "narrower", range)).toBe(100);
    expect(stepCols(112, "narrower", range)).toBe(100);
    expect(stepCols(160, "wider", range), "past the last detent is the range's end").toBe(range.max);
    expect(stepCols(80, "narrower", range)).toBe(MIN_COLS);
    expect(stepCols(112, "widest", range)).toBe(range.max);
    expect(stepCols(112, "narrowest", range)).toBe(range.min);
  });
});
