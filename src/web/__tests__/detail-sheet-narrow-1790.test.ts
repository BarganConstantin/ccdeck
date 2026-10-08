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
const SESSION_LIST = 240;

/** A custom property's value at `width`, as the root declares it. */
const token = (name: string, width: number) => cascade(sel => selects(sel, [el("html", [], { states: ["root"] })]), name, width);

type Left = "none" | "sessions" | "accounts";

/** `.app` with any run of `:has(.x)` / `:not(:has(.x))`, against what is open
 *  beside a selected session's panel. Its weight, or null when it does not match. */
function appCompound(sel: string, left: Left): number | null {
  const m = /^\.app((?::has\(\.[\w-]+\)|:not\(:has\(\.[\w-]+\)\))*)$/.exec(sel);
  if (!m) return null;
  const present = (cls: string) =>
    (cls === "session-list" && left === "sessions")
    || (cls === "accounts-panel" && left === "accounts")
    || (cls === "left-column" && left !== "none")
    || cls === "detail";
  let spec = 10;
  for (const p of m[1].match(/:has\(\.[\w-]+\)|:not\(:has\(\.[\w-]+\)\)/g) ?? []) {
    const cls = /\.([\w-]+)/.exec(p)![1];
    if (present(cls) !== !p.startsWith(":not")) return null;
    spec += 10;
  }
  return spec;
}

/** How heavily `sel` selects the element, or null. Any selector whose subject
 *  is `.app` or `.detail` in a form this cannot read fails the test rather than
 *  being skipped, so a new kind of rule cannot slip past it. */
function matches(sel: string, subject: "app" | "detail", left: Left): number | null {
  const parts = sel.split(/\s+/);
  const last = parts.at(-1)!;
  if (!/^\.(app|detail)(?![\w-])/.test(last)) return null;
  if (subject === "app") {
    if (parts.length > 1 || !last.startsWith(".app")) return null;
    const spec = appCompound(last, left);
    if (spec == null && !/^\.app(:has|:not|$)/.test(last)) throw new Error(`unread selector: ${sel}`);
    return spec;
  }
  if (last !== ".detail") {
    if (last.startsWith(".detail")) throw new Error(`unread selector: ${sel}`);
    return null;
  }
  if (parts.length === 1) return 10;
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
  const m = /^(-?[\d.]+)(px|vw)$/.exec(s);
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

    it(`puts the panel over the canvas at ${width}px, inside the window and under the topbar`, () => {
      for (const left of LEFTS) {
        const right = length(resolve("detail", "right", left, width)!, width);
        const w = length(resolve("detail", "width", left, width)!, width);
        const top = length(resolve("detail", "top", left, width)!, width);
        expect(right).toBeGreaterThanOrEqual(0);
        // Its left edge, and the × pinned inside its right one, both on screen.
        expect(width - right - w).toBeGreaterThanOrEqual(0);
        // Under the topbar: no higher than the grid's first row, the bar's
        // own, read from the same sheet rather than from a number this test
        // keeps — the bar was 52px, and is 44 since its panel toggles left for
        // the window's edges (2026-10-08).
        const bar = length(splitTop(resolve("app", "grid-template-rows", left, width)!.replace(/\s+(?![^(]*\))/g, ","))[0], width);
        expect(bar).toBe(44);
        expect(top).toBeGreaterThanOrEqual(bar);
      }
    });

    it(`ends the panel above the phone's dock at ${width}px, so its foot is not drawn under it`, () => {
      // Under 641px the controls stand in a dock along the bottom
      // (edge-rails.css), fixed over everything docked (z-index 25 against the
      // sheet's 20). A sheet that ran to the window's foot had its last 56px
      // under the dock — its last rows out of reach. It ends where the dock
      // begins, by the dock's own height, safe area and all.
      const dock = cascade(sel => selects(sel, [el("div", ["edge-dock"])]), "height", width);
      for (const left of LEFTS) {
        expect(resolve("detail", "bottom", left, width), left).toBe(dock);
      }
    });
  }

  it("takes the selected ribbon off a phone's bar, where the sheet says the same thing", () => {
    // The last piece a selection added to a bar that holds its controls down
    // to 320px only without it: at 320 it shrank to its × and pushed the last
    // control 12px past the right edge. It went only while the sheet was up at
    // first; with the sheet closed it drew its state over the Session list
    // button and took the waiting pill's room, so it goes at a phone's width
    // whether or not the sheet is up — which includes while it is.
    const hides = (width: number) => sheetRules().some(r => mediaApplies(r.media, width)
      && r.selectors.includes(".selected-ribbon") && /display:\s*none/.test(r.body));
    expect(hides(320)).toBe(true);
    expect(hides(480)).toBe(true);
    expect(hides(641)).toBe(false);
  });

  it("keeps the wide layout exactly as it was: a 360px column beside the canvas", () => {
    for (const width of [641, 900, 1280]) {
      expect(layout("none", width)).toMatchObject({ template: "1fr 360px", overlay: false });
      // `auto` since 2026-10-08: the track is the left column's, which is the
      // session list's 240px while the list is in it (styles/left-column.css).
      expect(layout("sessions", width)).toMatchObject({ template: "auto 1fr 360px", overlay: false });
    }
    // With Accounts open the panel and the column are 648px between them, so
    // from 641 to 647px the column gives up what the window lacks (#1840) —
    // still a column, never the sheet.
    for (const width of [648, 900, 1280]) {
      expect(layout("accounts", width)).toMatchObject({ template: "auto 1fr 360px", overlay: false });
    }
    expect(resolve("detail", "position", "accounts", 641) ?? "static").toBe("relative");
  });
});
