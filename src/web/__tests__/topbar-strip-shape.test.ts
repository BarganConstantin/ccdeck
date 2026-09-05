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
// That file is gone because its subject is. The two board readouts it counted
// lines between — a token total and a dollar figure, both sums over the agents
// on the canvas right now — were dropped, and the dividers went with them.
// There is nothing left to count: two members, one gap, no rules.
//
// WHY A TEST STILL. The removal is only durable if the strip cannot quietly
// grow a third member and a divider to go with it. The next such addition is
// the one that has to redo the geometry, and this file is where it finds out.
// So the invariant is now the SHAPE rather than the run: exactly two members in
// a known order, and no divider rules under `.topbar .status` at all. A third
// readout arriving fails here first, and whoever adds it either brings the
// counting test back with it or explains why the gap alone is enough.
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

  it("holds the status pill and the machine meter, in that order, and nothing else", () => {
    const order = ["`pill ${pill.tone}`", "<SystemMeter"].map(needle => strip.indexOf(needle));
    expect(order.every(at => at > -1), `the strip lost one of ${order}`).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The pill's own three spans are the only other elements in here. A third
    // member of the strip proper would show up as a fourth class name.
    const classes = new Set([...strip.matchAll(/className="([\w- ]+)"/g)].map(m => m[1]));
    expect([...classes].sort()).toEqual(["pill-box", "pill-label", "pill-widest", "status"]);
  });

  it("draws no divider between them — the 14px gap is the whole separation", () => {
    // Read off the sheet rather than listed here, so a divider that is added
    // anywhere under the strip is answered by this same walk.
    const dividers = RULES
      .filter(r => /width:\s*1px/.test(r.body) && /background:\s*var\(--line\)/.test(r.body))
      .flatMap(r => r.selectors)
      .filter(s => s.startsWith(".topbar .status") && s.endsWith("::before"));
    expect(dividers, "a divider rule came back to a strip with two members").toEqual([]);
    const status = RULES.filter(r => r.selectors.includes(".topbar .status"));
    expect(status, "the strip lost its own rule").toHaveLength(1);
    expect(status[0].body, "the 14px between readouts moved").toMatch(/gap:\s*14px/);
  });

  it("keeps the two board readouts out, along with the words that qualified them", () => {
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
    // And the constants are gone from the module that declared them, so there is
    // nothing to import back in from anywhere else either.
    const boardUsage = readFileSync(join(web, "board-usage.ts"), "utf8");
    expect(boardUsage).not.toMatch(/export const BOARD_(?:TOKENS|COST)_LABEL/);
    expect(strip).not.toContain("mcp-legend");
  });
});
