// What the topbar's readout strip is allowed to contain, and what the sheet is
// allowed to draw between its members.
//
// THE HISTORY THIS REPLACES. The strip used to be a run of readouts with 1px
// rules between them, drawn by `::before` selectors keyed on ADJACENT elements,
// and that shape failed twice. #502 removed the sessions, agents and events
// counters and left `.topbar .status .stat + .sysmeter-wrap::before` matchable
// in no state at all — the meter's preceding sibling had been the events
// counter and became the status pill. Removing the MCP legend asked the same
// question again within the hour. The answer both times was arithmetic about
// which side of a `+` each rule named, redone from scratch each time, which is
// why `topbar-divider-run.test.ts` existed: it walked every row the strip could
// render and counted lines.
//
// That file is gone because its subject is. The two BOARD readouts it counted
// were dropped. #737 later added one month-to-date phrase backed by ccusage;
// tokens and cost stay inside that one phrase so the period label cannot drift
// away from either number. The machine meter remains out of the strip.
//
// WHY A TEST STILL. The removal is only durable if the strip cannot quietly
// grow a second member and a divider to go with it. The next such addition is
// the one that has to redo the geometry, and this file is where it finds out.
// So the invariant is now the SHAPE rather than the run: status pill plus one
// monthly usage phrase, and no divider rules under `.topbar .status` at all.
//
// No DOM, same as before: the rules come out of styles.css and the row out of
// App.tsx's markup, the way dead-css and session-hue read the same two files.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const web = fileURLToPath(new URL("..", import.meta.url));
// Comments carry braces and selectors of their own, and this file scans rules.
const css = readFileSync(join(web, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const app = readFileSync(join(web, "App.tsx"), "utf8");

/** Selector / body for every rule in the sheet. A nested at-rule's wrapper has a
 *  `{` inside its "body" and is skipped; the rules within it are matched on
 *  their own, which is what this needs. */
const RULES = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({
  selectors: m[1].split(",").map(s => s.trim()).filter(Boolean),
  body: m[2],
}));

/** The strip's markup, from App.tsx. */
const strip = app.slice(
  app.indexOf(`<span className="status">`),
  app.indexOf(`<div className="vis-hidden"`),
);

describe("the topbar's readout strip", () => {
  it("is still in App.tsx, so nothing below is vacuous", () => {
    expect(strip, "the .status strip is gone from App.tsx").toBeTruthy();
  });

  it("holds the status pill and one month-to-date usage phrase", () => {
    expect(strip, "the strip lost the pill").toContain("`pill ${pill.tone}`");
    expect(strip, "the machine meter is back in the strip").not.toContain("<MachinePanel");
    expect(strip).toContain('className="month-usage"');
    expect(strip).toContain('className="month-usage-label">this month</span>');
    expect(strip).toContain("fmtTokens(monthlyUsage.tokens)");
    expect(strip).toContain("fmtMonthlyCost(monthlyUsage.cost)");
    const classes = new Set([...strip.matchAll(/className="([\w- ]+)"/g)].map(m => m[1]));
    expect([...classes].sort()).toEqual([
      "month-usage", "month-usage-label", "month-usage-pending", "month-usage-sep",
      "month-usage-unit", "pill-box", "pill-label", "pill-widest", "status",
    ]);
  });

  it("draws no divider at all — the 14px gap is the whole separation", () => {
    // Read off the sheet rather than listed here, so a divider that is added
    // anywhere under the strip is answered by this same walk.
    const dividers = RULES
      .filter(r => /width:\s*1px/.test(r.body) && /background:\s*var\(--line\)/.test(r.body))
      .flatMap(r => r.selectors)
      .filter(s => s.startsWith(".topbar .status") && s.endsWith("::before"));
    expect(dividers, "a divider rule came back to the compact readout strip").toEqual([]);
    const status = RULES.filter(r => r.selectors.includes(".topbar .status"));
    expect(status, "the strip lost its own rule").toHaveLength(1);
    expect(status[0].body, "the 14px between readouts moved").toMatch(/gap:\s*14px/);
  });

  it("keeps board-scoped readouts out", () => {
    // The chips said "board tokens" and "board cost" because the figures fall
    // on their own as the canvas evicts finished work, and a bare "tokens" read
    // as a claim about the day. A qualifier and a three-line tooltip is a lot of
    // apparatus for 12px of row, with ccusage answering the same question
    // properly one panel over — so the readouts went rather than the words.
    //
    // The needles are the two constants and the class the chips wore, not the
    // words they printed: the words are quoted in App.tsx's own comment about
    // why they are gone, and a test that forbade them there would be forbidding
    // the explanation rather than the readout.
    for (const gone of ["BOARD_TOKENS_LABEL", "BOARD_COST_LABEL", `className="stat"`]) {
      expect(app, `${gone} is back in App.tsx`).not.toContain(gone);
    }
    expect(strip).not.toContain("boardTotals");
    // And the constants are gone from the module that declared them, so there is
    // nothing to import back in from anywhere else either.
    const boardUsage = readFileSync(join(web, "board-usage.ts"), "utf8");
    expect(boardUsage).not.toMatch(/export const BOARD_(?:TOKENS|COST)_LABEL/);
    expect(strip).not.toContain("mcp-legend");
  });
});
