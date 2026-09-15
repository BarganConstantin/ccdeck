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
import { laneSplit } from "../lane-view";

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

// THE DISCLOSURE WORD IS GONE. A shut row used to carry `1 more` / `fewer` in
// its footer, and "1 more" named nothing a reader could picture. A shut row now
// shows its windows plus the hot folded lane when there is one, and the whole
// row is what opens — so what is left to pin is that split and that door.
describe("the row renders the windows, and the panel reads the same function", () => {
  const labelled = (id: string, label: string, pct: number) => ({ id, label, pct });
  /** What a shut row shows, built the way the panel builds it. */
  const quick = (lanes: Array<{ id: string; label: string; pct: number }>) => {
    const { shown, fuller } = laneSplit(lanes);
    return (fuller ? [...shown, fuller] : shown).map(l => l.label);
  };

  it("shuts a row on its windows, plus a folded lane only when it is the fullest (#647)", () => {
    expect(panelCode).toMatch(/const \{ shown, fuller \} = laneSplit\(a\.lanes\);/);
    expect(panelCode).toMatch(/const quick = fuller \? \[\.\.\.shown, fuller\] : shown;/);
    // Two calm windows over a hidden hot one would be the panel lying by
    // omission, so the hot one joins them; a calm folded lane stays folded.
    expect(quick([labelled("five_hour", "5h", 12), labelled("seven_day", "7d", 44), labelled("scoped-0", "opus", 91)]))
      .toEqual(["5h", "7d", "opus"]);
    expect(quick([labelled("five_hour", "5h", 12), labelled("seven_day", "7d", 88), labelled("scoped-0", "opus", 9)]))
      .toEqual(["5h", "7d"]);
    // A tie is not fuller: `laneSplit` uses `>`, so the row keeps what it shows.
    expect(quick([labelled("five_hour", "5h", 40), labelled("scoped-0", "opus", 40)])).toEqual(["5h"]);
  });

  it("opens every window as a bar, in the order the server sent them", () => {
    expect(panelCode).toMatch(/a\.lanes\.map\(l => <LaneBar key=\{l\.id\} lane=\{l\} nowSec=\{nowSec\} frozen=\{frozen\} \/>\)/);
  });

  it("opens the live row, and every other row only when the reader opens it", () => {
    expect(panelCode).toMatch(/useState<string\[\]>\(\[\]\)/);
    expect(panelCode).toMatch(/const open = a\.active \|\| openLanes\.includes\(laneKey\(a\)\);/);
    // The live row has nothing folded, so it has no door.
    expect(panelCode).toMatch(/\{!a\.active && \(\s*<button type="button" className="ap-row-open"/);
  });

  it("points the door at the detail only while the detail exists", () => {
    expect(panelCode).toMatch(/aria-expanded=\{open\}/);
    expect(panelCode).toMatch(/aria-controls=\{open \? `ap-detail-\$\{a\.num\}` : undefined\}/);
    expect(panelCode).toMatch(/<div className="ap-detail" id=\{`ap-detail-\$\{a\.num\}`\}>/);
    // The ⋯ follows the same rule for the same reason.
    expect(panelCode).toMatch(/aria-controls=\{menuFor === a\.num \? `ap-menu-\$\{a\.num\}` : undefined\}/);
  });

  it("no longer counts what is folded: there is no `1 more` to read", () => {
    expect(panelCode).not.toMatch(/moreLabel|lanesTitle|ap-lanes-more/);
    expect(bare).not.toMatch(/\.ap-lanes-more/);
  });
});
