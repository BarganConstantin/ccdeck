// Pausing froze the canvas and left the toolbar saying "live", with the green
// dot still pulsing, because the pill was keyed on SSE connectivity alone — and
// pause is bound to Space, which is an easy key to hit by accident on a canvas
// UI. The pill was not wrong on its own terms (pause.ts holds arriving events
// rather than closing the stream, so the connection really is live), but the
// most prominent indicator in the toolbar looked the same whether the board was
// following the work or had stopped repainting it.
//
// The other half was the count: the Resume button read "Resume · 42" with no
// unit, no label and a title that still said "Pause/resume live updates
// (Space)", so the number could as easily have been a queue position, a second
// count or a percentage.
//
// These pin the three-state pill, the precedence between disconnected and
// paused, and the fact that every place the held queue is counted also says
// what it is counting.
//
// The count has since come the whole way in. The button that carried it left
// the topbar for the canvas control stack — it is a canvas verb like the two
// that went in #527, and the only thing that had held it back was the state it
// printed, which is a job a glyph cannot do. It did not have to: the pill had
// been counting the same queue in its title since this file was written, so the
// label says it now and the fact stops being split across two ends of a row.
// What that costs is a box whose width the readouts after it depend on, and the
// cases below are the half of the answer that can be called from node — the
// label, its cap, and the ghost string the pill reserves. The other half is
// geometry and lives in topbar-interaction.test.ts.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  HELD_LABEL_CAP, heldEvents, heldShort, PAUSE_LABEL, pauseTitle, statusPill,
} from "../status-pill";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const src = (rel: string) => readFileSync(join(HERE, "..", rel), "utf8");

describe("the status pill", () => {
  it("says live only while the deck is connected and following the stream", () => {
    const pill = statusPill({ connected: true, paused: false, held: 0 });
    expect(pill.tone).toBe("live");
    expect(pill.label).toBe("live");
    expect(pill.title).toBe("Receiving events");
  });

  it("says paused, not live, once the canvas is frozen", () => {
    const pill = statusPill({ connected: true, paused: true, held: 12 });
    expect(pill.tone).toBe("paused");
    expect(pill.label).toBe("paused · 12");
  });

  it("explains that a paused deck is still connected, and how many events that has held", () => {
    expect(statusPill({ connected: true, paused: true, held: 12 }).title)
      .toBe("Connected — 12 events held until you resume (Space)");
  });

  it("does not count a queue that is empty, since a pause with no traffic held nothing", () => {
    expect(statusPill({ connected: true, paused: true, held: 0 }).title)
      .toBe("Connected — updates held until you resume (Space)");
  });

  it("reports the dead stream ahead of the pause, because resuming cannot fix it", () => {
    const pill = statusPill({ connected: false, paused: true, held: 3 });
    expect(pill.tone).toBe("dead");
    expect(pill.label).toBe("offline");
    expect(pill.title).toContain("SSE disconnected");
    // Still says both: otherwise the user resumes, sees nothing arrive, and
    // has no idea the pause was never the thing stopping it.
    expect(pill.title).toContain("paused");
  });

  it("keeps the offline title short when nothing else is wrong", () => {
    expect(statusPill({ connected: false, paused: false, held: 0 }).title).toBe("SSE disconnected");
  });
});

describe("the slot it is worth (#719)", () => {
  it("does not draw itself while everything is fine", () => {
    // The pill led the readout run and held 49.89px plus a 14px gap for the
    // whole of every session, to report that nothing was wrong. `ambient.ts`
    // refuses to write `(0) ccdeck` for the same reason: a badge that reports
    // nothing is wrong is a badge that gets ignored, and a badge that gets
    // ignored is ignored when it finally has something to say.
    expect(statusPill({ connected: true, paused: false, held: 0 }).resting).toBe(true);
  });

  it("draws itself for both states a reader has to act on", () => {
    // The two the slot was being spent to keep company.
    expect(statusPill({ connected: true, paused: true, held: 12 }).resting).toBe(false);
    expect(statusPill({ connected: true, paused: true, held: 0 }).resting).toBe(false);
    expect(statusPill({ connected: false, paused: false, held: 0 }).resting).toBe(false);
    expect(statusPill({ connected: false, paused: true, held: 4 }).resting).toBe(false);
  });

  it("keeps its words even when it is not drawn", () => {
    // `resting` says this is not worth a slot in the topbar right now. It does
    // not say the state is nameless. A caller that wants to describe the
    // connection anywhere else should get the same three strings from here
    // rather than inventing a second "live" beside this file.
    const pill = statusPill({ connected: true, paused: false, held: 0 });
    expect(pill.label).toBe("live");
    expect(pill.widest).toBe("live");
    expect(pill.title).toBe("Receiving events");
  });

  it("is what App.tsx actually checks, rather than the tone", () => {
    // The rule is "is this state worth a slot", which belongs to status-pill.ts
    // — it already owns the precedence between the flags and the width each
    // tone reserves. A call site testing `tone === "live"` would be a second
    // copy of that rule living in a .tsx the suite cannot import, which is the
    // shape of drift `ambient-counts.ts` exists to prevent one file over.
    const app = src("App.tsx");
    expect(app, "App.tsx no longer skips the pill at rest").toMatch(/if\s*\(\s*pill\.resting\s*\)\s*return null;/);
    expect(app, "App.tsx decides the pill's fate from the tone instead of the field")
      .not.toMatch(/pill\.tone\s*===\s*"live"/);
  });
});

describe("the count, now that the pill is the thing that carries it", () => {
  it("puts the queue in the label and not only in the tooltip", () => {
    // The half that moved. `Resume · 42 held` was printed on a button at the far
    // end of the bar while the pill five hundred pixels to the left said only
    // `paused` — one fact, two elements, and a user reading either one alone
    // getting half of it.
    expect(statusPill({ connected: true, paused: true, held: 42 }).label).toBe("paused · 42");
  });

  it("drops the separator at zero, rather than printing a nought", () => {
    // A pause that has held nothing is not a queue of length zero, it is a
    // queue that has not started. `paused · 0` would be a number asking to be
    // read for having nothing to say. The box does not collapse with it — see
    // `widest` below — so this costs no movement.
    expect(statusPill({ connected: true, paused: true, held: 0 }).label).toBe("paused");
  });

  it("caps the label and never the title, which is the whole of the split", () => {
    // The label sits in a box the readouts after it depend on; a tooltip can be
    // any length it likes. So the pill says "99+" and the sentence says "231
    // events" — the unit that was the other finding this file was written for.
    expect(statusPill({ connected: true, paused: true, held: HELD_LABEL_CAP }).label)
      .toBe(`paused · ${HELD_LABEL_CAP}`);
    expect(statusPill({ connected: true, paused: true, held: HELD_LABEL_CAP + 1 }).label)
      .toBe(`paused · ${HELD_LABEL_CAP}+`);
    expect(statusPill({ connected: true, paused: true, held: 999999 }).label)
      .toBe(`paused · ${HELD_LABEL_CAP}+`);
    expect(statusPill({ connected: true, paused: true, held: 231 }).title).toContain(heldEvents(231));
  });

  it("reserves the widest label its own tone can reach, and nobody else's", () => {
    // Per tone, and that is the decision rather than an implementation detail.
    // The count climbs unbidden and would walk every readout after the pill;
    // the TONE changes because a user pressed Space. Pinning all three to the
    // paused tone's worst case would spend it permanently to still the one
    // transition somebody causes by hand.
    expect(statusPill({ connected: true, paused: false, held: 0 }).widest).toBe("live");
    expect(statusPill({ connected: false, paused: false, held: 0 }).widest).toBe("offline");
    // `paused · full` since #547 gave the tone a fourth label — one glyph past
    // `paused · 99+`, and reserved whether or not THIS pill has overflowed,
    // because a ghost that only appears with the string it is measuring is not
    // reserving anything.
    for (const held of [0, 1, 9, 10, 42, 99, 100, 150, 999, 123456]) {
      expect(statusPill({ connected: true, paused: true, held }).widest).toBe("paused · full");
      expect(statusPill({ connected: true, paused: true, held, dropped: 7 }).widest).toBe("paused · full");
    }
  });

  it("cannot be overrun by any label it will actually render", () => {
    // The ghost has to be an upper bound by CONSTRUCTION, not by measurement —
    // it is shipped to three font stacks. Every paused label is `paused · `
    // plus one of "0".."99" or "99+", and "99+" is "99" with one more glyph on
    // the end, so with tabular figures on the box nothing can be wider. This is
    // that argument as arithmetic.
    const counts = new Set<string>();
    for (const held of [0, 1, 2, 9, 10, 11, 42, 98, 99, 100, 101, 150, 999, 1000, 123456]) {
      const pill = statusPill({ connected: true, paused: true, held });
      expect(pill.label.length, `"${pill.label}" is longer than the box`)
        .toBeLessThanOrEqual(pill.widest.length);
      expect(pill.label.startsWith("paused"), pill.label).toBe(true);
      counts.add(pill.label.replace(/^paused(?: · )?/, ""));
    }
    // Only one form carries three characters where the count goes, and it is
    // the capped one. Everything else is at most two digits.
    expect([...counts].filter(c => c.length > 2)).toEqual([`${HELD_LABEL_CAP}+`]);
    expect(heldShort(HELD_LABEL_CAP + 1)).toBe(`${HELD_LABEL_CAP}+`);
  });

  it("counts one event in the singular, everywhere the queue is named", () => {
    expect(heldEvents(1)).toBe("1 event");
    expect(heldEvents(2)).toBe("2 events");
    expect(heldEvents(0)).toBe("0 events");
    expect(pauseTitle({ paused: true, held: 1 })).toContain("1 event arrived");
    expect(statusPill({ connected: true, paused: true, held: 1 }).title).toContain("1 event held");
  });
});

describe("the pause control, which is a glyph on the canvas now", () => {
  it("keeps the three sentences the button carried, unchanged", () => {
    // #527's rule when it moved Re-arrange and Clear: the strings a user
    // already knows survive the move, and only the box around them changes.
    expect(pauseTitle({ paused: true, held: 42 }))
      .toBe("42 events arrived while paused and will be applied in order when you resume (Space)");
    expect(pauseTitle({ paused: true, held: 0 })).toContain("Nothing has arrived since you paused");
    expect(pauseTitle({ paused: false, held: 0 })).toContain("applied when you resume");
  });

  it("names the key in every one of them, because the key is how it is used", () => {
    for (const paused of [true, false]) {
      for (const held of [0, 7]) expect(pauseTitle({ paused, held })).toContain("(Space)");
    }
  });

  it("does not flip its accessible name, because the state is in aria-pressed", () => {
    // A toggle announces as a name plus a property. "Pause the canvas, toggle
    // button, pressed" is a sentence; "Resume the canvas, toggle button,
    // pressed" is two halves contradicting each other. The name is a constant
    // for exactly that reason, and it is the title that flips.
    expect(PAUSE_LABEL).toBe("Pause the canvas");
    expect(PAUSE_LABEL).not.toMatch(/resume/i);
    expect(pauseTitle({ paused: true, held: 0 })).not.toBe(pauseTitle({ paused: false, held: 0 }));
  });
});
