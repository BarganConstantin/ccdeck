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
// Now the column is one element. Its width is leftColumnWidth's, the open
// panel's or 0, eased from the last one, and the panels are out of flow inside
// it, each at its own width. No panel can size the column by its content.
//
// There is no DOM or layout in this suite, so two levels are pinned here: the
// decision, as the functions that make it, and the grid that applies it, read
// from the sheet the way the browser would cascade it. The frames themselves
// were measured in a headless browser (the PR has the strips).
import { describe, it, expect } from "vitest";
import * as column from "../use-left-column";
import { sheetText } from "./sheet-source";
import { sourceOf } from "./client-source";

const PANEL_WIDTHS = [288, 288];

describe("the column's width is decided in one place (2026-10-08)", () => {
  it("is the open panel's own width, or nothing", () => {
    const width = (list: boolean, accounts: boolean, waiting: boolean) =>
      column.leftColumnWidth(column.leftColumnPanel(list, accounts, waiting));
    // Accounts to the session list: the list takes the column, Accounts waits.
    expect(width(true, false, true)).toBe(288);
    // The session list to Accounts.
    expect(width(false, true, false)).toBe(288);
    // The list closing in front of a panel that is waiting for it: Accounts's
    // width at once. A render at 0 would start the column closing.
    expect(width(false, false, true)).toBe(288);
    expect(width(false, false, false)).toBe(0);
    for (const list of [true, false]) for (const accounts of [true, false]) for (const waiting of [true, false]) {
      expect([0, ...PANEL_WIDTHS], `${list} ${accounts} ${waiting}`).toContain(width(list, accounts, waiting));
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
  // A switch: the panel arriving and the panel leaving are both in the column.
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

  it("draws each panel at its own width, out of the column's flow", () => {
    const own = (sel: string) => decl(rules.find(r => r.selector === sel)?.body ?? "", "width");
    expect(own(".session-list")).toBe(`${column.SESSION_LIST_WIDTH}px`);
    expect(own(".accounts-panel")).toBe(`${column.ACCOUNTS_PANEL_WIDTH}px`);
    const inside = rules.find(r => selectorsOf(r.selector).includes(".left-column > .session-list")
      && selectorsOf(r.selector).includes(".left-column > .accounts-panel"));
    expect(decl(inside?.body ?? "", "position")).toBe("absolute");
  });

  it("is as wide as App says, eased over --column-move", () => {
    const body = rules.find(r => r.selector === ".left-column")?.body ?? "";
    expect(decl(body, "width")).toBe("var(--left-col-w)");
    expect(decl(body, "transition")).toMatch(/^width var\(--column-move\) var\(--column-ease\)$/);
    expect(css).toMatch(new RegExp(`--column-move:\\s*${column.COLUMN_MOVE_MS}ms;`));
    expect(sourceOf("components/LeftColumn.tsx")).toMatch(/"--left-col-w": `\$\{width\}px`/);
    expect(sourceOf("App.tsx")).toMatch(/<LeftColumn width=\{leftColumnTarget\}>/);
  });
});
