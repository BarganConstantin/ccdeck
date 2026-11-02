// #1790: on a narrow or zoomed window, selecting a session took the canvas away.
//
// Opening the detail panel always added a fixed 360px column, whatever the
// window's width. Measured at 400px with the session list open: `240px 0px
// 360px`, a 600px page that scrolled sideways, the panel's × at x=588 and the
// last topbar button ending at 590. At 320px with the panel alone the page was
// 360px wide, and at 640px — a 1280px laptop at 200% — the Accounts panel and
// the detail column were 648px between them. #849 made the rails sheets at the
// sheet's 640px breakpoint and never touched this column.
//
// So these ask the cascade, not the text: which `.app` template and which
// `.detail` box actually apply at a given width, with every `@media` block
// honoured and specificity and source order deciding between rules, for each of
// the three things that can share the row with the panel.
import { describe, it, expect } from "vitest";
import { cascade, el, mediaApplies, selects, sheetRules, splitTop } from "./sheet-cascade";

/** The Accounts panel's own width: the `auto` track is sized to it. */
const ACCOUNTS_PANEL = 288;
/** The session list's own width: since 2026-10-08 its track is `auto` too,
 *  sized to the left column the list is drawn in (styles/left-column.css). */
const SESSION_LIST = 288;

/** A custom property's value at `width`, as the root declares it. */
const token = (name: string, width: number) => cascade(sel => selects(sel, [el("html", [], { states: ["root"] })]), name, width);

type Left = "none" | "sessions" | "accounts";

/** `:has(.x)` or `:has(.x, .y)`: it matches when any of its classes is there. */
const HAS = String.raw`:has\(\.[\w-]+(?:,\s*\.[\w-]+)*\)`;

/** `.app` with any run of `:has(...)` / `:not(:has(...))`, against what is open
 *  beside a selected session's panel. Its weight, or null when it does not match. */
function appCompound(sel: string, left: Left): number | null {
  const m = new RegExp(`^\\.app((?:${HAS}|:not\\(${HAS}\\))*)$`).exec(sel);
  if (!m) return null;
  const present = (cls: string) =>
    (cls === "session-list" && left === "sessions")
    || (cls === "accounts-panel" && left === "accounts")
    || (cls === "left-column" && left !== "none")
    || cls === "detail";
  let spec = 10;
  for (const p of m[1].match(new RegExp(`${HAS}|:not\\(${HAS}\\)`, "g")) ?? []) {
    const classes = [...p.matchAll(/\.([\w-]+)/g)].map(c => c[1]);
    if (classes.some(present) !== !p.startsWith(":not")) return null;
    spec += 10;
  }
  return spec;
}

/** `sel`'s compound selectors, split at the spaces between them and never at
 *  the one after a comma inside a `:has(...)` list. */
function compounds(sel: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of sel.trim()) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** How heavily `sel` selects the element, or null. Any selector whose subject
 *  is `.app` or `.detail` in a form this cannot read fails the test rather than
 *  being skipped, so a new kind of rule cannot slip past it. */
function matches(sel: string, subject: "app" | "detail", left: Left): number | null {
  // CHANGED ON PURPOSE: the phone corrections now apply under every strip
  // banner, `.app:has(.banner-mark, .rating-banner) .detail`, so the reader
  // reads a `:has()` list instead of failing on the space after its comma.
  // No banner is open in these cases, so that rule still never matches.
  const parts = compounds(sel);
  const last = parts.at(-1)!;
  if (!/^\.(app|detail)(?![\w-])/.test(last)) return null;
  if (subject === "app") {
    if (parts.length > 1 || !last.startsWith(".app")) return null;
    const spec = appCompound(last, left);
    if (spec == null && !/^\.app(:has|:not|$)/.test(last)) throw new Error(`unread selector: ${sel}`);
    return spec;
  }
  if (last !== ".detail") {
    // CHANGED ON PURPOSE (the phone layout): the sheet's leaving state is not
    // the open sheet the boxes below are asked of.
    if (last === ".detail.leaving") return null;
    if (last.startsWith(".detail")) throw new Error(`unread selector: ${sel}`);
    return null;
  }
  if (parts.length === 1) return 10;
  // CHANGED ON PURPOSE (the phone layout): the Inspector sheet's box is written
  // once, in phone-sheet.css, under the app's weight three times so that no
  // banner row's rule outranks it (three classes and one: 40, over the 30 of
  // `.app:has(...) .detail`). It used to be repeated in detail-panel.css.
  if (parts.length === 2 && parts[0] === ".app.app.app") return 40;
  if (parts.length !== 2) throw new Error(`unread selector: ${sel}`);
  const anc = appCompound(parts[0], left);
  return anc == null ? null : anc + 10;
}

/** The value the cascade gives `prop` on the element, or null. */
function resolve(subject: "app" | "detail", prop: string, left: Left, width: number): string | null {
  return cascade(sel => matches(sel, subject, left), prop, width);
}

/** `Npx`, `Nvw`, a bare 0, `min()` of them and a custom property the root
 *  declares — the topbar's height is one since the bar became 44px (tokens.css)
 *  — which is all a sheet's box needs here. */
function length(v: string, width: number): number {
  const s = v.trim();
  const min = /^min\((.*)\)$/.exec(s);
  if (min) return Math.min(...splitTop(min[1]).map(a => length(a, width)));
  const named = /^var\((--[\w-]+)\)$/.exec(s);
  if (named) {
    const value = token(named[1], width);
    if (value == null) throw new Error(`no value for ${named[1]} at ${width}px`);
    return length(value, width);
  }
  if (s === "0") return 0;
  // CHANGED ON PURPOSE (the owner's phone layout): the Inspector sheet is `100%`
  // of the window, which here is `vw`'s own arithmetic.
  const m = /^(-?[\d.]+)(px|vw|%)$/.exec(s);
  if (!m) throw new Error(`unread length: ${v}`);
  return m[2] === "px" ? +m[1] : (+m[1] * width) / 100;
}

/** How much of the row the fixed tracks take, `auto` being the Accounts panel. */
function fixedTracks(template: string, left: Left): number {
  return splitTop(template.replace(/\s+(?![^(]*\))/g, ",")).reduce((sum, t) => {
    if (/fr\)?$/.test(t)) return sum;
    if (t === "auto") {
      expect(left, "an auto track with no left panel to size it").not.toBe("none");
      return sum + (left === "accounts" ? ACCOUNTS_PANEL : SESSION_LIST);
    }
    return sum + length(t, 0);
  }, 0);
}

/** Where the selected session's panel is at `width`: in the grid, taking a
 *  track, or over the canvas as a box of its own. */
function layout(left: Left, width: number) {
  const template = resolve("app", "grid-template-columns", left, width)!;
  const position = resolve("detail", "position", left, width) ?? "static";
  const overlay = position === "fixed" || position === "absolute";
  return { template, position, overlay, canvas: width - fixedTracks(template, left) };
}

const LEFTS: Left[] = ["none", "sessions", "accounts"];

describe("a selected session on a narrow window (#1790)", () => {
  for (const width of [400, 320, 640]) {
    for (const left of LEFTS) {
      it(`leaves the canvas a share of a ${width}px window with ${left === "none" ? "the panel alone" : `the ${left} panel open`}`, () => {
        const l = layout(left, width);
        // Nothing in the row is wider than the window, so it never scrolls
        // sideways, and the canvas keeps at least a card's corner of it — a
        // tenth of the window, where it had 0px at every one of these widths.
        expect(l.canvas, `canvas track under ${l.template}`).toBeGreaterThanOrEqual(width / 10);
        expect(l.overlay, "the panel is still a grid column").toBe(true);
      });
    }

    // CHANGED ON PURPOSE (the owner's phone layout): the Inspector is a bottom
    // sheet at this width: the window's whole width, up from the dock, with its
    // height capped under the top bar (phone-sheet.css), not a panel pinned at
    // the right edge from the bar down.
    it(`puts the panel over the canvas at ${width}px as a sheet, inside the window and under the topbar`, () => {
      for (const left of LEFTS) {
        const right = length(resolve("detail", "right", left, width)!, width);
        const edge = length(resolve("detail", "left", left, width)!, width);
        const w = length(resolve("detail", "width", left, width)!, width);
        expect(right).toBeGreaterThanOrEqual(0);
        expect(edge).toBeGreaterThanOrEqual(0);
        // Its left edge, and the × pinned inside its right one, both on screen.
        expect(width - right - w).toBeGreaterThanOrEqual(0);
        expect(w).toBe(width);
        // Under the topbar: the sheet hangs from the dock, and what it may
        // take is the window less the grid's first row, the bar's own, read
        // from the same sheet (50 on the phone frame, from 44).
        const bar = length(splitTop(resolve("app", "grid-template-rows", left, width)!.replace(/\s+(?![^(]*\))/g, ","))[0], width);
        expect(bar).toBe(50);
        expect(resolve("detail", "top", left, width)).toBe("auto");
        expect(resolve("detail", "--sheet-room", left, width)).toContain("var(--topbar-h)");
      }
    });

    it(`ends the panel above the phone's dock at ${width}px, so its foot is not drawn under it`, () => {
      // Under 641px the controls stand in a dock along the bottom
      // (edge-rails.css), fixed over everything docked (z-index 25 against the
      // sheet's 23). A sheet that ran to the window's foot had its last 58px
      // under the dock — its last rows out of reach. It ends where the dock
      // begins, by the dock's own height, safe area and all.
      // CHANGED ON PURPOSE (the phone layout): the sheet's `bottom` is the
      // custom property `--sheet-bottom` (phone-sheet.css), and that property is
      // the dock's height plus the safe area: the same hang from the dock, read
      // through one more step. Both are pinned below.
      const dock = cascade(sel => selects(sel, [el("div", ["edge-dock"])]), "height", width);
      for (const left of LEFTS) {
        expect(resolve("detail", "bottom", left, width), left).toBe("var(--sheet-bottom)");
        expect(resolve("detail", "--sheet-bottom", left, width), left).toBe(dock);
      }
    });
  }

  it("keeps the wide layout exactly as it was: a 360px column beside the canvas", () => {
    // The track reads --inspector-w since V4's Inspector, and the Default
    // density's value of it is the 360px this test is named for.
    expect(token("--inspector-w", 1280)).toBe("360px");
    for (const width of [648, 900, 1280]) {
      expect(layout("none", width)).toMatchObject({ template: "1fr var(--inspector-w)", overlay: false });
      // `auto` since 2026-10-08: the track is the left column's, which is the
      // session list's 288px while the list is in it (styles/left-column.css).
      expect(layout("sessions", width)).toMatchObject({ template: "auto 1fr var(--inspector-w)", overlay: false });
    }
    // With Accounts open the panel and the column are 648px between them, so
    // from 641 to 647px the column gives up what the window lacks (#1840) —
    // still a column, never the sheet.
    for (const width of [648, 900, 1280]) {
      expect(layout("accounts", width)).toMatchObject({ template: "auto 1fr var(--inspector-w)", overlay: false });
    }
    expect(resolve("detail", "position", "accounts", 641) ?? "static").toBe("relative");
  });
});
