// #615: the drift watchdog measured the canvas by guessing at it.
//
// Every 1.5 seconds the deck asks whether any live card still puts a pixel on
// the canvas, and re-frames the graph when none do. It is the only recovery
// from a dagre reflow that pushes the whole board off screen — without it the
// user is left staring at an empty canvas with no clue that a button brings it
// back.
//
// The question is an intersection test between two rectangles. React Flow
// supplies one of them: `getViewport()` is the transform of the pane, so a node
// projected through it — `x * zoom + vp.x` — lands in coordinates measured from
// the top-left of `.canvas-wrap`. The other rectangle has to be the pane, and
// it was `window.innerWidth - 360` by `window.innerHeight - 52`: the whole
// window, less a detail panel assumed always open, less the topbar.
//
// `.app` is a six-way grid. The stylesheet is the source of truth and the first
// describe block below reads it, but in a 1600px window the table is:
//
//   layout                    columns              real pane   the guess
//   detail only               1fr 360px                 1240        1240  ✓
//   sessions + detail         240px 1fr 360px           1000        1240  +240
//   accounts + detail         288px 1fr 360px            952        1240  +288
//   neither panel             1fr                       1600        1240  −360
//   sessions only             240px 1fr                 1360        1240  −120
//   accounts only             288px 1fr                 1312        1240  −72
//
// One of six. And not the one the deck opens in: the accounts panel defaults to
// open and the detail panel defaults to closed, which is `288px 1fr`.
//
// Both directions of the error break something, and they break opposite things:
//
//   too WIDE (either left panel open beside the detail panel) — the check
//   credits the pane with 240-288px that belong to a panel, so a graph parked
//   just past the pane's real right edge is still "visible" and the failsafe
//   never fires. The one situation it exists for is the one it sleeps through.
//
//   too NARROW (every layout with the detail panel closed, the default among
//   them) — the last 72-360px of the pane are written off as off-screen, so
//   cards plainly on the canvas read as drifted and the next tick yanks the
//   viewport into a fit nobody asked for.
//
// This suite mounts nothing: there is no DOM, no React and no React Flow, so no
// test can watch a real canvas resize. What makes any of it reachable is that
// the decision is a pure function now — the pane is a parameter, so six layouts
// are six numbers, and each one can be asked twice, once with the truth and
// once with the guess, in the same assertion. What the pure half cannot see is
// whether App.tsx hands it the right rectangle; the source reading at the
// bottom is that half, and it pins the wiring rather than the behaviour.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isBoxOnPane, shouldRefit, type NodeBox, type PaneSize, type Viewport } from "../drift";

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

/** App.tsx with its comments stripped. The prose in this repo quotes the shapes
 *  it rejected by name, so "appears nowhere" has to be asked of code. */
const appCode = app
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");

/** The body of the watchdog's interval callback. */
const watchdog = (() => {
  const at = appCode.indexOf("const id = setInterval(");
  const end = appCode.indexOf("}, 1500);", at);
  return at < 0 || end < 0 ? "" : appCode.slice(at, end);
})();

/** The ResizeObserver effect that measures the canvas. */
const observer = (() => {
  const at = appCode.indexOf("new ResizeObserver(");
  const end = appCode.indexOf("ro.disconnect()", at);
  return at < 0 || end < 0 ? "" : appCode.slice(at, end);
})();

/**
 * Every `grid-template-columns` the stylesheet declares for `.app` itself.
 *
 * Selectors with a descendant part (`.app:not(:has(.detail)) .usage-panel`)
 * style something else and are skipped — only rules that lay out `.app` count.
 */
function appColumnRules(): string[] {
  const out: string[] = [];
  // Comments first: this sheet argues with itself in prose, and the arguments
  // quote selectors and declarations.
  const sheet = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = rule.exec(sheet))) {
    const selector = m[1].trim();
    const body = m[2];
    if (!selector.startsWith(".app")) continue;
    // A descendant or grouped selector styles something other than `.app`.
    if (/[\s,]/.test(selector)) continue;
    const cols = /grid-template-columns:\s*([^;]+);/.exec(body);
    if (cols) out.push(cols[1].trim());
  }
  return out;
}

/** The pixels a column track list gives away to panels — everything that is
 *  not the `1fr` the canvas takes. */
function panelPixels(columns: string): number {
  return columns.split(/\s+/)
    .map(t => /^(\d+(?:\.\d+)?)px$/.exec(t))
    .reduce((sum, px) => sum + (px ? Number(px[1]) : 0), 0);
}

const WINDOW_W = 1600;
const WINDOW_H = 900;
/** `grid-template-rows: 52px auto 1fr` — the topbar, pinned by the CSS test. */
const TOPBAR_H = 52;
/** What the connection and version banners occupy in row 2 when one is up.
 *  8px padding top and bottom around a 12px line: the exact number does not
 *  matter, only that row 2 is not always empty. */
const BANNER_H = 34;

/** The rectangle the check used to test against, in the same 1600x900 window. */
const GUESS: PaneSize = { width: WINDOW_W - 360, height: WINDOW_H - TOPBAR_H };

interface Layout {
  name: string;
  columns: string;
  /** Pixels taken by panels, so the pane is WINDOW_W minus this. */
  panels: number;
}

/** The six, in the order the stylesheet declares them. */
const LAYOUTS: Layout[] = [
  { name: "detail only", columns: "1fr 360px", panels: 360 },
  { name: "sessions + detail", columns: "240px 1fr 360px", panels: 600 },
  { name: "accounts + detail", columns: "288px 1fr 360px", panels: 648 },
  { name: "neither panel", columns: "1fr", panels: 0 },
  { name: "sessions only", columns: "240px 1fr", panels: 240 },
  { name: "accounts only (the deck's first run)", columns: "288px 1fr", panels: 288 },
];

const paneFor = (l: Layout): PaneSize => ({ width: WINDOW_W - l.panels, height: WINDOW_H - TOPBAR_H });

/** A viewport that is panned and zoomed, so nothing here passes by accident
 *  through an identity transform. */
const VP: Viewport = { x: -4000, y: -3000, zoom: 0.5 };

/**
 * A card whose projected box lands at (left, top) on the pane, sized in screen
 * pixels — the inverse of what `isBoxOnPane` does, so the flow-space numbers
 * that come out are the ones the layout would really have to produce.
 */
function cardAtScreen(left: number, top: number, screenW = 160, screenH = 90, vp: Viewport = VP): NodeBox {
  return {
    x: (left - vp.x) / vp.zoom,
    y: (top - vp.y) / vp.zoom,
    width: screenW / vp.zoom,
    height: screenH / vp.zoom,
  };
}

describe("the six layouts are still the six the stylesheet declares", () => {
  it("declares exactly the panel widths this suite tests against", () => {
    // If a panel is resized or a seventh layout is added, the table above is
    // stale and the numbers below stop describing this deck.
    const declared = appColumnRules().map(panelPixels).sort((a, b) => a - b);
    expect(declared).toEqual(LAYOUTS.map(l => l.panels).sort((a, b) => a - b));
  });

  it("puts the canvas in the third row, under a 52px topbar and a banner slot", () => {
    // The height half of the same bug: `innerHeight - 52` is the pane only
    // while row 2 is empty, and row 2 is where the banners live.
    expect(css).toMatch(/\.app\s*\{[^}]*grid-template-rows:\s*52px auto 1fr;/);
    expect(css).toMatch(/\.canvas-wrap\s*\{[^}]*grid-row:\s*3;/);
    expect(css).toMatch(/\.conn-banner\s*\{[^}]*grid-row:\s*2;/);
    expect(css).toMatch(/\.ver-banner\s*\{[^}]*grid-row:\s*2;/);
  });

  it("opens with the accounts panel and without the detail panel", () => {
    // Which is `288px 1fr` — a pane 72px wider than the guess believed, on
    // every deck that has never had its panels touched.
    expect(appCode).toMatch(/ACCOUNTS_PANEL_OPEN_KEY\);\s*return stored === null \? true : stored === "1";/);
    expect(appCode).toMatch(/function loadDetailOpen\(\): boolean \{[\s\S]*?return false;\s*\}/);
  });
});

describe("a graph past the pane's right edge is recovered in every layout", () => {
  for (const layout of LAYOUTS) {
    const pane = paneFor(layout);
    it(`${layout.name} (${layout.columns}): pane ${pane.width}px`, () => {
      // The only live card sits 20px past the real right edge of the pane —
      // behind the detail panel, off the canvas, invisible.
      const boxes = [cardAtScreen(pane.width + 20, 100)];
      expect(
        shouldRefit({ pane, viewport: VP, boxes }),
        `${layout.name}: nothing is on a ${pane.width}px pane, so the deck must go and fetch it`,
      ).toBe(true);
    });
  }

  it("is what the window guess got wrong wherever it ran too wide", () => {
    // 240-288px of detail panel counted as canvas, so the card above still
    // read as visible and the failsafe stayed asleep.
    const tooWide = LAYOUTS.filter(l => WINDOW_W - l.panels < GUESS.width);
    expect(tooWide.map(l => l.name)).toEqual(["sessions + detail", "accounts + detail"]);
    for (const layout of tooWide) {
      const pane = paneFor(layout);
      const boxes = [cardAtScreen(pane.width + 20, 100)];
      // The truth: nothing is on the canvas, so the deck goes and fetches it.
      expect(
        shouldRefit({ pane, viewport: VP, boxes }),
        `${layout.name}: a card at ${pane.width + 20}px is off a ${pane.width}px pane, ` +
        `and the failsafe exists to bring it back`,
      ).toBe(true);
      // The guess: it is behind the detail panel and counted as on screen.
      expect(
        shouldRefit({ pane: GUESS, viewport: VP, boxes }),
        `${layout.name}: a card off the ${pane.width}px pane must not read as visible ` +
        `because it fits inside a ${GUESS.width}px guess — that is the recovery never firing`,
      ).toBe(false);
    }
  });
});

describe("a card on the canvas is never mistaken for a drifted one", () => {
  for (const layout of LAYOUTS) {
    const pane = paneFor(layout);
    it(`${layout.name} (${layout.columns}): the strip at ${GUESS.width}px is canvas, not panel`, () => {
      // A card whose left edge is 10px past where the guess put the right edge.
      // In three layouts that is real canvas the user is looking at.
      const boxes = [cardAtScreen(GUESS.width + 10, 100)];
      const onPane = GUESS.width + 10 < pane.width;
      expect(
        shouldRefit({ pane, viewport: VP, boxes }),
        `${layout.name}: ${GUESS.width + 10}px into a ${pane.width}px pane is ` +
        `${onPane ? "canvas the user is looking at" : "past the right edge"}`,
      ).toBe(!onPane);
    });
  }

  it("is what the window guess got wrong wherever it ran too narrow", () => {
    // Including the layout the deck opens in. Every 1.5s tick where the cards
    // happened to sit in that strip was a fit the user did not ask for.
    const tooNarrow = LAYOUTS.filter(l => WINDOW_W - l.panels > GUESS.width);
    expect(tooNarrow.map(l => l.name)).toEqual([
      "neither panel", "sessions only", "accounts only (the deck's first run)",
    ]);
    for (const layout of tooNarrow) {
      const pane = paneFor(layout);
      const boxes = [cardAtScreen(GUESS.width + 10, 100)];
      // The truth: the card is on the canvas, so nothing should move.
      expect(
        shouldRefit({ pane, viewport: VP, boxes }),
        `${layout.name}: a card ${GUESS.width + 10}px into a ${pane.width}px pane is on screen, ` +
        `and the deck must leave the viewport where the user left it`,
      ).toBe(false);
      // The guess: the same card is "drifted", and the viewport gets yanked.
      expect(
        shouldRefit({ pane: GUESS, viewport: VP, boxes }),
        `${layout.name}: a card ${GUESS.width + 10}px into a ${pane.width}px pane is on screen, ` +
        `and a ${GUESS.width}px guess calling it drifted is a fit nobody asked for`,
      ).toBe(true);
    }
  });

  it("agrees with the guess in the one layout the guess described", () => {
    const pane = paneFor(LAYOUTS[0]);
    expect(pane).toEqual(GUESS);
    for (const left of [-400, -100, 0, 10, 600, 1230, 1239, 1240, 1300, 2000]) {
      const boxes = [cardAtScreen(left, 100)];
      expect(shouldRefit({ pane, viewport: VP, boxes }))
        .toBe(shouldRefit({ pane: GUESS, viewport: VP, boxes }));
    }
  });
});

describe("the height is the row the canvas is in, not the window under the topbar", () => {
  it("recovers a graph pushed below a pane shortened by a banner", () => {
    const pane: PaneSize = { width: WINDOW_W - 288, height: WINDOW_H - TOPBAR_H - BANNER_H };
    // Below the real bottom edge, above where the guess put it.
    const boxes = [cardAtScreen(200, pane.height + 8)];
    expect(shouldRefit({ pane, viewport: VP, boxes })).toBe(true);
    expect(
      shouldRefit({ pane: GUESS, viewport: VP, boxes }),
      "a banner in row 2 shortens the canvas, and `innerHeight - 52` does not know it",
    ).toBe(false);
  });
});

describe("the coordinate space is the pane's, and the projection is the viewport's", () => {
  const pane = paneFor(LAYOUTS[5]);

  it("counts a card the pan brought back onto the pane", () => {
    // Flow x of 8020 is nowhere near any pane, and at this viewport it is 10px
    // in from the left edge. Drop the translation or the zoom and this card
    // reads as drifted, which is a fit on every tick.
    const box: NodeBox = { x: 8020, y: 6200, width: 320, height: 180 };
    expect(box.x * VP.zoom + VP.x).toBe(10);
    expect(isBoxOnPane(box, VP, pane)).toBe(true);
    expect(shouldRefit({ pane, viewport: VP, boxes: [box] })).toBe(false);
    // The same box read as if flow space were pane space — the mistake the
    // projection exists to prevent.
    expect(shouldRefit({ pane, viewport: { x: 0, y: 0, zoom: 1 }, boxes: [box] })).toBe(true);
  });

  it("anchors the pane at its own top-left corner, not at its place in the window", () => {
    // With the accounts panel open the pane starts 288px into the window, and
    // none of that reaches here: a card 10px inside the pane is visible, and a
    // card 10px to the LEFT of it is not, whatever the window is doing.
    expect(isBoxOnPane(cardAtScreen(10, 10), VP, pane)).toBe(true);
    expect(isBoxOnPane(cardAtScreen(-170, 10), VP, pane)).toBe(false);
    expect(isBoxOnPane(cardAtScreen(10, -100), VP, pane)).toBe(false);
  });

  it("does not count a card whose edge merely touches the pane", () => {
    // A box ending exactly at x=0 occupies no pixel of the canvas.
    expect(isBoxOnPane(cardAtScreen(-160, 10), VP, pane)).toBe(false);
    expect(isBoxOnPane(cardAtScreen(-159, 10), VP, pane)).toBe(true);
    expect(isBoxOnPane(cardAtScreen(pane.width, 10), VP, pane)).toBe(false);
    expect(isBoxOnPane(cardAtScreen(pane.width - 1, 10), VP, pane)).toBe(true);
  });

  it("recovers a graph that drifted in any direction, in every layout", () => {
    for (const layout of LAYOUTS) {
      const p = paneFor(layout);
      for (const [left, top] of [[-900, 40], [40, -700], [p.width + 40, 40], [40, p.height + 40]]) {
        expect(
          shouldRefit({ pane: p, viewport: VP, boxes: [cardAtScreen(left, top)] }),
          `${layout.name}: a card at (${left}, ${top}) is off a ${p.width}x${p.height} pane`,
        ).toBe(true);
      }
    }
  });
});

describe("the watchdog declines to decide rather than guess", () => {
  const pane = paneFor(LAYOUTS[5]);
  const drifted = [cardAtScreen(-900, 40)];

  it("does nothing before the pane has been measured", () => {
    // A zero-sized rectangle intersects nothing, which is indistinguishable
    // from total drift — and would fit every 1.5 seconds, forever. The honest
    // answer between mount and the first ResizeObserver callback, and on a
    // browser with no ResizeObserver at all, is that the deck does not know
    // where its canvas is.
    expect(shouldRefit({ pane: null, viewport: VP, boxes: drifted })).toBe(false);
    expect(shouldRefit({ pane: { width: 0, height: 0 }, viewport: VP, boxes: drifted })).toBe(false);
    expect(shouldRefit({ pane: { width: 0, height: 848 }, viewport: VP, boxes: drifted })).toBe(false);
    expect(shouldRefit({ pane: { width: 1312, height: 0 }, viewport: VP, boxes: drifted })).toBe(false);
  });

  it("does nothing when the viewport is not a usable transform", () => {
    for (const zoom of [0, -1, NaN, Infinity]) {
      expect(shouldRefit({ pane, viewport: { x: 0, y: 0, zoom }, boxes: drifted })).toBe(false);
    }
    expect(shouldRefit({ pane, viewport: { x: NaN, y: 0, zoom: 1 }, boxes: drifted })).toBe(false);
    expect(shouldRefit({ pane, viewport: { x: 0, y: NaN, zoom: 1 }, boxes: drifted })).toBe(false);
  });

  it("does nothing when no live agent has been measured", () => {
    // Unchanged from before: an empty canvas, or one whose cards have not
    // reported a size yet, is not drift.
    expect(shouldRefit({ pane, viewport: VP, boxes: [] })).toBe(false);
  });

  it("leaves the viewport alone as soon as one card is on the pane", () => {
    expect(shouldRefit({
      pane,
      viewport: VP,
      boxes: [cardAtScreen(-900, 40), cardAtScreen(-900, 400), cardAtScreen(30, 30)],
    })).toBe(false);
  });
});

describe("App.tsx hands the rule the pane it measured", () => {
  it("asks the rule, and asks it about the measured pane", () => {
    expect(watchdog).toMatch(/shouldRefit\(\{\s*pane: paneSizeRef\.current/);
    expect(watchdog).toMatch(/viewport: rf\.getViewport\(\)/);
  });

  it("never sizes the canvas from the window again", () => {
    // The whole bug in one assertion. Neither the watchdog nor anything else
    // in this file may go back to measuring a grid column with `window.inner*`.
    expect(watchdog).not.toMatch(/window\.inner(Width|Height)/);
    expect(appCode).not.toMatch(/window\.inner(Width|Height)/);
  });

  it("starts that ref empty, so a tick before the first measurement decides nothing", () => {
    expect(appCode).toMatch(/const paneSizeRef = useRef<PaneSize \| null>\(null\);/);
  });

  it("fills that ref from the ResizeObserver on the canvas element", () => {
    // Same observer, same element, same callback as `canvasSize` — not a third
    // way of working out where the canvas is.
    expect(observer).toMatch(/paneSizeRef\.current = \{ width: r\.width, height: r\.height \}/);
    expect(observer).toMatch(/paneSizeRef\.current = \{ width: el\.clientWidth, height: el\.clientHeight \}/);
    expect(observer).toMatch(/ro\.observe\(el\)/);
  });

  it("keeps that reading unrounded, however the layout state is quantised", () => {
    // `canvasSize` ignores changes under 40px so a nudge of the window cannot
    // reflow the graph. An intersection test that inherited that tolerance
    // would call a 40px strip of live canvas off-screen — a smaller version of
    // the same bug.
    const quantised = observer.slice(observer.indexOf("setCanvasSize(prev"));
    expect(quantised).toMatch(/Math\.abs\(prev\.w - r\.width\) > 40/);
    expect(observer.slice(0, observer.indexOf("setCanvasSize(prev")))
      .toMatch(/paneSizeRef\.current = \{ width: r\.width/);
  });

  it("observes the element the canvas is drawn in", () => {
    expect(appCode).toMatch(/const el = canvasRef\.current;/);
    expect(appCode).toMatch(/className=\{`canvas-wrap\$\{[\s\S]*?ref=\{canvasRef\}/);
  });
});
