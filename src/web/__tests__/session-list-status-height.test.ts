// A session list row keeps one height while its session works.
//
// The status line under a row's figures says what the session is doing, and
// while a turn runs it is rewritten every few seconds. It was as tall as its
// text, one line to three, so each new sentence moved every row under it:
// measured at 1440×900 with four replies of 27, 148, 21 and 174 characters,
// the rows below jumped 15px, 31px, 31px and 31px. A two-line clamp, held while
// the turn ran, was the fix.
//
// V4's Attention rail (Figma Rail / Row) makes it simpler: a row is the name
// line and ONE second line, cut with an ellipsis at the row's width, so what
// is rewritten can never change how tall the row is. The whole text, and who
// wrote it, is the row's tooltip, so a cut line loses nothing a reader cannot
// reach.
import { describe, it, expect } from "vitest";
import { cascade, el, selects, sheetRules } from "./sheet-cascade";
import { railLine, rowTooltip } from "../rail-row-copy";
import type { Row } from "../components/SessionList";

/** A rail row down to its second line. */
const LINE = [
  el("html", [], { states: ["root"] }), el("body"), el("div", ["app"]),
  el("aside", ["session-list"]), el("ul", ["sl-rows"]), el("li", ["sl-row-item"]), el("div", ["sl-row-in"]),
  el("button", ["sl-row"]), el("span", ["sl-text"]), el("span", ["sl-line2", "mono"]),
];
const got = (chain: ReturnType<typeof el>[], prop: string, width = 1440) => cascade(s => selects(s, chain), prop, width);

const LONG = "Now I'll make the invoice preview pick up the customer's locale, then rerun the whole formatting suite and the snapshot tests before touching the exports";
const base: Row = { sessionId: "s", label: "api", state: "active", toolCount: 3, cost: 0, startedAt: 0, lastActivity: 0, plan: null, planTitle: "" };
const working: Row = { ...base, status: { kind: "now", text: LONG, at: 1, source: "activity", key: "k" } };

describe("a rail row's second line", () => {
  it("is one line, cut with an ellipsis, whatever the note says", () => {
    expect(got(LINE, "white-space")).toBe("nowrap");
    expect(got(LINE, "overflow")).toBe("hidden");
    expect(got(LINE, "text-overflow")).toBe("ellipsis");
    expect(got(LINE, "-webkit-line-clamp")).toBeNull();
    expect(got(LINE, "min-height")).toBeNull();
  });

  it("holds nothing back for a note: the row's own height is its minimum", () => {
    const row = LINE.slice(0, -2);
    expect(got(row, "min-height")).toBe("var(--row-rail)");
    // And no row-level clamp or fixed height that a longer sentence could outgrow.
    expect(got(row, "height")).toBeNull();
    expect(got(row, "max-height")).toBeNull();
  });

  it("says the whole note in the row's tooltip, with who wrote it", () => {
    expect(railLine(working, 1)).toEqual({ kind: "mono", text: LONG });
    const title = rowTooltip(working, false);
    expect(title).toContain(LONG);
    expect(title.split("\n").length).toBeGreaterThan(2);
  });

  it("keeps the suggested reply in the tooltip, since the row has no line for it", () => {
    const asking: Row = { ...working, status: { kind: "needs", text: "Which database?", reply: "postgres", at: 1, source: "job", key: "k" } };
    expect(rowTooltip(asking, false)).toContain("Suggested reply: postgres");
  });

  it("keeps the recap's whole text in the tooltip, and its first line as the row's", () => {
    const recapped: Row = { ...base, state: "done", recap: { text: "Shipped the login route", at: 1 } };
    expect(railLine(recapped, 3)).toEqual({ kind: "mono", text: "Shipped the login route" });
    expect(rowTooltip(recapped, false)).toContain("Shipped the login route");
  });

  it("is not drawn twice by a rule a later sheet could widen", () => {
    const rules = sheetRules().filter(r => r.media == null && r.selectors.includes(".session-list .sl-line2"));
    expect(rules.length).toBe(1);
  });
});
