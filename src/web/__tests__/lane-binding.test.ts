// An account row printed every quota window it had, and only one of them ever
// decided anything.
//
// Measured in headless Chrome against the real stylesheet, panel at its shipped
// 288px, three accounts each with `5h`, `7d` and one scoped model lane:
//
//   block, inactive        166.69px
//   block, active          160.69px   (a smaller state marker than the switch)
//   three blocks + chrome  665.85px   against 761px of panel on an 813px screen
//   scrolls at             4 accounts
//
// After: every block 98.59px, active and inactive alike, three of them plus
// chrome 479.05px, and the scrollbar starts at 7 accounts instead of 4.
//
// What was removed is repetition, not information. Only the HIGHEST lane
// decides anything — it is the window that runs out first and the one
// claude-swap measures its auto-switch threshold against — and the server
// already knew which: `claude-accounts.mjs` ships
// `headroom: 100 - Math.max(...lanes.map(l => l.pct))` with the comment "the
// number that decides whether this account is worth switching to", the panel
// declared the field on its `Account` interface, and nothing ever read it.
// Meanwhile the panel computed the same `Math.max` again, further down, for the
// auto-switch readout. So the row was printing three numbers and leaving the
// reader to perform a max() the component was already performing twice.
//
// This file holds the two halves of the fix. The pure half is lane-view.ts,
// swept rather than sampled. The other half is read out of the markup, because
// a pure function that is right about lanes it is never handed is the failure
// mode this repo has already shipped once: the panel must render ONE lane at
// rest, put the rest behind a disclosure that really points at them, and take
// the auto-switch readout from the same function the rows use.
//
// Plain node, no DOM, so the second half reads AccountsPanel.tsx as text the
// way manage-block.test.ts and picker-commit.test.ts do.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { laneSplit, lanesTitle, moreLabel } from "../lane-view";

const panel = readFileSync(fileURLToPath(new URL("../components/AccountsPanel.tsx", import.meta.url)), "utf8");
const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
const server = readFileSync(fileURLToPath(new URL("../../server/claude-accounts.mjs", import.meta.url)), "utf8");

/** The panel with its comments gone. The prose below quotes the shape it
 *  retired, so a search for `a.lanes.map` has to read the markup only. */
const panelCode = panel
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");

const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

const lane = (id: string, pct: number) => ({ id, pct });

describe("the lane that binds", () => {
  it("is the highest one, whatever order the server sent them in", () => {
    expect(laneSplit([lane("5h", 12), lane("7d", 44), lane("opus", 9)]).binding!.id).toBe("7d");
    expect(laneSplit([lane("5h", 91), lane("7d", 44)]).binding!.id).toBe("5h");
    expect(laneSplit([lane("5h", 0), lane("7d", 0), lane("opus", 1)]).binding!.id).toBe("opus");
  });

  it("resolves a tie to the earlier lane, so the row cannot flicker between two equal numbers", () => {
    // The roster reloads every fifteen seconds and two windows sitting on the
    // same percentage for a while is ordinary — 0% and 0% is the whole of a
    // fresh account. A `>=` scan would hand the row a different label on every
    // poll for as long as the tie lasted.
    const tied = [lane("5h", 40), lane("7d", 40), lane("opus", 40)];
    for (let i = 0; i < 20; i++) expect(laneSplit(tied).binding!.id).toBe("5h");
    expect(laneSplit(tied).rest.map(l => l.id)).toEqual(["7d", "opus"]);
  });

  it("hands back everything else in the order it arrived, never sorted", () => {
    // A row whose single bar changes its label from `5h` to `7d` is telling the
    // reader the binding window moved, which is worth knowing. A list that
    // re-sorts itself under them while they are reading it is not — and the two
    // would look identical from one poll to the next.
    const lanes = [lane("5h", 10), lane("7d", 90), lane("opus", 55), lane("sonnet", 70)];
    expect(laneSplit(lanes).rest.map(l => l.id)).toEqual(["5h", "opus", "sonnet"]);
  });

  it("is total over the lane counts the server can actually produce", () => {
    // Not three, and never was: claude-accounts.mjs builds `5h`, `7d` and one
    // lane per scoped model, dropping any window it has no reading for. Zero
    // and one are the two the row answers differently.
    expect(server).toMatch(/lane\("five_hour", "5h"/);
    expect(server).toMatch(/lane\("seven_day", "7d"/);
    expect(server).toMatch(/\.map\(\(s, i\) => lane\(`scoped-\$\{i\}`/);
    expect(laneSplit([])).toEqual({ binding: null, rest: [] });
    const one = laneSplit([lane("5h", 3)]);
    expect(one.binding!.id).toBe("5h");
    expect(one.rest).toEqual([]);
    for (let n = 0; n <= 12; n++) {
      const lanes = Array.from({ length: n }, (_, i) => lane(`l${i}`, i * 7 % 100));
      const split = laneSplit(lanes);
      expect(split.rest.length, `${n} lanes`).toBe(Math.max(0, n - 1));
      if (n) expect(Math.max(...lanes.map(l => l.pct))).toBe(split.binding!.pct);
      // Nothing is lost and nothing is duplicated.
      const back = [...(split.binding ? [split.binding] : []), ...split.rest].map(l => l.id).sort();
      expect(back, `${n} lanes`).toEqual(lanes.map(l => l.id).sort());
    }
  });

  it("agrees with the headroom the server ships, which is the same max()", () => {
    // The server's own line, quoted here so the two cannot drift apart in
    // silence: if that arithmetic ever changes, the row is showing a lane the
    // headroom in its own tooltip is not about.
    expect(server).toMatch(/headroom: lanes\.length \? Math\.max\(0, 100 - Math\.max\(\.\.\.lanes\.map\(l => l\.pct\)\)\) : null/);
    for (const lanes of [[lane("a", 12), lane("b", 88)], [lane("a", 0)], [lane("a", 100), lane("b", 3)]]) {
      const headroom = Math.max(0, 100 - Math.max(...lanes.map(l => l.pct)));
      expect(100 - laneSplit(lanes).binding!.pct).toBe(headroom);
    }
  });
});

describe("what the disclosure says", () => {
  it("says nothing at all when there is nothing behind it", () => {
    expect(moreLabel(0, false)).toBeNull();
    expect(moreLabel(0, true)).toBeNull();
  });

  it("counts what is hidden while it is hidden, and stops counting once it is not", () => {
    expect(moreLabel(1, false)).toBe("1 more");
    expect(moreLabel(4, false)).toBe("4 more");
    // Open, the number is on screen; repeating it in the control would be the
    // panel saying twice what the reader can already see.
    expect(moreLabel(4, true)).toBe("fewer");
  });

  it("leads its sentence with the headroom the panel had never rendered", () => {
    const shut = lanesTitle(19, "5h", 2, false);
    expect(shut).toMatch(/^19% left on 5h/);
    expect(shut).toMatch(/runs out first/);
    expect(shut).toMatch(/Show the other 2 windows\./);
    expect(lanesTitle(19, "5h", 2, true)).toMatch(/Hide the other 2 windows\./);
    // One window reads as one window rather than as "1 windows".
    expect(lanesTitle(50, "7d", 1, false)).toMatch(/Show the other window\./);
    // Rounded, because headroom arrives as a float from a percentage.
    expect(lanesTitle(66.6, "7d", 1, false)).toMatch(/^67% left/);
    // And an account claude-swap has never read says so instead of saying 0%.
    expect(lanesTitle(null, null, 2, false)).toMatch(/^No usage has been collected/);
  });
});

describe("the row renders one lane, and the panel reads the same function", () => {
  it("no longer maps every lane straight into the row", () => {
    expect(panelCode).not.toMatch(/a\.lanes\.map\(l => <LaneBar/);
    expect(panelCode).toMatch(/const \{ binding, rest \} = laneSplit\(a\.lanes\);/);
    expect(panelCode).toMatch(/<LaneBar lane=\{binding\} nowSec=\{nowSec\} \/>/);
    // The rest exist only while the row is open.
    expect(panelCode).toMatch(/\{lanesOpen && rest\.map\(l => <LaneBar key=\{l\.id\} lane=\{l\} nowSec=\{nowSec\} \/>\)\}/);
  });

  it("takes the auto-switch readout from the same place instead of a second Math.max", () => {
    expect(panelCode).toMatch(/const activePct = laneSplit\(activeAcct\?\.lanes \?\? \[\]\)\.binding\?\.pct \?\? null;/);
    expect(panelCode).not.toMatch(/Math\.max\(\.\.\.activeAcct/);
  });

  it("opens every row collapsed, including the active one", () => {
    // Uniform rows are what makes a column scannable, and a default that
    // depended on state would make the panel's resting height depend on which
    // account happens to be live. Measured: 98.59px per block either way.
    expect(panelCode).toMatch(/useState<number\[\]>\(\[\]\)/);
    expect(panelCode).toMatch(/const lanesOpen = openLanes\.includes\(a\.num\);/);
    expect(panelCode).not.toMatch(/openLanes.*a\.active|a\.active.*openLanes/);
  });

  it("points the disclosure at a group that exists in both states", () => {
    // `.ap-more` one row up makes its `aria-controls` conditional, because the
    // manage block it names is not in the document while it is closed and an
    // IDREF resolving to nothing is a dangling pointer rather than a
    // relationship. Here the lane group is always rendered and only its
    // contents change, so the same rule comes out the other way: unconditional.
    expect(panelCode).toMatch(/<div className="ap-lanes" id=\{`ap-lanes-\$\{a\.num\}`\}>/);
    expect(panelCode).toMatch(/aria-controls=\{`ap-lanes-\$\{a\.num\}`\}/);
    expect(panelCode).toMatch(/aria-expanded=\{lanesOpen\}/);
    // …and the conditional one is still conditional, so this is a decision
    // rather than a habit.
    expect(panelCode).toMatch(/aria-controls=\{menuFor === a\.num \? `ap-manage-\$\{a\.num\}` : undefined\}/);
  });

  it("sits in the footer the row already had, and only when it opens something", () => {
    const meta = /<div className="ap-meta">([\s\S]*?)<\/div>\s*\n\s*\{menuFor/.exec(panelCode)![1];
    expect(meta).toMatch(/className="ap-lanes-more"/);
    expect(meta).toMatch(/\{more && \(/);
    expect(panelCode).toMatch(/const more = moreLabel\(rest\.length, lanesOpen\);/);
  });

  it("draws it in the tier the footer already speaks, not as a fourth control language", () => {
    // 9px, no box, a dotted rule under the word — `.ap-rotate`'s language,
    // because both are the reader stating a preference rather than acting on
    // the account. --muted rather than --text-dim so it holds 4.5:1 on the
    // active row as well as on the panel.
    const rule = /\.ap-lanes-more \{([^}]*)\}/.exec(bare)![1];
    expect(rule).toMatch(/font-size:\s*9px/);
    expect(rule).toMatch(/border:\s*none/);
    expect(rule).toMatch(/color:\s*var\(--muted\)/);
    expect(rule).toMatch(/text-decoration:\s*underline dotted/);
  });
});
