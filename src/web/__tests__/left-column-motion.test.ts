// The left column jumped when it changed panels (2026-10-08). With Accounts
// open, L drew the session list at 360px on the demo deck — its longest row,
// unwrapped; half the window on a busy deck — for the 200ms the accounts panel
// takes to leave, and then it snapped to 240px.
//
// The cause was the grid. Both panels were grid items in the first track, and a
// switch had both of them in it while the leaving one animated out. The track's
// template came from whichever `.app:has(...)` rule was last in the sheet:
// Accounts' `auto`, which outranked the session list's `240px`. An `auto` track
// is as wide as what is in it, and the session list had no width of its own.
//
// Now the column is one element. Its width is leftColumnWidth's, the panels'
// one width or 0, eased from the last one, and each panel in it is drawn at its
// own width, which the column clips. No panel can size the column by its
// content.
//
// CHANGED ON PURPOSE (the owner, 2026-11-23): the two no longer take turns at
// the column. With both open they stand one under the other in it, Sessions
// on top, so the panels are in the column's flow — a flex column — rather than
// laid over each other out of it. What this file guards is unchanged: the
// column's width is App's alone, and no panel's content can set it.
//
// There is no DOM or layout in this suite, so two levels are pinned here: the
// decision, as the functions that make it, and the grid that applies it, read
// from the sheet the way the browser would cascade it. The frames themselves
// were measured in a headless browser (the PR has the strips).
import { describe, it, expect } from "vitest";
import * as column from "../use-left-column";
import { defaultReadingSheetText as sheetText } from "./sheet-source";
import { sourceOf } from "./client-source";

const PANEL_WIDTHS = [288, 288];

describe("the column's width is decided in one place (2026-10-08)", () => {
  it("is the panels' one width while either is open, or nothing", () => {
    const width = (list: boolean, accounts: boolean) =>
      column.leftColumnWidth(column.leftColumnPanel(list, accounts));
    // CHANGED ON PURPOSE: was the list taking the column while Accounts waited
    // behind it (a third, "waiting" flag). Both open is the two stacked, at
    // the one width they share.
    expect(width(true, true)).toBe(288);
    expect(width(true, false)).toBe(288);
    expect(width(false, true)).toBe(288);
    expect(width(false, false)).toBe(0);
    // Opening Accounts under an open list, or closing either of two, leaves
    // the column's width as it was: the board's edge does not move. (Was: the
    // list closing in front of a waiting panel kept Accounts's width at once,
    // because a render at 0 would start the column closing; the same holds
    // with no waiting, since the panel left is already open.)
    expect(width(true, true)).toBe(width(true, false));
    expect(width(true, true)).toBe(width(false, true));
    for (const list of [true, false]) for (const accounts of [true, false]) {
      expect([0, ...PANEL_WIDTHS], `${list} ${accounts}`).toContain(width(list, accounts));
    }
  });

  it("is the reader's dragged width with both open, the same as with either alone", () => {
    for (const [list, accounts] of [[true, true], [true, false], [false, true]] as const) {
      expect(column.leftColumnWidth(column.leftColumnPanel(list, accounts), 264, 400), `${list} ${accounts}`).toBe(400);
    }
  });

  it("names the two widths the sheet draws the panels at", () => {
    expect([column.SESSION_LIST_WIDTH, column.ACCOUNTS_PANEL_WIDTH]).toEqual(PANEL_WIDTHS);
  });
});

// ── the grid, as the browser cascades it ─────────────────────────────────────

const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");

/** Top-level rules only: the desktop layout, outside every @media. */
function topLevelRules(src: string): { selector: string; body: string; at: number }[] {
  const out: { selector: string; body: string; at: number }[] = [];
  let depth = 0, start = 0, prelude = "";
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "{") {
      if (depth === 0) { prelude = src.slice(start, i).trim(); start = i + 1; }
      depth++;
    } else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        if (!prelude.startsWith("@")) out.push({ selector: prelude, body: src.slice(start, i), at: i });
        start = i + 1;
      }
    }
  }
  return out;
}
const rules = topLevelRules(css);
const decl = (body: string, prop: string) => new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`).exec(body)?.[1].trim() ?? null;
const selectorsOf = (selector: string) => selector.split(",").map(s => s.replace(/\s+/g, " ").trim());

/** The `.app` template that wins with these elements present: the most
 *  specific matching selector, and among equals the last. */
function winningTemplate(present: Set<string>): string {
  let best: { spec: number; at: number; value: string } | null = null;
  for (const rule of rules) {
    const value = decl(rule.body, "grid-template-columns");
    if (!value) continue;
    for (const sel of selectorsOf(rule.selector)) {
      const m = /^\.app((?::has\(\.[\w-]+\)|:not\(:has\(\.[\w-]+\)\))*)$/.exec(sel);
      if (!m) continue;
      const parts = [...m[1].matchAll(/(:not\()?:has\(\.([\w-]+)\)\)?/g)];
      const matches = parts.every(([, not, cls]) => (not ? !present.has(cls) : present.has(cls)));
      if (!matches) continue;
      const spec = 1 + parts.length;
      if (!best || spec > best.spec || (spec === best.spec && rule.at > best.at)) best = { spec, at: rule.at, value };
    }
  }
  return best?.value ?? "";
}

/** The first track of a template, with minmax()'s inner space kept whole. */
const firstTrack = (template: string) => /^(\S+\([^)]*\)|\S+)/.exec(template)?.[1] ?? "";

/** What the sheet puts in the first track itself, and the width it gives each. */
const occupants = () => rules
  .filter(r => selectorsOf(r.selector).some(s => [".session-list", ".accounts-panel", ".left-column"].includes(s)))
  .filter(r => decl(r.body, "grid-column") === "1")
  .map(r => ({ who: r.selector, width: decl(r.body, "width") }));

describe("no panel can size the column by its content (2026-10-08)", () => {
  // Both panels in the column: open one under the other, or one of the two on
  // its way out (CHANGED ON PURPOSE: was a switch, the panel arriving and the
  // panel leaving).
  for (const detail of [true, false]) {
    it(`gives the track a panel's width while both panels are in it, the detail panel ${detail ? "open" : "closed"}`, () => {
      const present = new Set(["session-list", "accounts-panel", "left-column", ...(detail ? ["detail"] : [])]);
      const track = firstTrack(winningTemplate(present));
      expect(track, "no template matched").not.toBe("");
      if (track !== "auto") {
        expect(PANEL_WIDTHS.map(w => `${w}px`)).toContain(track);
        return;
      }
      // An `auto` track is as wide as what is in it, so each thing in it must
      // say how wide it is: a panel's width, or the column's own.
      const inTrack = occupants();
      expect(inTrack.length).toBeGreaterThan(0);
      for (const { who, width } of inTrack) {
        expect([...PANEL_WIDTHS.map(w => `${w}px`), "var(--left-col-w)"], `${who} sizes an auto track by its content`).toContain(width);
      }
    });
  }

  it("draws each panel at its own width, in a stack the column clips", () => {
    const own = (sel: string) => decl(rules.find(r => r.selector === sel)?.body ?? "", "width");
    // The rail draws at V4's --rail-w, the density's token (Default and
    // Comfortable 288, Compact and below 264 — use-left-column.ts's
    // useRailWidth reads the same one for the column); SESSION_LIST_WIDTH is
    // the Default value the token falls back to.
    expect(own(".session-list")).toBe("calc(var(--rail-w))");
    expect(css).toMatch(new RegExp(`:root\\s*\\{[^}]*--rail-w:\\s*${column.SESSION_LIST_WIDTH}px;`));
    // CHANGED ON PURPOSE (V4's Figma): the accounts panel is drawn at the same
    // token (264 at Compact), and the column holds the rail's width for it.
    expect(own(".accounts-panel")).toBe("calc(var(--rail-w))");
    // In the column both are drawn at the one width they share, the list's
    // (--list-w), whatever the column's own width is doing on that frame.
    for (const sel of [".left-column > .session-list", ".left-column > .accounts-panel"]) {
      expect(own(sel), sel).toMatch(/^var\(--list-w, /);
    }
    // CHANGED ON PURPOSE (the owner, 2026-11-23): was `position: absolute`,
    // each panel laid over the other out of the column's flow, for the switch
    // that cross-faded them. They stand one under the other now, so they are
    // in the column's flow, and it is the column's explicit width and its clip
    // that keep their content from sizing it.
    const inside = rules.find(r => selectorsOf(r.selector).includes(".left-column > .session-list")
      && selectorsOf(r.selector).includes(".left-column > .accounts-panel"));
    expect(decl(inside?.body ?? "", "position")).toBe("relative");
    expect(decl(inside?.body ?? "", "flex")).toBe("1 1 0");
    expect(decl(inside?.body ?? "", "min-height")).toBe("0");
    const columnRule = rules.find(r => r.selector === ".left-column")?.body ?? "";
    expect(decl(columnRule, "display")).toBe("flex");
    expect(decl(columnRule, "flex-direction")).toBe("column");
    expect(decl(columnRule, "overflow")).toBe("hidden");
  });

  it("is as wide as App says, eased over V4's --dur-move on --ease-stage", () => {
    const body = rules.find(r => r.selector === ".left-column")?.body ?? "";
    expect(decl(body, "width")).toBe("var(--left-col-w)");
    expect(decl(body, "transition")).toMatch(/^width var\(--dur-move\) var\(--ease-stage\)$/);
    expect(css).toMatch(new RegExp(`--dur-move:\\s*${column.COLUMN_MOVE_MS}ms;`));
    // App's width, plus the reading preference's panel increase while open:
    // 0px at the Default text size, so the column is exactly App's width.
    expect(sourceOf("components/LeftColumn.tsx")).toMatch(/"--left-col-w": width === 0 \? "0px" : `calc\(\$\{width\}px \+ var\(--ui-panel-increase, 0px\)\)`/);
    // CHANGED ON PURPOSE (internal #103): the column also holds the Sessions
    // list's own width (--list-w) for the list in it; its own width is still
    // App's leftColumnTarget.
    expect(sourceOf("App.tsx")).toMatch(/<LeftColumn width=\{leftColumnTarget\} listWidth=\{phone \? undefined : listWidth\}/);
  });
});
