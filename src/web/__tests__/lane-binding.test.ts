// An account row printed every quota window it had, and a scoped model lane for
// each model on top of that.
//
// Measured in headless Chrome against the real stylesheet, panel at its shipped
// 288px, three accounts each with `5h`, `7d` and one scoped model lane:
//
//   block, inactive        166.69px
//   block, active          160.69px   (a smaller state marker than the switch)
//   three blocks + chrome  665.85px   against 761px of panel on an 813px screen
//   scrolls at             4 accounts
//
// What comes off the resting row is the per-model breakdown, not a window. The
// cut is by KIND, and that is the whole of the design: the account's own
// windows — `5h`, then `7d` — stay, and the `scoped-N` lanes fold. Two earlier
// shapes were tried and both were worse, for reasons this file pins:
//
//   by size  — lead with whatever is fullest. A row whose label changed from
//              `5h` to `7d` when the pressure moved is a row the eye has to
//              re-find on every poll, and a column of accounts is read by shape.
//   by count — keep the first two. Shows a model lane on an account the server
//              had no `7d` reading for, which is a window that does not exist
//              dressed as one that does.
//
// The cut by kind is the only one that gives every account the same resting
// shape today AND the same one tomorrow.
//
// It costs something and the cost is paid explicitly. The lane that decides
// when auto-switch trips is the FULLEST one — `claude-accounts.mjs` ships
// `headroom: 100 - Math.max(...lanes.map(l => l.pct))` with the comment "the
// number that decides whether this account is worth switching to" — and after
// this cut that lane can be one of the folded ones. So `laneSplit` reports
// `peak` (the fullest of all, which is what `headroom` is about) and `fuller`
// (the fullest folded one, but only when it beats everything on show), the
// disclosure wears `fuller` instead of a count, and the auto-switch readout
// takes `peak` rather than a second `Math.max` written out by hand.
//
// This file holds both halves. The pure half is lane-view.ts, swept rather than
// sampled. The other half is read out of the markup, because a pure function
// that is right about lanes it is never handed is the failure mode this repo
// has already shipped once.
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

describe("what the resting row shows", () => {
  it("keeps both of the account's own windows, and folds the model lanes", () => {
    const { shown, rest } = laneSplit([
      lane("five_hour", 12), lane("seven_day", 44), lane("scoped-0", 9), lane("scoped-1", 3),
    ]);
    expect(shown.map(l => l.id)).toEqual(["five_hour", "seven_day"]);
    expect(rest.map(l => l.id)).toEqual(["scoped-0", "scoped-1"]);
  });

  it("cuts by kind, so the numbers never decide what is on the row", () => {
    // The same roster read twenty times with the pressure moving between the
    // windows and the models: the resting row is the same two lanes every time.
    for (let i = 0; i <= 20; i++) {
      const { shown } = laneSplit([
        lane("five_hour", i * 5),
        lane("seven_day", 100 - i * 5),
        lane("scoped-0", (i * 13) % 100),
      ]);
      expect(shown.map(l => l.id), `poll ${i}`).toEqual(["five_hour", "seven_day"]);
    }
  });

  it("shows one window when that is all the server sent, not a model beside it", () => {
    // The case a first-two cut gets wrong: no 7d reading, so a by-count rule
    // would put a model lane in a window's place.
    const { shown, rest } = laneSplit([lane("five_hour", 20), lane("scoped-0", 90)]);
    expect(shown.map(l => l.id)).toEqual(["five_hour"]);
    expect(rest.map(l => l.id)).toEqual(["scoped-0"]);
  });

  it("falls back to the model lanes rather than rendering an empty row", () => {
    // Nothing but scoped lanes is not a shape the server is expected to
    // produce, but an empty row over a full disclosure would be worse than
    // showing them, so the fallback is stated rather than left to chance.
    const { shown, rest } = laneSplit([lane("scoped-0", 4), lane("scoped-1", 8)]);
    expect(shown.map(l => l.id)).toEqual(["scoped-0", "scoped-1"]);
    expect(rest).toEqual([]);
  });

  it("never reorders either half", () => {
    const lanes = [lane("five_hour", 10), lane("seven_day", 90), lane("scoped-0", 55), lane("scoped-1", 70)];
    const { shown, rest } = laneSplit(lanes);
    expect(shown.map(l => l.id)).toEqual(["five_hour", "seven_day"]);
    expect(rest.map(l => l.id)).toEqual(["scoped-0", "scoped-1"]);
  });

  it("names the fullest folded lane, and only when it really is fuller", () => {
    // What the cut costs, and how it is paid back.
    const hot = laneSplit([lane("five_hour", 12), lane("seven_day", 44), lane("scoped-0", 91)]);
    expect(hot.fuller!.id).toBe("scoped-0");
    expect(hot.peak!.id).toBe("scoped-0");

    const calm = laneSplit([lane("five_hour", 12), lane("seven_day", 88), lane("scoped-0", 9)]);
    expect(calm.fuller).toBeNull();
    expect(calm.peak!.id).toBe("seven_day");

    // A tie is not fuller: the row is already showing that number.
    expect(laneSplit([lane("five_hour", 40), lane("scoped-0", 40)]).fuller).toBeNull();
    expect(laneSplit([lane("five_hour", 3)]).fuller).toBeNull();
    expect(laneSplit([]).fuller).toBeNull();
    expect(laneSplit([]).peak).toBeNull();
  });

  it("is total over the lane counts the server can actually produce", () => {
    // Not three, and never was: claude-accounts.mjs builds `5h`, `7d` and one
    // lane per scoped model, dropping any window it has no reading for.
    expect(server).toMatch(/lane\("five_hour", "5h"/);
    expect(server).toMatch(/lane\("seven_day", "7d"/);
    expect(server).toMatch(/\.map\(\(s, i\) => lane\(`scoped-\$\{i\}`/);
    expect(laneSplit([])).toEqual({ shown: [], rest: [], fuller: null, peak: null });
    for (let n = 0; n <= 12; n++) {
      const lanes = [
        lane("five_hour", 11), lane("seven_day", 22),
        ...Array.from({ length: n }, (_, i) => lane(`scoped-${i}`, i * 7 % 100)),
      ];
      const split = laneSplit(lanes);
      expect(split.shown.length, `${n} models`).toBe(2);
      expect(split.rest.length, `${n} models`).toBe(n);
      // Nothing is lost and nothing is duplicated.
      const back = [...split.shown, ...split.rest].map(l => l.id).sort();
      expect(back, `${n} models`).toEqual(lanes.map(l => l.id).sort());
    }
  });

  it("agrees with the headroom the server ships, which is the same max()", () => {
    // The server's own line, quoted here so the two cannot drift apart in
    // silence. `peak` is the lane that arithmetic is about, whether it is one
    // of the two on the row or one of the folded ones.
    expect(server).toMatch(/headroom: lanes\.length \? Math\.max\(0, 100 - Math\.max\(\.\.\.lanes\.map\(l => l\.pct\)\)\) : null/);
    for (const lanes of [
      [lane("five_hour", 12), lane("seven_day", 88)],
      [lane("five_hour", 0)],
      [lane("five_hour", 12), lane("seven_day", 20), lane("scoped-0", 97)],
    ]) {
      const headroom = Math.max(0, 100 - Math.max(...lanes.map(l => l.pct)));
      expect(100 - laneSplit(lanes).peak!.pct).toBe(headroom);
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

  it("wears the hot folded lane instead of the count, which is what the cut costs (#647)", () => {
    // #647: the panel's call site was pinned as `moreLabel(rest.length,
    // lanesOpen, fuller)` and every call in this file passed two arguments, so
    // the branch the header above calls the point of the design was asserted at
    // the call site and executed by nothing. What the header says it does:
    // a row leading with two calm windows over a hidden hot one is the panel
    // lying by omission, so when the fullest lane is a folded one the
    // disclosure says which and how full rather than how many.
    expect(moreLabel(2, false, { label: "scoped-0", pct: 91 })).toBe("scoped-0 91%");
    expect(moreLabel(1, false, { label: "7d", pct: 100 })).toBe("7d 100%");
    // Rounded, and rounded the same way `lanesTitle` rounds its headroom: the
    // percentage arrives as a float and `40.4%` in a 9px footer is noise.
    expect(moreLabel(3, false, { label: "5h", pct: 66.6 })).toBe("5h 67%");
    expect(moreLabel(3, false, { label: "5h", pct: 66.4 })).toBe("5h 66%");
    expect(moreLabel(3, false, { label: "5h", pct: 0.4 })).toBe("5h 0%");
  });

  it("keeps the count in the cases where a fuller lane changes nothing (#647)", () => {
    // The three ways the third argument is present and still not the answer.
    // Absent and null are the same statement — `laneSplit` returns `null` when
    // no folded lane beats the row, and the panel hands that straight over —
    // so both have to produce the count rather than one of them producing
    // `undefined %`.
    expect(moreLabel(4, false, null)).toBe("4 more");
    expect(moreLabel(4, false, undefined)).toBe("4 more");
    expect(moreLabel(4, false)).toBe("4 more");
    // Open wins over it: the number AND the lane are both on screen.
    expect(moreLabel(4, true, { label: "scoped-0", pct: 91 })).toBe("fewer");
    // And nothing behind the control is still nothing to say, however hot the
    // lane handed in claims to be.
    expect(moreLabel(0, false, { label: "scoped-0", pct: 91 })).toBeNull();
  });

  it("takes that argument from laneSplit, the way the panel builds it (#647)", () => {
    // The two halves joined, because a pure function that is right about a
    // `fuller` nothing ever hands it is the failure mode this file's header
    // names. Lanes carry a label here — the panel's `Lane` does, and that is
    // what makes `laneSplit`'s `fuller` assignable to `moreLabel`'s third
    // parameter without anything in between.
    const labelled = (id: string, label: string, pct: number) => ({ id, label, pct });
    const say = (lanes: Array<{ id: string; label: string; pct: number }>, open = false) => {
      const { rest, fuller } = laneSplit(lanes);
      return moreLabel(rest.length, open, fuller);
    };
    // The hot folded lane: the row shows 12% and 44% while a model sits at 91%.
    expect(say([
      labelled("five_hour", "5h", 12), labelled("seven_day", "7d", 44), labelled("scoped-0", "opus", 91),
    ])).toBe("opus 91%");
    // The calm one: nothing folded beats the row, so the count comes back.
    expect(say([
      labelled("five_hour", "5h", 12), labelled("seven_day", "7d", 88),
      labelled("scoped-0", "opus", 9), labelled("scoped-1", "sonnet", 3),
    ])).toBe("2 more");
    // A tie is not fuller — `laneSplit` uses `>` so the row keeps the lane it
    // is already showing — and the control says how many rather than repeating
    // a number already on the row.
    expect(say([
      labelled("five_hour", "5h", 40), labelled("scoped-0", "opus", 40),
    ])).toBe("1 more");
    // Open, from the same split.
    expect(say([
      labelled("five_hour", "5h", 12), labelled("seven_day", "7d", 44), labelled("scoped-0", "opus", 91),
    ], true)).toBe("fewer");
  });

  it("leads its sentence with the headroom the panel had never rendered", () => {
    const shut = lanesTitle(19, "5h", 2, false);
    // The headroom is about the fullest window; the row leads with the first.
    // Since those can now be different lanes, the sentence says both rather
    // than naming one and letting the reader assume it is the other.
    // Names the lane the headroom is about, which after the by-kind cut can be
    // one of the folded ones — so the sentence says which rather than letting
    // the reader assume it is one of the two on the row.
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

describe("the row renders the windows, and the panel reads the same function", () => {
  it("maps the split rather than the whole roster", () => {
    expect(panelCode).not.toMatch(/a\.lanes\.map\(l => <LaneBar/);
    expect(panelCode).toMatch(/const \{ shown, rest, fuller, peak \} = laneSplit\(a\.lanes\);/);
    expect(panelCode).toMatch(/\{shown\.map\(l => <LaneBar key=\{l\.id\} lane=\{l\} nowSec=\{nowSec\} \/>\)\}/);
    // The rest exist only while the row is open.
    expect(panelCode).toMatch(/\{lanesOpen && rest\.map\(l => <LaneBar key=\{l\.id\} lane=\{l\} nowSec=\{nowSec\} \/>\)\}/);
  });

  it("takes the auto-switch readout from the same place instead of a second Math.max", () => {
    expect(panelCode).toMatch(/const activePct = laneSplit\(activeAcct\?\.lanes \?\? \[\]\)\.peak\?\.pct \?\? null;/);
    expect(panelCode).not.toMatch(/Math\.max\(\.\.\.activeAcct/);
  });

  it("opens every row collapsed, including the active one", () => {
    // Uniform rows are what makes a column scannable, and a default that
    // depended on state would make the panel's resting height depend on which
    // account happens to be live. Measured: 98.59px per block either way.
    expect(panelCode).toMatch(/useState<string\[\]>\(\[\]\)/);
    // Keyed by the account rather than by its slot — see lane-open.ts and
    // lane-identity.test.ts. The empty default is what this case is about.
    expect(panelCode).toMatch(/const lanesOpen = openLanes\.includes\(laneKey\(a\)\);/);
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
    expect(panelCode).toMatch(/const more = moreLabel\(rest\.length, lanesOpen, fuller\);/);
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
