// #711: the two tones were on or off, and a notification you cannot turn down
// is one you eventually turn off.
//
// What shipped is a popover on the topbar speaker holding a switch, two
// volumes, two sound choices and two preview buttons. The first build of this
// issue put one slider in the shortcuts sheet and argued that a rarely-touched
// number does not earn a floating menu on the most-pressed control in the
// topbar. That argument was right and is not being retracted: the feature grew
// past it. Seven controls about one subject is a small panel, and a small panel
// belongs behind the control it configures.
//
// Three things had to survive the move and are pinned here because each is a
// thing a redesign quietly loses:
//
//  - M still toggles. The click opens the menu now, so the keyboard route to
//    silence is the only one-press route left, and it must not have vanished
//    into a popover;
//  - the two tones stay tellable apart by CONTOUR. A choice of sounds is a new
//    way to break #704: a shared catalogue would let both tones be set to the
//    same figure. Two catalogues make that unrepresentable, and the sweeps
//    below check the property rather than the figures that satisfy it today;
//  - the floor stays above zero, the ceiling stays under "well below full
//    scale", every read and write stays wrapped, and every key stays in the
//    `agent-dag.*` namespace.
//
// The set grew from three to six, and the sweeps grew with it rather than
// getting a longer list. Three was argued as a ceiling and was one only inside
// a single dimension: every figure was a sine, and every figure was a sequence
// of single notes, so what had been exhausted was pitch contour under 400ms in
// one timbre. Timbre, texture (two notes at once) and articulation (how long a
// note rings) were all sitting unused and all free. So the distinctness check
// now runs over FIVE axes — count, timbre, texture, rhythm, length — and a
// seventh figure has to differ on one of them to be allowed in.
//
// Register is deliberately not an axis. Two figures that differ only by sitting
// higher or lower make the menu longer without making it more useful, and a
// laptop speaker flattens the difference anyway.
//
// The half no assertion can reach is whether six sounds per tone are actually
// PLEASANT and tellable apart by ear. What can be checked is that each differs
// from every other on a named axis, and that each is carried by the axis its
// name promises — which is what the two sweeps below do, one as a property over
// the set and one figure by figure. The rest was a listening job; the pull
// request says which pair is closest and therefore worth hearing first.
//
// THE POPOVER IS GONE (2026-10-07), with the topbar speaker that opened it.
// Settings › Sounds held everything it did — the switch and each tone's volume
// — one press of the gear away, so the bar carried two doors to the same three
// controls. The three survivals above still hold and are still pinned here: M
// toggles from anywhere, now with no click that disagrees with it; the
// contours; the bounds and the keys. What the popover's own cases pinned — a
// disclosure button, its non-modal dialog, the outside press, its tooltip —
// went with it, and the switch and the volumes are pinned where they live now.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  CHIME_ORDER, clampLevel, DEFAULT_FIGURE_ID, DEFAULT_LEVEL,
  DEFAULT_PREFS, ENVELOPE_FLOOR, figureFor, figureIdFrom, FIGURES, FIGURE_KEYS, FIGURE_SETS,
  GAIN_CEILING, GAIN_FLOOR, gainForLevel, LEVEL_KEYS, levelFrom, LEVEL_MAX,
  LEVEL_MIN, LEVEL_STEP, PEAK_GAIN, peakFor, PREVIEW_DELAY_MS, readPrefs,
  type Chime, type Figure, type Note, type TonePrefs,
} from "../sound";
import { createChimePlayer } from "../chime-player";
import { readStored } from "../storage";
import { KEY_HELP } from "../key-help";
import { withoutComments } from "./tsx-scan";
import { clientText, sourceOf } from "./client-source";
import { soundMenuSurface } from "./sound-menu-surface";
import { sheetText } from "./sheet-source";

const web = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(join(web, rel), "utf8");
/** Comment-stripped, so a paragraph explaining a decision cannot satisfy an
 *  assertion about the code that carries it out (#513). */
// The keydown handler moved to use-deck-shortcuts.ts, the chrome's controls to
// rail-items.tsx and components/EdgeRails.tsx (the topbar's settings run before
// them, 2026-10-08) and the menus' open state to use-settings-menus.ts; the
// keys, the controls and the rest of the deck are read as one.
const chrome = withoutComments(read("rail-items.tsx")) + "\n" + withoutComments(read("components/EdgeRails.tsx"));
const app = withoutComments(read("App.tsx")) + "\n" + withoutComments(read("use-deck-shortcuts.ts"))
  + "\n" + chrome + "\n" + withoutComments(read("use-settings-menus.ts"));
// The tone settings, their write-through and the preview timer moved to
// use-tone-prefs.ts. The cases about them read the whole client — every one of
// them is a positive match, so the wider text cannot make one pass falsely.
// `app` stays those files for the rest, including the one negative case.
const client = clientText();
// The tone groups, the preview note and the custom sounds are Settings ›
// Sounds, SoundsSection.tsx, and since the popover went (2026-10-07) so are the
// switch and the volumes it carried; the switch is SoundSwitch.tsx; and
// Settings mounts the section with its callbacks.
const soundsSection = withoutComments(read("components/SoundsSection.tsx"));
const soundSwitch = withoutComments(read("components/SoundSwitch.tsx"));
const settingsModal = withoutComments(read("components/SettingsModal.tsx"));
// Each tone's row — its preview, volume and sound — moved to ToneSection.tsx,
// and the volume on from there to VolumeRow.tsx.
const toneSection = withoutComments(read("components/ToneSection.tsx"));
const volumeRow = withoutComments(read("components/VolumeRow.tsx"));
// The custom sounds moved to CustomSoundsSection.tsx. The cases about them read
// that file; the negatives read the menu and every file lifted out of it.
const customSounds = withoutComments(read("components/CustomSoundsSection.tsx"));
// And its spoken-voice form moved on again, to SpokenVoiceForm.tsx.
const voiceForm = withoutComments(read("components/SpokenVoiceForm.tsx"));
const menuSurface = withoutComments(soundMenuSurface());
const sheet = withoutComments(read("components/KeyboardHelp.tsx"));
const css = sheetText();

const pitches = (notes: readonly Note[]) => notes.map(n => n.hz);
const ends = (notes: readonly Note[]) => Math.max(...notes.map(n => n.at * 1000 + n.ms));

// The five things that make one figure a different SOUND from another, each
// named so a failure says which axis two figures collapsed onto. `two` and
// `bell` share every pitch they contain and are not the same sound; `arc` and
// `tap` share a note count and are not either.
/** Which waveform, defaulting to the sine everything used before #711. */
const timbre = (f: Figure) => f.type ?? "sine";
/** Two notes starting at the same instant — a dyad rather than a sequence. */
const dyad = (f: Figure) => f.notes.some((n, i) => i > 0 && n.at === f.notes[i - 1].at);
/** A note repeated before the figure moves — a rhythm rather than a melody. */
const repeats = (f: Figure) => f.notes.some((n, i) => i > 0 && n.hz === f.notes[i - 1].hz);
/** End to end, in milliseconds: how long it rings. */
const span = (f: Figure) => ends(f.notes);
/** The whole sound as one comparable string. Pitches alone are not it. */
const signature = (f: Figure) =>
  [timbre(f), f.notes.map(n => `${n.at}:${n.hz}:${n.ms}`).join(","), f.trim ?? 1].join("|");
/** Every level the slider can actually produce, floor to ceiling. */
const TRACK = Array.from(
  { length: (LEVEL_MAX - LEVEL_MIN) / LEVEL_STEP + 1 },
  (_, i) => LEVEL_MIN + i * LEVEL_STEP,
);

// ── the sounds on offer ─────────────────────────────────────────────────────

describe("what a tone can be set to", () => {
  it("offers both tones a set, and the same vocabulary of ids in each", () => {
    expect(CHIME_ORDER).toEqual(["done", "needs-input"]);
    for (const chime of CHIME_ORDER) {
      expect(FIGURE_SETS[chime].length, chime).toBeGreaterThan(1);
    }
    // One vocabulary, so the two menus read as the same three choices rather
    // than as six unrelated ones — and so a user who has learned what "Double
    // tap" means has learned it for both tones.
    const ids = CHIME_ORDER.map(c => FIGURE_SETS[c].map(f => f.id));
    expect(ids[0]).toEqual(ids[1]);
    expect(ids[0]).toContain(DEFAULT_FIGURE_ID);
  });

  it("lists every one of them in the menu, by name", () => {
    // A mutation slicing the select down to its first three survived until this
    // was written: the catalogue was checked and what the MENU does with it was
    // not. A sound the user cannot select is a sound that does not exist, and
    // that gap grows with the list rather than shrinking.
    expect(toneSection).toMatch(/\{FIGURE_SETS\[chime\]\.map\(f => \(/);
    expect(toneSection).toMatch(/<option key=\{f\.id\} value=\{f\.id\}>\{f\.label\}<\/option>/);
    // Nothing between the set and the options — no slice, no filter, no cap.
    const rendered = toneSection.slice(toneSection.indexOf("FIGURE_SETS[chime]"), toneSection.indexOf("</select>"));
    expect(rendered, "the select narrows the set before rendering it").not.toMatch(/slice|filter|splice/);
  });

  it("gives every figure an id and a label that says what you will hear", () => {
    for (const chime of CHIME_ORDER) {
      const set = FIGURE_SETS[chime];
      expect(new Set(set.map(f => f.id)).size, `${chime}: duplicate ids`).toBe(set.length);
      for (const f of set) {
        expect(f.id.trim(), chime).not.toBe("");
        expect(f.label.trim(), f.id).not.toBe("");
        // A label that is the id is not a label. Somebody choosing between
        // three sounds is choosing by the words.
        expect(f.label, f.id).not.toBe(f.id);
      }
    }
  });
});

describe("the contour contract, which a choice of sounds could have broken", () => {
  it("makes every finished-turn sound fall and settle", () => {
    // #704's rule, now asked of a SET rather than of one figure. "Settled" is
    // not merely "the last note is lower than the first": it is that the figure
    // ends on the lowest note it contains, which is what stops a sound from
    // dipping and lifting again at the end.
    for (const f of FIGURE_SETS.done) {
      const hz = pitches(f.notes);
      expect(hz[0], `${f.id} starts below where it ends`).toBeGreaterThan(hz[hz.length - 1]);
      expect(hz[hz.length - 1], `${f.id} does not settle on its lowest note`).toBe(Math.min(...hz));
    }
  });

  it("makes every asking sound rise and stop unresolved", () => {
    for (const f of FIGURE_SETS["needs-input"]) {
      const hz = pitches(f.notes);
      expect(hz[0], `${f.id} starts above where it ends`).toBeLessThan(hz[hz.length - 1]);
      expect(hz[hz.length - 1], `${f.id} does not end on its highest note`).toBe(Math.max(...hz));
    }
  });

  it("makes it impossible to set both tones to the same sound", () => {
    // The hazard a shared catalogue would have introduced, closed by
    // construction rather than by a warning in the menu: no figure offered for
    // one tone is the same sequence of notes as any figure offered for the
    // other, so no combination of settings produces two tones that mean the
    // same thing. This holds for every PAIR, not just for the defaults.
    for (const a of FIGURE_SETS.done) {
      for (const b of FIGURE_SETS["needs-input"]) {
        expect(pitches(a.notes), `${a.id} vs ${b.id}`).not.toEqual(pitches(b.notes));
      }
    }
  });
});

describe("the sounds are tellable apart from each other, not only from the other tone", () => {
  it("gives no two figures in a set the same sound", () => {
    // The SIGNATURE, not the pitch list. `two` and `bell` contain the same two
    // pitches and are a sine and a triangle over different lengths; comparing
    // pitches alone would call them identical and comparing them as sounds does
    // not. That distinction is the whole of why this set can hold six.
    for (const chime of CHIME_ORDER) {
      const sigs = FIGURE_SETS[chime].map(signature);
      expect(new Set(sigs).size, `${chime}: two figures are the same sound`).toBe(sigs.length);
    }
  });

  it("separates every pair on an axis a listener actually uses", () => {
    // Five axes, and a pair has to differ on at least one. Register is
    // deliberately NOT among them: two figures that differ only by being higher
    // or lower are the kind of "choice" that makes a menu longer without making
    // it more useful, and a small speaker flattens the difference anyway.
    //
    // The sweep is what stops a seventh figure arriving as a shade of an
    // existing one — it is a property over the set, not a list of the six.
    for (const chime of CHIME_ORDER) {
      const set = FIGURE_SETS[chime];
      for (let i = 0; i < set.length; i++) {
        for (let j = i + 1; j < set.length; j++) {
          const [a, b] = [set[i], set[j]];
          const axes = {
            count: a.notes.length !== b.notes.length,
            timbre: timbre(a) !== timbre(b),
            texture: dyad(a) !== dyad(b),
            rhythm: repeats(a) !== repeats(b),
            // A fifth that is real but weakest, so it needs a MARGIN rather
            // than any difference at all: 20% of the longer figure.
            length: Math.abs(span(a) - span(b)) / Math.max(span(a), span(b)) >= 0.2,
          };
          const on = Object.entries(axes).filter(([, v]) => v).map(([k]) => k);
          expect(on.length, `${chime}: ${a.id} and ${b.id} vary on nothing`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("says which axis carries each one, so none is only technically different", () => {
    // The design claim per sound, stated so a later edit that quietly makes
    // `tap` a melody or `bell` a sine has to argue with something. Each figure
    // is named here by the axis its NAME promises.
    for (const chime of CHIME_ORDER) {
      const by = (id: string) => FIGURE_SETS[chime].find(f => f.id === id)!;

      // COUNT: two notes, and the sine baseline #704 shipped.
      expect(by("two").notes).toHaveLength(2);
      expect(timbre(by("two"))).toBe("sine");
      expect(dyad(by("two")), "two is a sequence").toBe(false);

      // COUNT and melody: three notes, all different, moving every time.
      expect(by("arc").notes).toHaveLength(3);
      expect(repeats(by("arc")), `${chime}: arc repeats a note`).toBe(false);

      // RHYTHM: three notes like arc, but the first is doubled AND the gaps are
      // uneven. This pair shares a timbre, a note count and a length, so rhythm
      // is all that separates them — and the claim has to be checked rather
      // than asserted in prose, because it was FALSE when it was first written:
      // both figures had evenly spaced onsets, which left them differing by one
      // note's pitch and nothing a bad speaker preserves. Measuring is what
      // found that.
      expect(by("tap").notes).toHaveLength(3);
      expect(repeats(by("tap")), `${chime}: tap does not double a note`).toBe(true);
      expect(by("arc").notes.length).toBe(by("tap").notes.length);
      const gaps = (f: Figure) => f.notes.slice(1).map((n, i) => Math.round((n.at - f.notes[i].at) * 1000));
      const arcGaps = gaps(by("arc")), tapGaps = gaps(by("tap"));
      // `arc` walks evenly; `tap` does not, by at least half again.
      expect(Math.max(...arcGaps) / Math.min(...arcGaps), `${chime}: arc is not even`).toBeLessThan(1.2);
      expect(Math.max(...tapGaps) / Math.min(...tapGaps), `${chime}: tap is evenly spaced, so rhythm separates nothing`)
        .toBeGreaterThan(1.5);

      // TEXTURE: the only figure that sounds two notes at once.
      expect(dyad(by("chord")), `${chime}: chord has no dyad`).toBe(true);
      const withDyad = FIGURE_SETS[chime].filter(dyad).map(f => f.id);
      expect(withDyad, `${chime}: more than one figure is a chord`).toEqual(["chord"]);

      // TIMBRE, and articulation: the only triangle, and the longest thing here.
      expect(timbre(by("bell"))).toBe("triangle");
      expect(span(by("bell"))).toBe(Math.max(...FIGURE_SETS[chime].map(span)));

      // TIMBRE, and articulation the other way: the only square, the shortest,
      // and the only one that needs a loudness trim.
      expect(timbre(by("blip"))).toBe("square");
      expect(span(by("blip"))).toBe(Math.min(...FIGURE_SETS[chime].map(span)));
      expect(by("blip").trim!).toBeLessThan(1);

      // One figure per non-sine waveform, so no two are competing on the same
      // timbre and asking a listener to hear a smaller difference than the set
      // otherwise offers.
      const voices = FIGURE_SETS[chime].map(timbre);
      for (const t of new Set(voices)) {
        if (t === "sine") continue;
        expect(voices.filter(v => v === t).length, `${chime}: two figures are ${t}`).toBe(1);
      }
    }
  });

  it("uses no waveform it cannot vouch for", () => {
    // Sawtooth is the brightest of the four and the one most likely to be
    // unpleasant at notification level. Everything else here was reasoned
    // about; that one could only be guessed at, so it is not offered.
    for (const chime of CHIME_ORDER) {
      for (const f of FIGURE_SETS[chime]) {
        expect(["sine", "triangle", "square"], `${chime}/${f.id}`).toContain(timbre(f));
      }
    }
  });
});

describe("a different sound is not a different volume", () => {
  it("keeps the default figure at exactly the gain the slider asks for", () => {
    // The trim exists to stop a sound change doubling as a volume change. The
    // figure a tab starts on must be untouched by it, or #704's loudness moved.
    for (const chime of CHIME_ORDER) {
      const def = figureFor(chime, DEFAULT_FIGURE_ID);
      expect(def.trim ?? 1).toBe(1);
      for (const level of TRACK) {
        expect(peakFor(level, def), `${chime} at ${level}`).toBe(gainForLevel(level));
      }
    }
  });

  it("trims the waveforms that are louder than a sine at the same peak", () => {
    // RMS at a peak of A: sine 0.707A, triangle 0.577A, square a full A. So a
    // square is the one that has to come down, and it comes down by roughly the
    // ratio — the arithmetic is in the Figure doc, and this is the property.
    for (const chime of CHIME_ORDER) {
      const square = FIGURE_SETS[chime].find(f => timbre(f) === "square")!;
      const sine = figureFor(chime, DEFAULT_FIGURE_ID);
      expect(peakFor(LEVEL_MAX, square)).toBeLessThan(peakFor(LEVEL_MAX, sine));
      expect(peakFor(LEVEL_MAX, square)).toBeGreaterThan(peakFor(LEVEL_MAX, sine) * 0.5);
    }
  });

  it("pays for every voice a figure sounds at once", () => {
    // The defect measurement found and assertion had missed. `peakFor` answers
    // for ONE note; notes that start together SUM, so an untrimmed dyad ramps
    // two oscillators to 0.24 each and puts 0.447 on the destination — nearly
    // double the ceiling, out of a figure every per-note check called legal.
    //
    // Onset-sharing is the thing to count, not overlap in general: `two`'s
    // notes overlap for 5ms at the seam, but one is decaying while the other
    // attacks, so they are never both at peak. Notes at the same `at` are.
    for (const chime of CHIME_ORDER) {
      for (const f of FIGURE_SETS[chime]) {
        const perOnset = new Map<number, number>();
        for (const n of f.notes) perOnset.set(n.at, (perOnset.get(n.at) ?? 0) + 1);
        const voices = Math.max(...perOnset.values());
        // 1/√n is the factor that keeps a figure's ENERGY level with a
        // single-note one; a hair of tolerance for a rounded trim.
        expect(f.trim ?? 1, `${chime}/${f.id} sounds ${voices} at once untrimmed`)
          .toBeLessThanOrEqual(1 / Math.sqrt(voices) + 0.001);
      }
    }
  });

  it("lets no figure at any level exceed the ceiling or reach zero", () => {
    // The band is what a trim must not break. Above the ceiling would be an
    // alarm; zero would be undefined behaviour, because the envelope ramps
    // exponentially and an exponential ramp to zero has no meaning.
    for (const chime of CHIME_ORDER) {
      for (const f of FIGURE_SETS[chime]) {
        for (const level of TRACK) {
          const peak = peakFor(level, f);
          expect(peak, `${chime}/${f.id} at ${level}`).toBeGreaterThan(0);
          expect(peak, `${chime}/${f.id} at ${level}`).toBeLessThanOrEqual(GAIN_CEILING);
        }
      }
    }
  });

  it("refuses a trim that is not a number it can use", () => {
    // The one door to the oscillator, so a hand-edited or future figure cannot
    // drive it out of the band from the other side.
    for (const bad of [NaN, Infinity, -1, 2, undefined]) {
      const peak = peakFor(LEVEL_MAX, { trim: bad as number });
      expect(peak, `trim=${String(bad)}`).toBeGreaterThan(0);
      expect(peak, `trim=${String(bad)}`).toBeLessThanOrEqual(GAIN_CEILING);
    }
    // A trim it CAN use is honoured exactly.
    expect(peakFor(LEVEL_MAX, { trim: 0.5 })).toBe(GAIN_CEILING * 0.5);
  });
});

describe("every figure is still a notification", () => {
  it("is short, is more than one note, and stays inside a speaker's usable band", () => {
    for (const chime of CHIME_ORDER) {
      for (const f of FIGURE_SETS[chime]) {
        expect(f.notes.length, `${chime}/${f.id} note count`).toBeGreaterThan(1);
        // #704's number, now asked of every figure on offer rather than of the
        // two it shipped. Past 400ms a tone stops being a notification and
        // starts being an interruption.
        expect(ends(f.notes), `${chime}/${f.id} runs ${ends(f.notes)}ms`).toBeLessThan(400);
        for (const n of f.notes) {
          // A laptop speaker rolls off below ~300Hz into a click, and a sine
          // above ~1kHz at notification level starts to read as an alarm.
          expect(n.hz, `${chime}/${f.id} note at ${n.hz}Hz`).toBeGreaterThanOrEqual(400);
          expect(n.hz, `${chime}/${f.id} note at ${n.hz}Hz`).toBeLessThanOrEqual(1000);
          expect(n.ms, `${chime}/${f.id} note length`).toBeGreaterThan(0);
        }
        // Two notes a tone apart read as one wobbling note on a laptop
        // speaker, so the figure has to travel. Measured between the EXTREMES
        // rather than between the first two sorted values, because `tap`
        // repeats its opening note and a naive read of that pair is a ratio of
        // 1 — which is what this assertion said before the set grew a figure
        // with a repeat in it.
        const hz = pitches(f.notes);
        expect(new Set(hz).size, `${chime}/${f.id} is one pitch`).toBeGreaterThan(1);
        expect(Math.max(...hz) / Math.min(...hz), `${chime}/${f.id} spread`).toBeGreaterThan(1.4);
        // Notes arrive in the order they are written. This used to require
        // each onset to be strictly LATER than the last, which forbade a chord
        // — and #711's `chord` is exactly a chord, so the rule is now that
        // onsets never go BACKWARDS. A figure may sound two notes at the same
        // instant; what it may not do is schedule note 3 before note 2, which
        // would make the array order a lie about what is heard.
        for (let i = 1; i < f.notes.length; i++) {
          expect(f.notes[i].at, `${chime}/${f.id} note ${i}`).toBeGreaterThanOrEqual(f.notes[i - 1].at);
        }
      }
    }
  });
});

describe("what a tab that never opens the menu hears", () => {
  it("is exactly what #704 shipped", () => {
    expect(DEFAULT_FIGURE_ID).toBe("two");
    expect(FIGURES.done).toEqual(figureFor("done", DEFAULT_FIGURE_ID).notes);
    expect(FIGURES["needs-input"]).toEqual(figureFor("needs-input", DEFAULT_FIGURE_ID).notes);
    expect(pitches(FIGURES.done)).toEqual([740, 440]);
    expect(pitches(FIGURES["needs-input"])).toEqual([440, 740]);
    expect(DEFAULT_PREFS).toEqual({
      done: { level: DEFAULT_LEVEL, figure: DEFAULT_FIGURE_ID },
      "needs-input": { level: DEFAULT_LEVEL, figure: DEFAULT_FIGURE_ID },
    });
  });

  it("falls back to the default for an id that names nothing on offer", () => {
    // An id arrives from a store that is older, newer or hand-edited. Every one
    // of those should leave the deck audible rather than silent or thrown.
    for (const chime of CHIME_ORDER) {
      for (const bad of [null, undefined, "", "nope", "TWO", "Two notes", "__proto__", "constructor"]) {
        expect(figureFor(chime, bad), `${chime}/${String(bad)}`)
          .toEqual(figureFor(chime, DEFAULT_FIGURE_ID));
        expect(figureFor(chime, bad).notes, `${chime}/${String(bad)}`)
          .toEqual(figureFor(chime, DEFAULT_FIGURE_ID).notes);
        expect(figureIdFrom(chime, bad), `${chime}/${String(bad)}`).toBe(DEFAULT_FIGURE_ID);
      }
      // And a real one is kept.
      for (const f of FIGURE_SETS[chime]) {
        expect(figureIdFrom(chime, f.id), f.id).toBe(f.id);
        expect(figureFor(chime, f.id), f.id).toEqual(f);
      }
    }
  });
});

// ── the level, as arithmetic ────────────────────────────────────────────────

describe("a level the slider could actually be at", () => {
  it("leaves every step of the track exactly where it is", () => {
    for (const level of TRACK) expect(clampLevel(level), `${level}`).toBe(level);
    expect(TRACK.length).toBe(21);
  });

  it("snaps a value between two steps to the nearer one", () => {
    expect(clampLevel(52)).toBe(50);
    expect(clampLevel(53)).toBe(55);
    for (let raw = -20; raw <= 120; raw += 0.5) expect(TRACK, `${raw}`).toContain(clampLevel(raw));
  });

  it("holds a value past either end at that end", () => {
    expect(clampLevel(-40)).toBe(LEVEL_MIN);
    expect(clampLevel(400)).toBe(LEVEL_MAX);
    // 103 is the case where the snap runs the wrong way first: it rounds UP to
    // 105, past the end, and the clamp is what brings it back.
    //
    // Worth being honest about what this does NOT pin. Snapping before clamping
    // and clamping before snapping give the same answer for every input,
    // because LEVEL_MAX is a multiple of LEVEL_STEP — a mutation swapping the
    // two survives this file, deliberately and unavoidably. The order is
    // written the way it is so it keeps being right if that ever stops being
    // true; today it is a preference, not a behaviour, and a test claiming
    // otherwise would be claiming to check something it cannot see.
    expect(clampLevel(103)).toBe(LEVEL_MAX);
  });

  it("answers a number that is not one with the default, not with an end", () => {
    for (const bad of [NaN, Infinity, -Infinity]) expect(clampLevel(bad), `${bad}`).toBe(DEFAULT_LEVEL);
  });
});

describe("what one stored level means", () => {
  it("reads a tab that has never been told as the default", () => {
    expect(levelFrom(null)).toBe(DEFAULT_LEVEL);
    expect(levelFrom(undefined)).toBe(DEFAULT_LEVEL);
  });

  it("reads an empty store as the default rather than as the floor", () => {
    // The case a bare `Number()` gets wrong and gets wrong SILENTLY: it reads
    // "" and "   " as 0, which is the bottom of the track — so a store that
    // answered with an empty string would have turned the deck down to its
    // quietest and looked exactly like a setting the user had chosen.
    expect(levelFrom("")).toBe(DEFAULT_LEVEL);
    expect(levelFrom("   ")).toBe(DEFAULT_LEVEL);
  });

  it("refuses every spelling this file never writes", () => {
    // `0x10` would otherwise be 16 and `1e2` would be 100 — a corrupt store
    // would have set the deck to its loudest.
    for (const bad of ["abc", "0x10", "1e2", "Infinity", "NaN", "12abc", "null", "{}", "50%", "+50"]) {
      expect(levelFrom(bad), bad).toBe(DEFAULT_LEVEL);
    }
  });

  it("takes a value this file did write, and snaps and clamps one it did not", () => {
    expect(levelFrom("70")).toBe(70);
    expect(levelFrom(" 70 ")).toBe(70);
    expect(levelFrom("72")).toBe(70);
    expect(levelFrom("-40")).toBe(LEVEL_MIN);
    expect(levelFrom("400")).toBe(LEVEL_MAX);
  });
});

describe("the floor, the ceiling, and the value #704 shipped", () => {
  it("puts the floor above zero, because zero is what the off switch is for", () => {
    expect(GAIN_FLOOR).toBeGreaterThan(0);
    // And a second, harder reason: the envelope ramps EXPONENTIALLY to the
    // peak, and an exponential ramp to zero is undefined in the Web Audio
    // spec. A floor of 0 would not be quiet, it would be unspecified.
    expect(gainForLevel(LEVEL_MIN)).toBeGreaterThan(0);
  });

  it("keeps the ceiling a notification rather than an alarm", () => {
    // #704's own number, asserted as < 0.3 when there was one gain. It has to
    // stay true of the LOUDEST value now reachable, not just of the default.
    expect(GAIN_CEILING).toBeLessThan(0.3);
    for (const level of TRACK) expect(gainForLevel(level), `${level}`).toBeLessThan(0.3);
  });

  it("leaves a tab that never opens the menu hearing exactly what it heard before", () => {
    expect(PEAK_GAIN).toBe(0.14);
    expect(gainForLevel(DEFAULT_LEVEL)).toBe(PEAK_GAIN);
    // Dead centre, which is what makes the slider legible the moment it opens:
    // the value it is already at is the middle of its own travel.
    expect(DEFAULT_LEVEL).toBe((LEVEL_MIN + LEVEL_MAX) / 2);
    expect(PEAK_GAIN).toBe(Math.round(((GAIN_FLOOR + GAIN_CEILING) / 2) * 10_000) / 10_000);
  });

  it("gives the two ends the floor and the ceiling exactly, and never leaves the band", () => {
    expect(gainForLevel(LEVEL_MIN)).toBe(GAIN_FLOOR);
    expect(gainForLevel(LEVEL_MAX)).toBe(GAIN_CEILING);
    // Nothing a caller can pass — a corrupt store, a hand-edited value, an
    // arithmetic slip — can make the deck loud or make it silent.
    for (const raw of [-1e9, -40, -0.5, 0, 33.3, 50, 99.9, 400, 1e9, NaN, Infinity, -Infinity]) {
      expect(gainForLevel(raw), `${raw}`).toBeGreaterThanOrEqual(GAIN_FLOOR);
      expect(gainForLevel(raw), `${raw}`).toBeLessThanOrEqual(GAIN_CEILING);
    }
  });

  it("gets louder every step, by an audible and equal amount", () => {
    // The step is an accessibility number: at 1 it is fifty arrow presses to
    // cross half the track. At 5 it is ten, and each press is 0.01 of gain.
    expect(LEVEL_STEP).toBe(5);
    for (let i = 1; i < TRACK.length; i++) {
      const jump = gainForLevel(TRACK[i]) - gainForLevel(TRACK[i - 1]);
      expect(Math.round(jump * 10_000) / 10_000, `${TRACK[i - 1]} → ${TRACK[i]}`).toBe(0.01);
    }
  });

  it("spans far enough to be worth having, and not so far it is a different feature", () => {
    // Floor to ceiling is a factor of six in amplitude — about 15.6 dB. Enough
    // that "turn it down" is a real answer rather than a placebo; short of the
    // 60 dB a media player covers, which this is not.
    const span = GAIN_CEILING / GAIN_FLOOR;
    expect(span).toBeGreaterThan(4);
    expect(span).toBeLessThan(10);
    // The complaint the issue was filed about is "too loud", so the room BELOW
    // the default is the room that matters most.
    expect(GAIN_FLOOR).toBeLessThan(PEAK_GAIN / 2);
  });
});

// ── the round trip, one tone at a time ──────────────────────────────────────

/** A store that answers from a map, the way a browser's would. */
const storeOf = (entries: Record<string, string>) => (key: string) =>
  Object.hasOwn(entries, key) ? entries[key] : null;

describe("both tones' settings, read back", () => {
  it("gives a fresh profile the defaults", () => {
    expect(readPrefs(storeOf({}))).toEqual(DEFAULT_PREFS);
  });

  it("keeps the four settings independent of each other", () => {
    // The whole reason there are four keys rather than one JSON blob: a value
    // that fails to parse takes down only itself. Here every one of the four is
    // corrupted in turn, and the other three have to survive it.
    const good: Record<string, string> = {
      [LEVEL_KEYS.done]: "25",
      [LEVEL_KEYS["needs-input"]]: "75",
      [FIGURE_KEYS.done]: "arc",
      [FIGURE_KEYS["needs-input"]]: "tap",
    };
    expect(readPrefs(storeOf(good))).toEqual({
      done: { level: 25, figure: "arc" },
      "needs-input": { level: 75, figure: "tap" },
    });
    for (const key of Object.values({ ...LEVEL_KEYS, ...FIGURE_KEYS })) {
      const wrecked = readPrefs(storeOf({ ...good, [key]: "$$$" }));
      const intact = readPrefs(storeOf(good));
      let differences = 0;
      for (const chime of CHIME_ORDER) {
        if (wrecked[chime].level !== intact[chime].level) differences++;
        if (wrecked[chime].figure !== intact[chime].figure) differences++;
      }
      expect(differences, `${key} took more than itself down`).toBe(1);
    }
  });

  it("round-trips every level and every figure the menu can produce", () => {
    // What App writes is what the next boot reads, so the stored settings and
    // the controls showing them can never disagree.
    for (const chime of CHIME_ORDER) {
      for (const level of TRACK) {
        for (const f of FIGURE_SETS[chime]) {
          const back = readPrefs(storeOf({
            [LEVEL_KEYS[chime]]: String(level),
            [FIGURE_KEYS[chime]]: f.id,
          }));
          expect(back[chime], `${chime} ${level} ${f.id}`).toEqual({ level, figure: f.id });
        }
      }
    }
  });

  it("gives the deck its defaults when the store is blocked entirely", () => {
    // A private window, or a browser set to block site data, throws out of the
    // `localStorage` GETTER — and App reads this in a useState initialiser,
    // where storage-blocked.test.ts says a throw takes the whole deck down.
    const glob = globalThis as unknown as Record<string, unknown>;
    const had = "window" in glob;
    glob.window = Object.defineProperty({}, "localStorage", {
      configurable: true,
      get() { throw new Error("SecurityError: The operation is insecure."); },
    });
    try {
      expect(() => readPrefs(readStored)).not.toThrow();
      expect(readPrefs(readStored)).toEqual(DEFAULT_PREFS);
    } finally {
      if (!had) delete glob.window;
    }
  });

  it("keeps all four keys inside the namespace every browser key in this client lives in", () => {
    // display-name.test.ts sweeps this too; naming them here is what says the
    // prefix is a decision of #711's rather than an accident of spelling.
    expect(LEVEL_KEYS).toEqual({
      done: "agent-dag.soundLevel.done",
      "needs-input": "agent-dag.soundLevel.needs-input",
    });
    expect(FIGURE_KEYS).toEqual({
      done: "agent-dag.soundFigure.done",
      "needs-input": "agent-dag.soundFigure.needs-input",
    });
    const all = [...Object.values(LEVEL_KEYS), ...Object.values(FIGURE_KEYS)];
    expect(new Set(all).size, "two settings share a key").toBe(4);
    for (const k of all) expect(k.startsWith("agent-dag."), k).toBe(true);
  });
});

// ── the player ──────────────────────────────────────────────────────────────

/** The smallest AudioContext that answers what the player asks of it, plus the
 *  one thing #704's stub threw away: the target of each gain ramp. */
function fakeAudio() {
  const peaks: number[] = [];
  const started: number[] = [];
  const voices: string[] = [];
  class Ctx {
    state: "suspended" | "running" = "suspended";
    currentTime = 0;
    destination = {} as AudioNode;
    resume() { this.state = "running"; return Promise.resolve(); }
    createOscillator() {
      const node = {
        type: "", frequency: { value: 0 },
        connect: (n: unknown) => n,
        // The WAVEFORM is recorded as well as the pitch. It was not, and a
        // mutation pinning `osc.type = "sine"` survived the whole file: the
        // catalogue's timbres were asserted as data and never as sound.
        start() { started.push(node.frequency.value); voices.push(node.type); },
        stop() {},
      };
      return node as unknown as OscillatorNode;
    }
    createGain() {
      return {
        gain: {
          setValueAtTime() {},
          exponentialRampToValueAtTime(target: number) { if (target > ENVELOPE_FLOOR) peaks.push(target); },
        },
        connect: (n: unknown) => n,
      } as unknown as GainNode;
    }
  }
  return { Ctx: Ctx as unknown as typeof AudioContext, peaks, started, voices };
}

const prefsOf = (done: [number, string], asking: [number, string]): TonePrefs => ({
  done: { level: done[0], figure: done[1] },
  "needs-input": { level: asking[0], figure: asking[1] },
});

describe("the player plays each tone as that tone is set", () => {
  it("uses the level and the figure of the tone being played, not the other one's", () => {
    // The defect a per-tone setting invites: reading one tone's volume and the
    // other's notes. Set them to opposite ends and check both come back right.
    const { Ctx, peaks, started } = fakeAudio();
    const p = createChimePlayer({
      enabled: () => true,
      prefs: () => prefsOf([LEVEL_MIN, "arc"], [LEVEL_MAX, "tap"]),
      ctor: Ctx,
    });
    p.unlock();

    expect(p.play("done")).toBe(true);
    expect(started).toEqual(pitches(figureFor("done", "arc").notes));
    expect(peaks).toEqual(figureFor("done", "arc").notes.map(() => GAIN_FLOOR));

    started.length = 0; peaks.length = 0;
    expect(p.play("needs-input")).toBe(true);
    expect(started).toEqual(pitches(figureFor("needs-input", "tap").notes));
    expect(peaks).toEqual(figureFor("needs-input", "tap").notes.map(() => GAIN_CEILING));
  });

  it("plays each figure in its own voice, and at its own trimmed loudness", () => {
    // Both halves survived a mutation before they were written here. The
    // catalogue's timbres were asserted as DATA and never as sound, so pinning
    // `osc.type = "sine"` in the player passed the whole file; and every figure
    // the player cases used had a trim of 1, so dropping `peakFor` for
    // `gainForLevel` was invisible. A set of six that the player flattens back
    // to one sine at one loudness is not a set of six.
    for (const chime of CHIME_ORDER) {
      for (const f of FIGURE_SETS[chime]) {
        const { Ctx, peaks, started, voices } = fakeAudio();
        const p = createChimePlayer({
          enabled: () => true,
          prefs: () => prefsOf([LEVEL_MAX, f.id], [LEVEL_MAX, f.id]),
          ctor: Ctx,
        });
        p.unlock();
        expect(p.play(chime), `${chime}/${f.id}`).toBe(true);
        expect(started, `${chime}/${f.id} notes`).toEqual(pitches(f.notes));
        // One oscillator per note, every one of them the figure's waveform.
        expect(voices, `${chime}/${f.id} waveform`).toEqual(f.notes.map(() => timbre(f)));
        // And the trim is on the gain, not merely declared on the figure.
        expect(peaks, `${chime}/${f.id} peak`).toEqual(f.notes.map(() => peakFor(LEVEL_MAX, f)));
      }
    }
    // Vacuity guard: at least one figure must actually be trimmed and at least
    // one must not be a sine, or the two assertions above prove nothing.
    const all = CHIME_ORDER.flatMap(c => FIGURE_SETS[c]);
    expect(all.filter(f => (f.trim ?? 1) < 1).length).toBeGreaterThan(0);
    expect(all.filter(f => timbre(f) !== "sine").length).toBeGreaterThan(0);
  });

  it("reads the settings at play time, so changing one changes the next tone", () => {
    // The reason it is a getter and not a value: the player is built once, on
    // mount, and the settings move under it for the life of the tab.
    const { Ctx, peaks, started } = fakeAudio();
    let prefs = prefsOf([LEVEL_MIN, "two"], [DEFAULT_LEVEL, "two"]);
    const p = createChimePlayer({ enabled: () => true, prefs: () => prefs, ctor: Ctx });
    p.unlock();
    p.play("done");
    prefs = prefsOf([LEVEL_MAX, "tap"], [DEFAULT_LEVEL, "two"]);
    started.length = 0; peaks.length = 0;
    p.play("done");
    expect(started).toEqual(pitches(figureFor("done", "tap").notes));
    expect(new Set(peaks)).toEqual(new Set([GAIN_CEILING]));
  });

  it("falls back to what #704 shipped when nobody hands it any settings", () => {
    const { Ctx, peaks, started } = fakeAudio();
    const p = createChimePlayer({ enabled: () => true, ctor: Ctx });
    p.unlock();
    p.play("needs-input");
    expect(started).toEqual(pitches(FIGURES["needs-input"]));
    expect(peaks).toEqual(FIGURES["needs-input"].map(() => PEAK_GAIN));
  });

  it("stays audible and in band on settings it cannot make sense of", () => {
    const { Ctx, peaks, started } = fakeAudio();
    const p = createChimePlayer({
      enabled: () => true,
      prefs: () => prefsOf([NaN, "nonsense"], [NaN, "nonsense"]),
      ctor: Ctx,
    });
    p.unlock();
    expect(p.play("done")).toBe(true);
    expect(started).toEqual(pitches(FIGURES.done));
    expect(peaks.every(g => g >= GAIN_FLOOR && g <= GAIN_CEILING)).toBe(true);
  });
});

describe("the one press allowed past the switch", () => {
  it("is silent for the deck's own tones while the switch is off, as it always was", () => {
    const { Ctx, started } = fakeAudio();
    const p = createChimePlayer({ enabled: () => false, ctor: Ctx });
    p.unlock();
    expect(p.play("done")).toBe(false);
    expect(started).toHaveLength(0);
  });

  it("plays for the preview, because that press IS the request to hear it", () => {
    // Refusing here would leave the menu silent in exactly the state the person
    // it was built for is in: somebody who turned the sound off BECAUSE it was
    // too loud and has opened the menu to turn it down instead.
    const { Ctx, started } = fakeAudio();
    const p = createChimePlayer({
      enabled: () => false,
      prefs: () => prefsOf([LEVEL_MAX, "arc"], [LEVEL_MAX, "arc"]),
      ctor: Ctx,
    });
    p.unlock();
    expect(p.play("done", true)).toBe(true);
    // And it previews the CHOSEN sound, which is the whole point of a preview.
    expect(started).toEqual(pitches(figureFor("done", "arc").notes));
  });

  it("does not waive the browser's own lock with it", () => {
    // The switch is the deck's rule and an audition may overrule it. Autoplay
    // policy is the browser's and nothing here can: a tab nobody has touched is
    // silent whatever this flag says.
    const { Ctx, started } = fakeAudio();
    const p = createChimePlayer({ enabled: () => true, ctor: Ctx });
    expect(p.state()).toBe("locked");
    expect(p.play("done", true)).toBe(false);
    expect(started).toHaveLength(0);
  });
});

// ── the shape, held to the source ───────────────────────────────────────────

describe("M silences the deck from anywhere, and the switch is in Settings › Sounds", () => {
  it("draws no speaker on the topbar, and V opens Settings at Sounds instead", () => {
    // The speaker's popover held the switch and the two volumes, and Settings ›
    // Sounds holds both (below), so the bar lost a door rather than a control.
    // The key that opened the popover opens the section, through the gear's
    // own door.
    // Not on the bar, and not on the edges or in the dock either: the eight
    // controls of the chrome are the whole list, and none of them is a speaker.
    expect(chrome).not.toMatch(/Sound settings|SoundMenu|soundMenuOpen|setSoundMenuOpen|SpeakerGlyph/);
    expect(chrome).not.toContain('d="M3.2 5.2h2L7.8 3v8L5.2 8.8h-2z"');
    expect(app).not.toMatch(/setSoundMenuOpen|soundButtonRef/);
    expect(app).toMatch(/if \(e\.key === "v" \|\| e\.key === "V"\) openSettings\("sounds"\);/);
  });

  it("keeps M on the toggle, the one-press route to silence", () => {
    // The half a redesign loses quietly. Guarded only by the state the switch
    // waits for — the stored flag read back.
    expect(app).toMatch(/if \(e\.key === "m" \|\| e\.key === "M"\) \{\s*if \(soundOnRef\.current !== null\) activateSoundRef\.current\(e\.shiftKey\);/);
    // And the sheet says so, in the words a user reads.
    const rows = KEY_HELP.flatMap(g => g.rows);
    expect(rows.find(r => /^m$/i.test(r.cap))!.action).toMatch(/sound on or off/);
    // The click that disagreed with M — it opened a menu where M toggled — is
    // gone with the speaker, and so is the sheet's row that wrote the
    // divergence down.
    expect(rows.some(r => /speaker/i.test(r.action))).toBe(false);
  });

  it("gives the mouse the switch in Settings › Sounds, through the same door", () => {
    expect(soundsSection).toMatch(/<SoundSwitch soundOn=\{soundOn\} onToggleSound=\{onToggleSound\} \/>/);
    expect(settingsModal).toMatch(/onToggleSound=\{toggleSound\}/);
    expect(soundSwitch).toMatch(/onClick=\{onToggleSound\}/);
    // A real switch, not a word in a box. `on` sat in the same right-hand slot
    // and the same accent the deck gives figures it REPORTS, so the one control
    // at the top of this menu read as a readout — see toggle-state.test.ts.
    expect(soundSwitch).toMatch(/role="switch"[\s\S]{0,60}aria-checked=\{soundOn\}/);
    // And each tone's volume beside it, the other thing the popover carried.
    expect(soundsSection).toMatch(/\{CHIME_ORDER\.map\(chime => \(\s*<ToneSection/);
    expect(toneSection).toMatch(/<VolumeRow\b/);
  });

  it("leaves everything below the master switch live, and says why the preview still sounds", () => {
    // The master switch governs PLAYBACK, not configurability. Dimming or
    // disabling the two tone groups while Sounds is off closes the one road
    // this menu exists for: somebody silenced the deck because it was too loud
    // and came here to turn the volume down before switching it back on.
    //
    // WHAT THIS CAN AND CANNOT CHECK. The guarantee is behavioural — the
    // slider, the select and the preview stay operable, at full opacity, with
    // no aria-disabled — and there is no DOM in this suite to read any of that
    // from. So the check is scoped to the region the guarantee is about rather
    // than banned across the file: inside `.sm-tones`, nothing is keyed on
    // `soundOn` and nothing is disabled or dimmed. A later, legitimate use of
    // `soundOn` anywhere else in this component is untouched by this; a use
    // INSIDE the tone groups is exactly the thing worth stopping to look at.
    //
    // The tone groups are ToneSection.tsx now, rendered once per tone inside
    // `.sm-tones`; the menu's own slice holds the loop that renders them and
    // hands each the switch, and the row's markup holds the rest.
    const tones = soundsSection.slice(soundsSection.indexOf('<div className="sm-tones">'));
    const inside = tones.slice(0, tones.lastIndexOf("</div>"));
    expect(inside).toContain("<ToneSection");                // the right slice
    expect(inside, "a control below the master switch was disabled").not.toMatch(/\bdisabled\b/);
    expect(inside, "a control below the master switch was dimmed").not.toMatch(/\bopacity\b/);
    // The menu passes the switch on and does nothing else with it there.
    expect(inside.replace("soundOn={soundOn}", "")).not.toMatch(/\bsoundOn\b/);
    const row = toneSection.slice(toneSection.indexOf("  return ("));
    expect(row).toContain("TONE_NOTE[chime]");               // the right slice
    expect(row, "a control below the master switch was disabled").not.toMatch(/\bdisabled\b/);
    expect(row, "a control below the master switch was dimmed").not.toMatch(/\bopacity\b/);
    // The volume slider left the row for VolumeRow.tsx, and is held to the same
    // two there.
    const volume = volumeRow.slice(volumeRow.indexOf("  return ("));
    expect(row).toContain("<VolumeRow");                     // the row still draws it
    expect(volume).toContain('type="range"');                 // the right slice
    expect(volume, "the volume slider was disabled").not.toMatch(/\bdisabled\b/);
    expect(volume, "the volume slider was dimmed").not.toMatch(/\bopacity\b/);
    expect(volume).not.toMatch(/\bsoundOn\b/);
    // Two uses of `soundOn` in there, and they are the sentence rather than a
    // state: the tooltip and the description that says the preview will sound.
    expect([...row.matchAll(/\bsoundOn\b/g)]).toHaveLength(2);
    expect(row).toMatch(/title=\{soundOn\n\s+\? "Play this tone now, at what it is set to"/);
    expect(row).toMatch(/: "Plays even when sounds are off"\}/);
    expect(row).toMatch(/aria-describedby=\{soundOn \? undefined : "sm-preview-note"\}/);
    // The slice above ran to the menu's last </div>, so it also held the custom
    // sounds, which moved to CustomSoundsSection.tsx. Their markup is held to the
    // same three there.
    const custom = customSounds.slice(customSounds.indexOf("  return ("));
    expect(custom).toContain('<section className="sm-custom"');   // the right slice
    expect(custom, "a custom-sound control was disabled").not.toMatch(/\bdisabled\b/);
    expect(custom, "a custom-sound control was dimmed").not.toMatch(/\bopacity\b/);
    expect(custom).not.toMatch(/\bsoundOn\b/);
    // The voice form was inside that markup too, until it moved on again.
    const voice = voiceForm.slice(voiceForm.indexOf("  return ("));
    expect(voice).toContain('<details className="sm-voice">');     // the right slice
    expect(voice, "a voice-form control was disabled").not.toMatch(/\bdisabled\b/);
    expect(voice, "a voice-form control was dimmed").not.toMatch(/\bopacity\b/);
    expect(voice).not.toMatch(/\bsoundOn\b/);
  });

  it("gives the tooltip the exception and the description the reason", () => {
    // Different lengths on purpose. A tooltip appears over the control and is
    // read in the half-second before a press, so it states the exception and
    // stops; the description is read in sequence by somebody who cannot see the
    // switch above it, and carries why the exception is useful.
    // The switch was "Sounds" until Settings headed its section "Sounds" right
    // above it; it says "Play sounds" now, so the exception names the state the
    // switch leaves, not the switch's old word.
    const tip = toneSection.match(/: "(Plays even when sounds are off[^"]*)"\}/)![1];
    const said = soundsSection.match(/<span id="sm-preview-note" className="vis-hidden">\s*([^<]+)/)![1].trim();
    expect(tip).toBe("Plays even when sounds are off");
    expect(said.length).toBeGreaterThan(tip.length);
    expect(said).toContain("before turning sounds back on");
    // And neither exists while the sound is on, where the sentence is noise —
    // the description's node included, so the IDREF is never dangling.
    expect(soundsSection).toMatch(/\{!soundOn && \(/);
    expect(css).toMatch(/\.vis-hidden/);
  });

  it("took the volume out of the shortcuts sheet it briefly lived in", () => {
    // The first build of #711 put a slider there. Leaving it would give the
    // deck two homes for one setting, which is worse than either.
    expect(sheet).not.toMatch(/type="range"/);
    expect(sheet).not.toMatch(/soundLevel|kh-volume/);
    expect(css).not.toMatch(/\.kh-volume|\.kh-sound/);
  });
});

describe("Settings › Sounds, which is all of the menu now", () => {
  it("disables nothing, and refuses at the ceiling without taking the control away (#620)", () => {
    // The one refusal the section does make — no more custom sounds at the
    // ceiling (#1207) — is aria-disabled, which leaves the control focusable,
    // and is the only spelling of the word allowed here.
    expect(customSounds).toMatch(/"aria-disabled": true/);
    expect(menuSurface.replace(/"aria-disabled"/g, "")).not.toMatch(/disabled/);
  });

  it("is not remembered across a reload, because an open dialog is not a setting", () => {
    const door = withoutComments(read("use-settings-menus.ts"));
    expect(door).toMatch(/const \[settings, setSettings\] = useState<SettingsDoor>\(SETTINGS_CLOSED\);/);
    expect(door).not.toMatch(/localStorage|writeStored|readStored/);
  });
});

describe("hearing it is the point, not a nicety", () => {
  it("gives each tone its own preview, and auditions rather than reports", () => {
    // Two buttons, one per tone, each playing THAT tone.
    expect(toneSection).toMatch(/onClick=\{\(\) => onPreview\(chime\)\}/);
    expect(toneSection).toMatch(/aria-label=\{`Hear the \$\{TONE_LABEL\[chime\]\.toLowerCase\(\)\} tone`\}/);
    expect(client).toMatch(/onPreview=\{chime => previewTone\(chime\)\}/);
    expect(client).toMatch(/chimesRef\.current\?\.play\(chime, true\)/);
  });

  it("answers a press at once and a drag after it settles", () => {
    // The distinction that makes both usable: a slider crossing a dozen steps
    // must collapse to one figure, and a deliberate press must not feel laggy.
    expect(client).toMatch(/if \(!soon\) \{ chimesRef\.current\?\.play\(chime, true\); return; \}/);
    expect(client).toMatch(/previewRef\.current = setTimeout\(/);
    expect(client).toMatch(/\}, PREVIEW_DELAY_MS\);/);
    // A pending debounce is cancelled before either path runs, so a press and a
    // drag can never overlap into two figures at once.
    expect(client).toMatch(/if \(previewRef\.current !== null\) clearTimeout\(previewRef\.current\);\n\s*previewRef\.current = null;/);
    expect(PREVIEW_DELAY_MS).toBeGreaterThan(80);
    expect(PREVIEW_DELAY_MS).toBeLessThan(200);
    // Shorter than the figure it plays, so a settled change is heard before the
    // next one could be scheduled.
    expect(PREVIEW_DELAY_MS).toBeLessThan(ends(FIGURES.done));
  });

  it("plays the tone back whenever a setting of that tone changes", () => {
    // Not just the slider: picking a sound you cannot hear is the same guess as
    // setting a level in silence.
    expect(client).toMatch(/previewTone\(chime, true\);/);
    expect(client).toMatch(/onLevel=\{\(chime, level\) => changeTone\(chime, \{ level \}\)\}/);
    expect(client).toMatch(/onFigure=\{\(chime, figure\) => changeTone\(chime, \{ figure \}\)\}/);
  });

  it("unlocks before it asks, because this may be the tab's first gesture", () => {
    expect(client).toMatch(/chimesRef\.current\?\.unlock\(\);\n\s*if \(previewRef\.current !== null\)/);
  });

  it("does not leave a timer running past the tab", () => {
    expect(client).toMatch(/useEffect\(\(\) => \(\) => \{ if \(previewRef\.current !== null\) clearTimeout\(previewRef\.current\); \}, \[\]\);/);
  });
});

describe("App owns the settings, the write and the round trip", () => {
  it("reads them back through the wrapped read, in an initialiser that must not throw", () => {
    expect(client).toMatch(/useState<TonePrefs>\(\(\) => readPrefs\(readStored\)\)/);
  });

  it("writes both of a tone's settings, checked, under the namespaced keys", () => {
    expect(client).toMatch(/level: clampLevel\(patch\.level \?\? prev\[chime\]\.level\)/);
    expect(client).toMatch(/figure: figureIdFrom\(chime, patch\.figure \?\? prev\[chime\]\.figure\)/);
    expect(client).toMatch(/writeStored\(LEVEL_KEYS\[chime\], String\(next\.level\)\)/);
    expect(client).toMatch(/writeStored\(FIGURE_KEYS\[chime\], next\.figure\)/);
    // Wrapped, like every other preference here: a blocked store costs the
    // setting and nothing else. writeStored is the wrapped write —
    // storage-blocked.test.ts drives it under a getter that throws.
    expect(sourceOf("use-tone-prefs.ts")).toMatch(/import \{[^}]*\bwriteStored\b[^}]*\} from "\.\/storage";/);
  });

  it("hands the player the settings through a ref, the way it hands it the flag", () => {
    expect(client).toMatch(/prefs: \(\) => tonePrefsRef\.current,/);
    expect(client).toMatch(/enabled: \(\) => soundOnRef\.current === true,/);
    // The mirror is `useMirroredRef` now — same fact, named: the ref holds the
    // current settings so the player, built once on mount, reads them at play time.
    expect(client).toMatch(/const tonePrefsRef = useMirroredRef\(tonePrefs\);/);
  });

  it("gives the menu everything it needs and nothing it does not", () => {
    // Settings › Sounds is mounted by SettingsModal with the hooks App owns;
    // the topbar run hands it nothing since the popover went.
    expect(withoutComments(read("App.tsx"))).not.toMatch(/<SettingsRun\b[^>]*\b(?:sound|tones)=/);
    for (const prop of [
      /soundOn=\{soundOn === true\}/, /onToggleSound=\{toggleSound\}/, /prefs=\{tonePrefs\}/,
      /onLevel=/, /onFigure=/, /onPreview=/,
    ]) {
      expect(settingsModal, String(prop)).toMatch(prop);
    }
    // The menu writes nothing itself: every change leaves through a callback,
    // so there is one writer of the store and it is App.
    expect(menuSurface).not.toMatch(/localStorage/);
  });
});
