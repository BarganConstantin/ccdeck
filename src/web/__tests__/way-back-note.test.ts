// The line that says the address is not the way back.
//
// A deck that has been running for a month is unreachable to anybody who closed
// the tab and lost the scrollback: 127.0.0.1 and four digits is not a string
// people keep. Both routes home already worked and neither was ever said out
// loud — `ccdeck` typed again attaches and opens, and `ccdeck` typed in the
// address bar matches the tab's title out of history.
//
// So the assertions here are mostly about what the note must NOT contain. A
// note that helpfully repeated the port would be teaching the exact thing that
// fails, and it is the kind of "helpful" that gets added back by someone tidying
// six months from now — hence a test that fails there rather than in a user's
// terminal a month after they closed the tab.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { wayBackNote } from "../../server/way-back.mjs";

const DECK = readFileSync(fileURLToPath(new URL("../../../bin/deck.js", import.meta.url)), "utf8");

describe("the way back", () => {
  it("names no port and no address", () => {
    for (const columns of [40, 60, 80, 120, 200]) {
      const note = wayBackNote({ columns });
      expect(note).not.toMatch(/\d{4}/);
      expect(note).not.toMatch(/127\.0\.0\.1|localhost|http/i);
    }
  });

  it("leads with the reassurance, not with an instruction", () => {
    // renameNotice's rule: the reader is not in trouble, and a line that opens
    // with "type this" says they are.
    expect(wayBackNote({ columns: 200 })).toMatch(/^nothing to memorise/);
  });

  it("gives up the reassurance before the command, not after it", () => {
    // A 40-column terminal gets the thing to type and nothing else. The
    // ordering of the ladder is the claim: the behaviour outranks the comfort.
    expect(wayBackNote({ columns: 40 })).toBe("`ccdeck` brings this deck back");
  });

  it("says the whole thing in 80 columns", () => {
    // The width most terminals actually are. A clause that only ever appeared
    // on a maximised window is a clause most users never read, so the widest
    // rung is sized to 80 rather than to how much there is to say.
    expect(wayBackNote({ columns: 80 })).toContain("from any terminal");
  });

  it("names the command that works in this shell", () => {
    expect(wayBackNote({ command: "ccdeck", columns: 200 })).toContain("`ccdeck`");
    // Not the product name: somebody living with the legacy command on their
    // PATH would be handed one they do not have.
    expect(wayBackNote({ command: "agents-deck", columns: 200 }))
      .toContain("`agents-deck` brings this deck back");
  });

  it("keeps the command whole at every width, and never ellipsises", () => {
    for (const columns of [30, 40, 50, 60, 80, 120, 200]) {
      const note = wayBackNote({ columns });
      expect(note).toContain("`ccdeck` brings this deck back");
      expect(note).not.toContain("…");
      expect(note).not.toMatch(/\.\.\./);
    }
  });

  it("drops a clause rather than cutting it in half", () => {
    const wide = wayBackNote({ columns: 200 });
    const middle = wayBackNote({ columns: 60 });
    const narrow = wayBackNote({ columns: 40 });
    expect(wide).toContain("from any terminal");
    expect(middle).not.toContain("terminal");
    // Each rung is a prefix of the one above it: one sentence, fewer clauses.
    expect(wide.startsWith(middle)).toBe(true);
    expect(middle.endsWith(narrow)).toBe(true);
    expect(middle).toMatch(/^nothing to memorise/);
  });

  it("fits the width it was given", () => {
    // 2 of indent, 3 for the glyph and its two spaces, 1 kept back from the
    // edge the way statusLine keeps one. 40 is term-layout.test.ts's narrowest.
    for (const columns of [40, 58, 60, 77, 80, 120, 200]) {
      expect(wayBackNote({ columns }).length + 6).toBeLessThanOrEqual(columns);
    }
  });

  it("takes the caller's dash, so a legacy console gets no em dash", () => {
    expect(wayBackNote({ dash: "-", columns: 200 })).toContain(" - ");
    expect(wayBackNote({ dash: "-", columns: 200 })).not.toContain("—");
  });
});

describe("where bin/deck.js prints it", () => {
  it("prints it on a start", () => {
    expect(DECK).toContain("wayBackNote({");
  });

  it("prints it after the flag warnings, which must stay the last thing said", () => {
    const warn = DECK.indexOf("reportIncompleteFlags(flags.incomplete)");
    const note = DECK.indexOf("wayBackNote({");
    expect(warn).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(warn);
  });

  it("does not print it in the attach branch", () => {
    // Somebody standing there typed `ccdeck` beside a running deck and watched
    // it open — they have just performed the lesson. The attach branch runs
    // from `plan.act === "attach"` to the end of its own block; the note must
    // not be inside it.
    const attach = DECK.indexOf('plan.act === "attach"');
    const noSecond = DECK.indexOf("no second deck was started");
    expect(attach).toBeGreaterThan(-1);
    expect(noSecond).toBeGreaterThan(attach);
    const inAttach = DECK.slice(attach, noSecond);
    expect(inAttach).not.toContain("wayBackNote");
  });
});
