// A session list row keeps one height while its session works.
//
// The status line under a row's figures says what the session is doing, and
// while a turn runs it is rewritten every few seconds. It was as tall as its
// text, one line to three, so each new sentence moved every row under it:
// measured at 1440×900 with four replies of 27, 148, 21 and 174 characters,
// the rows below jumped 15px, 31px, 31px and 31px.
//
// Now the line has one clamp for every kind of note, and holds both of its
// lines while the turn runs. Two lines rather than the recap's three, so the
// list still meets DESIGN.md's density target with every session at work:
// eight rows at 1440×900 with the detail rail open fit without scrolling.
// A row whose session is not working keeps the height its text needs, and a
// row with nothing to say keeps none.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cascade, el, selects, sheetRules } from "./sheet-cascade";

const list = readFileSync(fileURLToPath(new URL("../components/SessionList.tsx", import.meta.url)), "utf8");

/** A session list row down to its status line, for a note of `kind`. */
const STATUS = (kind: string) => [
  el("html", [], { states: ["root"] }), el("body"), el("div", ["app"]),
  el("aside", ["session-list"]), el("ul", ["sl-rows"]), el("li", ["sl-row-item"]),
  el("button", ["sl-row", "state-active"]), el("div", ["sl-row-body"]), el("span", ["sl-status", `status-${kind}`]),
];
const got = (chain: ReturnType<typeof STATUS>, prop: string, width = 1440) => cascade(s => selects(s, chain), prop, width);

describe("a session list row's status line", () => {
  it("is the row's tooltip, whole, so a clamp cuts nothing a reader cannot reach", () => {
    expect(list).toContain('<span className={`sl-status status-${r.status.kind}`} title={statusTooltip(r.status)}>');
    expect(list).toMatch(/return \[s\.text, s\.reply \? `Suggested reply: \$\{s\.reply\}` : "", noteSource\(s\)\]/);
  });

  for (const kind of ["now", "last", "needs", "done", "failed"]) {
    it(`clamps a "${kind}" note at two lines, like every other kind`, () => {
      const chain = STATUS(kind);
      expect(got(chain, "-webkit-line-clamp")).toBe("2");
      expect(got(chain, "line-clamp")).toBe("2");
      expect(got(chain, "line-height")).toBe("1.4");
    });
  }

  it("holds both lines while the session's turn runs", () => {
    // The "now" note is the one rewritten as the turn goes on, by the newest
    // reply, the job's own line, or the prompt before the model answers.
    expect(got(STATUS("now"), "min-height")).toBe("calc(2 * 1.4em)");
  });

  it("holds nothing on a row whose session is not working", () => {
    for (const kind of ["last", "needs", "done", "failed"]) {
      expect(got(STATUS(kind), "min-height"), kind).toBeNull();
    }
    // Nor on the row itself, so a row with no note at all is as short as it was.
    const row = STATUS("now").slice(0, -1);
    expect(got(row, "min-height")).toBeNull();
    expect(got(row.slice(0, -1), "min-height")).toBeNull();
  });

  it("keeps the recap's three lines, which are not rewritten as a turn runs", () => {
    const recap = sheetRules().filter(r => r.media == null && r.selectors.includes(".session-list .sl-recap"));
    expect(recap.map(r => r.body).join("\n")).toMatch(/-webkit-line-clamp:\s*3;/);
  });
});
