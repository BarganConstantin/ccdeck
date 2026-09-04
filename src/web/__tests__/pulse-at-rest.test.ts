// The line at the bottom of the terminal stops moving when nothing is happening
// (#742).
//
// It alternated green and grey every 800ms for as long as the deck ran. A
// blinking indicator beside a status line is the vocabulary of "working on it",
// so a boot that had finished in a second read as one that never finished —
// which is the complaint this whole issue started as. The deck's own web UI
// retired exactly this once already: the pill goes quiet at rest (#720). The
// terminal never got the same treatment.
//
// What replaces it is not "less animation". It is animation that MEANS
// something: the line moves while a deck cannot be found by its hooks, or while
// a startup job is still running past the boot, and is still otherwise. So
// movement is news, which is the only thing movement should be on a line
// somebody leaves open for hours.
//
// The three pieces are pure functions so the twentieth beat of an idle deck can
// be asked about without waiting sixteen seconds for it.
import { describe, it, expect } from "vitest";

// @ts-expect-error — a plain .mjs module, no types
const { pulseMoves, pulseDot, pulseText, elapsedSuffix, SPINNER_ELAPSED_AFTER_MS } =
  await import("../../server/term.mjs");

describe("when the pulse is allowed to move", () => {
  it("does not, on a deck that is up and has nothing outstanding", () => {
    expect(pulseMoves({ registered: true, claude: true, busy: null })).toBe(false);
  });

  it("does while a startup job is still running past the boot", () => {
    // The claude-swap install the report stopped waiting for. Something IS
    // happening, and the line is the only place left to say so.
    expect(pulseMoves({ registered: true, busy: "installing claude-swap" })).toBe(true);
  });

  it("does while no hook can find this deck", () => {
    // The one genuine alarm. A deck nobody can reach looks exactly like a
    // healthy one otherwise, so this state keeps its blink.
    expect(pulseMoves({ registered: false, claude: true })).toBe(true);
  });

  it("does not for a Codex-only deck, which is not waiting on a hook", () => {
    // startCodexWatcher never consults the discovery file. Blinking an alarm at
    // a deck that is working perfectly is #404 coming back.
    expect(pulseMoves({ registered: false, claude: false })).toBe(false);
  });

  it("treats whitespace as nothing to say", () => {
    for (const busy of [null, undefined, "", "   "]) {
      expect(pulseMoves({ busy: busy as string | null })).toBe(false);
    }
  });
});

describe("the dot", () => {
  it("is lit on every beat of a deck at rest", () => {
    // The whole mechanism. bin/deck.js paints a beat only when the frame
    // differs from what is on screen, so a dot that never changes is a line
    // written once and then left alone — which is what "still" means here.
    const beats = Array.from({ length: 24 }, (_, i) => pulseDot(i, { registered: true }));
    expect(new Set(beats)).toEqual(new Set(["on"]));
  });

  it("alternates while something is outstanding", () => {
    const busy = { registered: true, busy: "installing claude-swap" };
    expect([0, 1, 2, 3, 4].map(b => pulseDot(b, busy))).toEqual(["on", "off", "on", "off", "on"]);
  });

  it("is lit on the beat a job finishes, whichever half of a blink that was", () => {
    // The beat counter keeps running while busy, so a job settling on an odd
    // beat would leave a dimmed dot as the deck's resting state if `at rest`
    // did not win outright. It does.
    expect(pulseDot(7, { registered: true, busy: "installing claude-swap" })).toBe("off");
    expect(pulseDot(7, { registered: true, busy: null })).toBe("on");
  });
});

describe("what the line says", () => {
  const W = 80;

  it("offers Ctrl+C to somebody with nothing left to wait for", () => {
    expect(pulseText({ columns: W })).toContain("Ctrl+C to stop");
  });

  it("names the job instead, while there is one", () => {
    const said = pulseText({ columns: W, busy: "installing claude-swap" });
    expect(said).toContain("installing claude-swap");
    // Not both. "Ctrl+C to stop" is the right thing to say to somebody who is
    // done and the wrong thing to say to somebody watching an install.
    expect(said).not.toContain("Ctrl+C");
  });

  it("pads every variant to one width, because they are drawn over each other", () => {
    // The line is repainted with \r. A shorter message that did not cover the
    // longer one leaves the tail of the last one behind — and these three now
    // follow each other on a single boot, which they did not before: an install
    // starts, the line names it, the install ends and the line goes back to
    // Ctrl+C. The first draft computed the width from whichever message it was
    // rendering, and left "claude-swap" on screen at 40 columns.
    for (const columns of [24, 40, 60, 66, 80, 120, 200]) {
      const widths = new Set([
        pulseText({ columns }).length,
        pulseText({ columns, busy: "installing claude-swap" }).length,
        pulseText({ columns, busy: "setting up claude-swap" }).length,
        pulseText({ columns, registered: false }).length,
      ]);
      expect(widths.size, `columns ${columns}`).toBe(1);
    }
  });

  it("shows the label from 60 columns up, and says nothing untrue below that", () => {
    // A line that wraps is a line \r can only half erase, after which every
    // repaint leaves the first row behind. So on a terminal with no room the
    // label is dropped rather than squeezed — and what is left is the sentence
    // this line has always shown, which is still true while a job runs.
    expect(pulseText({ columns: 60, busy: "installing claude-swap" }))
      .toContain("installing claude-swap");
    const narrow = pulseText({ columns: 40, busy: "installing claude-swap" });
    expect(narrow.length).toBeLessThanOrEqual(40);
    expect(narrow).not.toContain("claude-swap");
    expect(narrow.trim()).toBe("listening — Ctrl+C to stop");
  });
});

describe("a spinner that has been going a while says so", () => {
  it("says nothing at all for the first three seconds", () => {
    // Under that, the number would be on screen for a blink on every ordinary
    // boot: noise, not an answer. Nobody doubts a step that has not yet lasted
    // as long as it takes to doubt one.
    for (const ms of [0, 500, 1_500, 2_999]) expect(elapsedSuffix(ms)).toBe("");
    expect(SPINNER_ELAPSED_AFTER_MS).toBe(3_000);
  });

  it("counts in whole seconds after that", () => {
    // A spinner four seconds in looks exactly like one four hundred
    // milliseconds in, and that is the whole of "is this thing stuck".
    expect(elapsedSuffix(3_000)).toBe("  3s");
    expect(elapsedSuffix(3_999)).toBe("  3s");
    expect(elapsedSuffix(12_400)).toBe("  12s");
  });

  it("never shows a tenth, which would be a second spinner", () => {
    for (let ms = 3_000; ms < 9_000; ms += 137) {
      expect(elapsedSuffix(ms)).toMatch(/^ {2}\d+s$/);
    }
  });
});
