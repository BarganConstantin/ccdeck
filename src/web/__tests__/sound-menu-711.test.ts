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
//    below check the property rather than the three figures that satisfy it
//    today;
//  - the floor stays above zero, the ceiling stays under "well below full
//    scale", every read and write stays wrapped, and every key stays in the
//    `agent-dag.*` namespace.
//
// The half no assertion can reach is whether three sounds per tone are actually
// tellable apart by ear, and whether the floor is still audible. What CAN be
// checked is that they differ on axes a listener uses — note count, pitch
// sequence, and whether a note repeats before it moves — and that is what the
// distinctness sweep does. The rest was a listening job; see the pull request.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  CHIME_ORDER, clampLevel, createChimePlayer, DEFAULT_FIGURE_ID, DEFAULT_LEVEL,
  DEFAULT_PREFS, figureFor, figureIdFrom, FIGURES, FIGURE_KEYS, FIGURE_SETS,
  GAIN_CEILING, GAIN_FLOOR, gainForLevel, LEVEL_KEYS, levelFrom, LEVEL_MAX,
  LEVEL_MIN, LEVEL_STEP, PEAK_GAIN, PREVIEW_DELAY_MS, readPrefs,
  type Chime, type Note, type TonePrefs,
} from "../sound";
import { readStored } from "../storage";
import { finishSoundTitle } from "../provider-copy";
import { ASSUMED } from "../providers";
import { KEY_HELP } from "../key-help";
import { openTags, withoutComments } from "./tsx-scan";

const web = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(join(web, rel), "utf8");
/** Comment-stripped, so a paragraph explaining a decision cannot satisfy an
 *  assertion about the code that carries it out (#513). */
const app = withoutComments(read("App.tsx"));
const menu = withoutComments(read("components/SoundMenu.tsx"));
const sheet = withoutComments(read("components/KeyboardHelp.tsx"));
const css = read("styles.css");

const pitches = (notes: readonly Note[]) => notes.map(n => n.hz);
const ends = (notes: readonly Note[]) => Math.max(...notes.map(n => n.at * 1000 + n.ms));
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
  it("gives no two figures in a set the same notes", () => {
    for (const chime of CHIME_ORDER) {
      const seqs = FIGURE_SETS[chime].map(f => pitches(f.notes).join(","));
      expect(new Set(seqs).size, `${chime}: two figures sound the same`).toBe(seqs.length);
    }
  });

  it("separates them on an axis a listener actually uses", () => {
    // Note count, the pitch sequence, or whether a note repeats before it moves
    // — a rhythm rather than a melody. Every pair has to differ on at least one
    // of the three, which is what stops a fourth figure being added as a shade
    // of an existing one.
    const repeats = (n: readonly Note[]) => pitches(n).some((hz, i) => i > 0 && hz === pitches(n)[i - 1]);
    for (const chime of CHIME_ORDER) {
      const set = FIGURE_SETS[chime];
      for (let i = 0; i < set.length; i++) {
        for (let j = i + 1; j < set.length; j++) {
          const [a, b] = [set[i], set[j]];
          const differs = a.notes.length !== b.notes.length
            || repeats(a.notes) !== repeats(b.notes)
            || pitches(a.notes).join() !== pitches(b.notes).join();
          expect(differs, `${chime}: ${a.id} and ${b.id} vary on nothing`).toBe(true);
        }
      }
    }
  });

  it("holds the three the set actually ships to what their names claim", () => {
    // The design claim, stated so a later edit that quietly makes `tap` a
    // melody or `arc` a repeat has to argue with something.
    for (const chime of CHIME_ORDER) {
      const by = (id: string) => FIGURE_SETS[chime].find(f => f.id === id)!;
      expect(by("two").notes).toHaveLength(2);
      expect(by("arc").notes).toHaveLength(3);
      expect(by("tap").notes).toHaveLength(3);
      // `arc` moves on every note; `tap` repeats before it moves. That is the
      // whole of what separates the two three-note figures.
      const arc = pitches(by("arc").notes);
      expect(new Set(arc).size, `${chime}: arc repeats a note`).toBe(arc.length);
      const tap = pitches(by("tap").notes);
      expect(tap[0], `${chime}: tap does not double its first note`).toBe(tap[1]);
    }
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
        // Notes arrive in the order they are written, so a figure cannot be
        // read as a chord by mistake.
        for (let i = 1; i < f.notes.length; i++) {
          expect(f.notes[i].at, `${chime}/${f.id} note ${i}`).toBeGreaterThan(f.notes[i - 1].at);
        }
      }
    }
  });
});

describe("what a tab that never opens the menu hears", () => {
  it("is exactly what #704 shipped", () => {
    expect(DEFAULT_FIGURE_ID).toBe("two");
    expect(FIGURES.done).toEqual(figureFor("done", DEFAULT_FIGURE_ID));
    expect(FIGURES["needs-input"]).toEqual(figureFor("needs-input", DEFAULT_FIGURE_ID));
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
        expect(figureIdFrom(chime, bad), `${chime}/${String(bad)}`).toBe(DEFAULT_FIGURE_ID);
      }
      // And a real one is kept.
      for (const f of FIGURE_SETS[chime]) {
        expect(figureIdFrom(chime, f.id), f.id).toBe(f.id);
        expect(figureFor(chime, f.id), f.id).toEqual(f.notes);
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
  class Ctx {
    state: "suspended" | "running" = "suspended";
    currentTime = 0;
    destination = {} as AudioNode;
    resume() { this.state = "running"; return Promise.resolve(); }
    createOscillator() {
      const node = {
        type: "", frequency: { value: 0 },
        connect: (n: unknown) => n,
        start() { started.push(node.frequency.value); },
        stop() {},
      };
      return node as unknown as OscillatorNode;
    }
    createGain() {
      return {
        gain: {
          setValueAtTime() {},
          exponentialRampToValueAtTime(target: number) { if (target > 0.0001) peaks.push(target); },
        },
        connect: (n: unknown) => n,
      } as unknown as GainNode;
    }
  }
  return { Ctx: Ctx as unknown as typeof AudioContext, peaks, started };
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
    expect(started).toEqual(pitches(figureFor("done", "arc")));
    expect(peaks).toEqual(figureFor("done", "arc").map(() => GAIN_FLOOR));

    started.length = 0; peaks.length = 0;
    expect(p.play("needs-input")).toBe(true);
    expect(started).toEqual(pitches(figureFor("needs-input", "tap")));
    expect(peaks).toEqual(figureFor("needs-input", "tap").map(() => GAIN_CEILING));
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
    expect(started).toEqual(pitches(figureFor("done", "tap")));
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
    expect(started).toEqual(pitches(figureFor("done", "arc")));
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

describe("the click opens the menu, and M still silences the deck", () => {
  it("makes the topbar speaker a disclosure rather than a toggle", () => {
    expect(app).toMatch(/onClick=\{\(\) => setSoundMenuOpen\(o => !o\)\}/);
    const tags = openTags(read("App.tsx"), ["button"])
      .filter(t => t.attrs.includes('aria-label="Sound settings"'));
    expect(tags).toHaveLength(1);
    expect(tags[0].ranAway).toBe(false);
    expect(tags[0].attrs).toMatch(/aria-haspopup="dialog"/);
    expect(tags[0].attrs).toMatch(/aria-expanded=\{soundMenuOpen\}/);
    // "Pressed" would describe an action this button no longer performs.
    expect(tags[0].attrs).not.toMatch(/aria-pressed/);
    // An IDREF that resolves to nothing is a dangling pointer, and closed is
    // exactly when there is nothing to point at — the rule the two panel
    // toggles already follow.
    expect(tags[0].attrs).toMatch(/aria-controls=\{soundMenuOpen \? "sound-menu" : undefined\}/);
    expect(menu).toMatch(/id="sound-menu"/);
  });

  it("keeps M on the toggle, which is now the only one-press route to silence", () => {
    // The half a redesign loses quietly. The key handler is untouched by #711
    // and still guards on the same two conditions.
    expect(app).toMatch(/providersRef\.current\.claude && soundOnRef\.current !== null/);
    expect(app).toMatch(/activateSoundRef\.current\(e\.shiftKey\)/);
    // And the sheet says so, in the words a user reads.
    const rows = KEY_HELP.flatMap(g => g.rows);
    expect(rows.find(r => /^m$/i.test(r.cap))!.action).toMatch(/sound on or off/);
    // The click and M no longer agree, so the divergence is written down rather
    // than left to be discovered — which is what #709 removed Shift+M for.
    expect(rows.some(r => /^click$/i.test(r.cap) && /speaker/i.test(r.action))).toBe(true);
  });

  it("gives the mouse the switch back, inside the menu, through the same door", () => {
    expect(app).toMatch(/onToggleSound=\{toggleSound\}/);
    expect(menu).toMatch(/onClick=\{onToggleSound\}/);
    expect(menu).toMatch(/aria-pressed=\{soundOn\}/);
  });

  it("took the volume out of the shortcuts sheet it briefly lived in", () => {
    // The first build of #711 put a slider there. Leaving it would give the
    // deck two homes for one setting, which is worse than either.
    expect(sheet).not.toMatch(/type="range"/);
    expect(sheet).not.toMatch(/soundLevel|kh-volume/);
    expect(css).not.toMatch(/\.kh-volume|\.kh-sound/);
  });

  it("says on the button what the press now does", () => {
    // The press changed meaning, so a tooltip that only reported state would
    // leave the user to find that out by pressing — the "gesture you could not
    // discover" complaint, pointed the other way round.
    for (const on of [true, false]) {
      const title = finishSoundTitle(ASSUMED, { on, locked: false, prefs: DEFAULT_PREFS });
      expect(title, `on=${on}`).toMatch(/Click to set the volume and the sound/);
      expect(title, `on=${on}`).toMatch(/\(M\)/);
    }
    // It reports both volumes, and collapses them when they agree — which is
    // the common case and the one a two-number sentence would complicate.
    expect(finishSoundTitle(ASSUMED, { on: true, locked: false, prefs: DEFAULT_PREFS }))
      .toMatch(/on at 50% —/);
    expect(finishSoundTitle(ASSUMED, { on: true, locked: false, prefs: prefsOf([25, "two"], [75, "two"]) }))
      .toMatch(/on at 25% and 75%/);
    // A caller that has not read the store back yet gets the defaults, not
    // "undefined%".
    expect(finishSoundTitle(ASSUMED, { on: true, locked: false })).toMatch(/on at 50%/);
  });
});

describe("the popover, built out of the parts the six dialogs already use", () => {
  it("takes Escape, the Tab trap and the focus hand-back from the shared hook", () => {
    // Not a second spelling: useModalDismiss owns where focus starts, where Tab
    // may go, and where focus lands on close. A popover needs all three and has
    // no reason to reimplement any of them.
    expect(menu).toMatch(/const dialogRef = useModalDismiss<HTMLDivElement>\(onClose\);/);
    expect(menu).toMatch(/role="dialog"/);
    expect(menu).toMatch(/aria-label="Sound settings"/);
    // Non-modal on purpose: there is no scrim and nothing behind it is inert.
    expect(menu).not.toMatch(/aria-modal/);
  });

  it("adds the one rule a popover needs and a modal does not", () => {
    // A modal has a backdrop to catch the click; this has nothing. pointerdown
    // rather than click, so a press that starts outside dismisses even if the
    // pointer travels back in before release — and in the capture phase, so a
    // control that stops propagation cannot keep the menu open.
    expect(menu).toMatch(/window\.addEventListener\("pointerdown", onDown, true\)/);
    expect(menu).toMatch(/window\.removeEventListener\("pointerdown", onDown, true\)/);
    // The two exclusions, and the opener is the one that matters: without it
    // the outside-press closes the menu and the button's own onClick reopens it
    // in the same gesture.
    expect(menu).toMatch(/if \(dialogRef\.current\?\.contains\(target\)\) return;/);
    expect(menu).toMatch(/if \(openerRef\.current\?\.contains\(target\)\) return;/);
    expect(app).toMatch(/openerRef=\{soundButtonRef\}/);
    expect(app).toMatch(/ref=\{soundButtonRef\}/);
  });

  it("disables nothing, least of all the button that opened it (#620)", () => {
    // A disclosure that disabled itself under its own press would drop focus
    // off the very control the popover's Escape hands focus back to.
    expect(menu).not.toMatch(/disabled/);
    const tags = openTags(read("App.tsx"), ["button"])
      .filter(t => t.attrs.includes('aria-label="Sound settings"'));
    expect(tags[0].attrs.replace(/\s+/g, " ")).toMatch(/\{\.\.\.selfPressProps\(false\)\}/);
    expect(tags[0].attrs).not.toMatch(/disabled=/);
  });

  it("is not remembered across a reload, because a popover is not a setting", () => {
    expect(app).toMatch(/const \[soundMenuOpen, setSoundMenuOpen\] = useState\(false\);/);
    expect(app).not.toMatch(/soundMenuOpen.*localStorage|localStorage.*soundMenuOpen/);
  });
});

describe("hearing it is the point, not a nicety", () => {
  it("gives each tone its own preview, and auditions rather than reports", () => {
    // Two buttons, one per tone, each playing THAT tone.
    expect(menu).toMatch(/onClick=\{\(\) => onPreview\(chime\)\}/);
    expect(menu).toMatch(/aria-label=\{`Hear the \$\{TONE_LABEL\[chime\]\.toLowerCase\(\)\} tone`\}/);
    expect(app).toMatch(/onPreview=\{chime => previewTone\(chime\)\}/);
    expect(app).toMatch(/chimesRef\.current\?\.play\(chime, true\)/);
  });

  it("answers a press at once and a drag after it settles", () => {
    // The distinction that makes both usable: a slider crossing a dozen steps
    // must collapse to one figure, and a deliberate press must not feel laggy.
    expect(app).toMatch(/if \(!soon\) \{ chimesRef\.current\?\.play\(chime, true\); return; \}/);
    expect(app).toMatch(/previewRef\.current = setTimeout\(/);
    expect(app).toMatch(/\}, PREVIEW_DELAY_MS\);/);
    // A pending debounce is cancelled before either path runs, so a press and a
    // drag can never overlap into two figures at once.
    expect(app).toMatch(/if \(previewRef\.current !== null\) clearTimeout\(previewRef\.current\);\n\s*previewRef\.current = null;/);
    expect(PREVIEW_DELAY_MS).toBeGreaterThan(80);
    expect(PREVIEW_DELAY_MS).toBeLessThan(200);
    // Shorter than the figure it plays, so a settled change is heard before the
    // next one could be scheduled.
    expect(PREVIEW_DELAY_MS).toBeLessThan(ends(FIGURES.done));
  });

  it("plays the tone back whenever a setting of that tone changes", () => {
    // Not just the slider: picking a sound you cannot hear is the same guess as
    // setting a level in silence.
    expect(app).toMatch(/previewTone\(chime, true\);/);
    expect(app).toMatch(/onLevel=\{\(chime, level\) => changeTone\(chime, \{ level \}\)\}/);
    expect(app).toMatch(/onFigure=\{\(chime, figure\) => changeTone\(chime, \{ figure \}\)\}/);
  });

  it("unlocks before it asks, because this may be the tab's first gesture", () => {
    expect(app).toMatch(/chimesRef\.current\?\.unlock\(\);\n\s*if \(previewRef\.current !== null\)/);
  });

  it("does not leave a timer running past the tab", () => {
    expect(app).toMatch(/useEffect\(\(\) => \(\) => \{ if \(previewRef\.current !== null\) clearTimeout\(previewRef\.current\); \}, \[\]\);/);
  });
});

describe("App owns the settings, the write and the round trip", () => {
  it("reads them back through the wrapped read, in an initialiser that must not throw", () => {
    expect(app).toMatch(/useState<TonePrefs>\(\(\) => readPrefs\(readStored\)\)/);
  });

  it("writes both of a tone's settings, checked, under the namespaced keys", () => {
    expect(app).toMatch(/level: clampLevel\(patch\.level \?\? prev\[chime\]\.level\)/);
    expect(app).toMatch(/figure: figureIdFrom\(chime, patch\.figure \?\? prev\[chime\]\.figure\)/);
    expect(app).toMatch(/localStorage\.setItem\(LEVEL_KEYS\[chime\], String\(next\.level\)\)/);
    expect(app).toMatch(/localStorage\.setItem\(FIGURE_KEYS\[chime\], next\.figure\)/);
    // Wrapped, like every other preference here: a blocked store costs the
    // setting and nothing else.
    expect(app).toMatch(/try \{[\s\S]{0,200}localStorage\.setItem\(LEVEL_KEYS\[chime\][\s\S]{0,200}\} catch/);
  });

  it("hands the player the settings through a ref, the way it hands it the flag", () => {
    expect(app).toMatch(/prefs: \(\) => tonePrefsRef\.current,/);
    expect(app).toMatch(/enabled: \(\) => soundOnRef\.current === true,/);
    expect(app).toMatch(/tonePrefsRef\.current = tonePrefs;/);
  });

  it("gives the menu everything it needs and nothing it does not", () => {
    for (const prop of [
      /soundOn=\{soundOn === true\}/, /onToggleSound=\{toggleSound\}/, /prefs=\{tonePrefs\}/,
      /onLevel=/, /onFigure=/, /onPreview=/, /openerRef=/, /onClose=/,
    ]) {
      expect(app, String(prop)).toMatch(prop);
    }
    // The menu writes nothing itself: every change leaves through a callback,
    // so there is one writer of the store and it is App.
    expect(menu).not.toMatch(/localStorage/);
  });
});
