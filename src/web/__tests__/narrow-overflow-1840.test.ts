// #1840: two window widths still scrolled sideways by a few pixels.
//
// Measured in headless Chromium on a development build. From 641 to 647px with
// the Accounts panel open and a session selected, the desktop row was the
// panel's 288px, a 0px canvas and the detail panel's 360px: 648px, up to 7px
// wider than the window, the last topbar control partly off screen. And at
// 320px with nothing selected the one track was 326px, the topbar's own
// min-content: #1790 gave the narrow row `minmax(0, 1fr)` on a bare `.app`,
// and the rule that drops the detail column outweighs it whenever there is no
// detail panel to drop.
//
// So these ask the cascade (sheet-cascade.ts) for the `.app` template at every
// width the issue names, in every state of the row, and add up the least each
// track can be. The page fits when that sum does.
import { describe, it, expect } from "vitest";
import { cascade, splitTop } from "./sheet-cascade";

/** The two left panels' own widths. Since 2026-10-08 the left track is `auto`
 *  for either, sized to the left column, which is as wide as the panel in it
 *  (styles/left-column.css). */
const ACCOUNTS_PANEL = 288;
const SESSION_LIST = 288;
/** The detail panel's column on a desktop window. */
const DETAIL = 360;
/** The topbar's min-content, which holds a bare `1fr` it is ALONE in: an item
 *  spanning one flexible track is held at its content-based minimum, one
 *  spanning several of them, one flexible, has none. Measured in headless
 *  Chromium with nothing selected: the narrow bar (640px and under, #849) and
 *  the wide one. The topbar spans the whole row (`grid-column: 1 / -1`). */
const topbarMinContent = (width: number) => (width <= 640 ? 326 : 495);

type Left = "none" | "sessions" | "accounts";

/** `.app` with any run of `:has(.x)` / `:not(:has(.x))`, against what is in
 *  the row. Its weight, or null when it does not match. */
function appCompound(sel: string, left: Left, detail: boolean): number | null {
  const m = /^\.app((?::has\(\.[\w-]+\)|:not\(:has\(\.[\w-]+\)\))*)$/.exec(sel);
  if (!m) return null;
  const present = (cls: string) =>
    (cls === "session-list" && left === "sessions")
    || (cls === "accounts-panel" && left === "accounts")
    || (cls === "left-column" && left !== "none")
    || (cls === "detail" && detail);
  let spec = 10;
  for (const p of m[1].match(/:has\(\.[\w-]+\)|:not\(:has\(\.[\w-]+\)\)/g) ?? []) {
    const cls = /\.([\w-]+)/.exec(p)![1];
    if (present(cls) !== !p.startsWith(":not")) return null;
    spec += 10;
  }
  return spec;
}

/** How heavily `sel` selects `.app` itself, or `.detail` inside it. A selector
 *  whose subject is one of them in a form this cannot read fails the test. */
function matches(sel: string, subject: "app" | "detail", left: Left, detail: boolean): number | null {
  const parts = sel.split(/\s+/);
  const last = parts.at(-1)!;
  if (!/^\.(app|detail)(?![\w-])/.test(last)) return null;
  if (subject === "app") {
    if (parts.length > 1 || !last.startsWith(".app")) return null;
    const spec = appCompound(last, left, detail);
    if (spec == null && !/^\.app(:has|:not|$)/.test(last)) throw new Error(`unread selector: ${sel}`);
    return spec;
  }
  if (last !== ".detail") {
    if (last.startsWith(".detail")) throw new Error(`unread selector: ${sel}`);
    return null;
  }
  if (parts.length === 1) return 10;
  if (parts.length !== 2) throw new Error(`unread selector: ${sel}`);
  const anc = appCompound(parts[0], left, detail);
  return anc == null ? null : anc + 10;
}

/** `Npx` or a bare 0: every length a track here is written in. */
function px(v: string): number {
  const s = v.trim();
  if (s === "0") return 0;
  const m = /^(-?[\d.]+)px$/.exec(s);
  if (!m) throw new Error(`unread length: ${v}`);
  return +m[1];
}

interface Track { min: number; max: number; flex: boolean }

/** Each track's floor and ceiling, the way grid sizing reads them. */
function tracks(template: string, left: Left, width: number): Track[] {
  const list = splitTop(template.replace(/\s+(?![^(]*\))/g, ","));
  return list.map(t => {
    const mm = /^minmax\((.*)\)$/.exec(t);
    if (mm) {
      const [lo, hi] = splitTop(mm[1]);
      return /fr$/.test(hi) ? { min: px(lo), max: Infinity, flex: true } : { min: px(lo), max: px(hi), flex: false };
    }
    // A bare `1fr` is `minmax(auto, 1fr)`: the canvas in it has no minimum of
    // its own, and the topbar has one only where this is its only track.
    if (/fr$/.test(t)) return { min: list.length === 1 ? topbarMinContent(width) : 0, max: Infinity, flex: true };
    if (t === "auto") {
      expect(left, "an auto track with no left panel to size it").not.toBe("none");
      const column = left === "accounts" ? ACCOUNTS_PANEL : SESSION_LIST;
      return { min: column, max: column, flex: false };
    }
    return { min: px(t), max: px(t), flex: false };
  });
}

/** The row at `width`: its template, the least it can be, the size each track
 *  ends up (fixed ones grow to their ceilings first, the flexible share the
 *  rest), and whether the detail panel is in it or over it. */
function row(left: Left, detail: boolean, width: number) {
  const template = cascade(sel => matches(sel, "app", left, detail), "grid-template-columns", width)!;
  const position = detail ? cascade(sel => matches(sel, "detail", left, detail), "position", width) ?? "static" : "static";
  const ts = tracks(template, left, width);
  const least = ts.reduce((n, t) => n + t.min, 0);
  let free = Math.max(0, width - least);
  const sizes = ts.map(t => t.min);
  ts.forEach((t, i) => {
    if (t.flex) return;
    const grow = Math.min(free, t.max - t.min);
    sizes[i] += grow;
    free -= grow;
  });
  const flex = ts.filter(t => t.flex).length;
  ts.forEach((t, i) => { if (t.flex) sizes[i] += free / flex; });
  return { template, least, sizes, overlay: position === "fixed" || position === "absolute" };
}

const LEFTS: Left[] = ["none", "sessions", "accounts"];
const WIDTHS = [320, 480, 640, 641, 644, 647, 648, 900];
const label = (left: Left, detail: boolean) =>
  `${detail ? "a session selected" : "nothing selected"}${left === "none" ? "" : `, the ${left} panel open`}`;

describe("no sideways scroll at any width from 320px up (#1840)", () => {
  for (const width of WIDTHS) {
    for (const detail of [false, true]) {
      for (const left of LEFTS) {
        it(`fits a ${width}px window with ${label(left, detail)}`, () => {
          const r = row(left, detail, width);
          expect(r.least, `the least ${r.template} can be`).toBeLessThanOrEqual(width);
        });
      }
    }
  }

  it("keeps the detail panel a column just above the breakpoint, short only what the window lacks", () => {
    for (const width of [641, 644, 647, 648]) {
      const r = row("accounts", true, width);
      expect(r.overlay, `at ${width}px`).toBe(false);
      // Panel, canvas, detail: the detail column is the last track.
      expect(r.sizes.at(-1), `the detail column at ${width}px`).toBe(Math.min(DETAIL, width - ACCOUNTS_PANEL));
    }
  });

  it("leaves the desktop row alone from 648px up", () => {
    for (const width of [648, 900, 1280]) {
      expect(row("accounts", true, width).template).toBe("auto 1fr 360px");
      expect(row("accounts", false, width).template).toBe("auto 1fr");
      expect(row("none", false, width).template).toBe("1fr");
    }
  });
});
