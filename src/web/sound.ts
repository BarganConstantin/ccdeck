// The two moments worth hearing, played by the deck itself.
//
// This used to be a `Stop` hook written into the user's settings.json running
// `afplay` / a PowerShell one-liner / `paplay`, chosen per platform — see #704
// for why that shape kept failing. Both moments already arrive here as events,
// on every platform, so the tab plays them and nothing is written to anyone's
// config.
//
// The file is split so the suite can reach the half that matters. `chimeFor`,
// the figures and — since #711 — the whole of the volume and figure-choice
// arithmetic are data and functions and are tested directly; only
// `createChimePlayer` touches an AudioContext, which no test in this repo has.

/** A tone the deck can play. Two, deliberately: more becomes noise. */
export type Chime = "done" | "needs-input";

/** Both of them, in the order the menu lists them. Exported so a caller does
 *  not hand-write the pair and get it out of step with this file. */
export const CHIME_ORDER: readonly Chime[] = ["done", "needs-input"];

/** One note of a figure. `at` is seconds from the start of the figure. */
export type Note = { at: number; hz: number; ms: number };

/** One selectable sound: an id that goes in the store, a name for the menu, and
 *  the notes themselves. */
export interface Figure {
  /** Stable, and written to localStorage. Renaming one costs every user who
   *  picked it their choice, so these are ids and not labels. */
  id: string;
  /** What the menu calls it — a description of what you will HEAR, which is
   *  the only thing that helps somebody choosing between three of them. */
  label: string;
  notes: readonly Note[];
}

// ── the sounds on offer (#711) ──────────────────────────────────────────────
//
// #704 built two figures and the argument for them is unchanged and is the
// reason there is a set PER TONE rather than one shared list:
//
//   the two are told apart by CONTOUR, not by pitch alone. A listener who was
//   not told which is which should still be able to guess. `done` falls and
//   settles — the shape of a sentence ending. `needs-input` rises and stops on
//   the higher note, which is what a question does.
//
// A single shared catalogue would let a user set both tones to the same sound
// and throw that away, and they would not find out until the day they needed to
// know which one had just fired. Two catalogues make it impossible: every
// figure offered for `done` ends on its lowest note, every figure offered for
// `needs-input` ends on its highest, so no choice of settings can produce two
// tones that mean the same thing.
//
// Three per tone, and three is a ceiling reached on purpose rather than a
// number picked. A fourth was drafted for each — a longer five-note run, and a
// version of `two` shifted down a fourth — and both were dropped: the five-note
// run ran past the 400ms that keeps a figure a notification, and the shifted
// one differed from `two` by register alone, which is the kind of "choice" that
// makes a menu longer without making it more useful. Fewer and distinct beats
// more and blurred.
//
// The three axes the set actually varies, which is what makes them tellable
// apart rather than three shades of the same thing:
//
//   two   2 notes, one step        the quick blip #704 shipped
//   arc   3 notes, a triad walk    a longer, more musical sweep
//   tap   3 notes, first doubled   a rhythm rather than a melody
//
// `arc` and `tap` both have three notes, so note-count alone does not separate
// them: one moves on every note and the other repeats before it moves, which is
// a difference in rhythm and survives a bad speaker better than a difference in
// pitch does.
//
// Frequencies stay inside roughly 400–1000 Hz. Below that a laptop speaker
// rolls the note off into a click, and above it a sine at notification level
// starts to sound like an alarm. A4 440 and F#5 740 are the two #704 chose;
// E5 659 and B5 988 are the notes that complete a triad with them.

/** The falling figures — the tone for a turn that finished. Each ends on its
 *  own lowest note, which is what "settled" is. */
const DONE_FIGURES: readonly Figure[] = [
  { id: "two", label: "Two notes", notes: [{ at: 0, hz: 740, ms: 90 }, { at: 0.085, hz: 440, ms: 150 }] },
  { id: "arc", label: "Descent", notes: [{ at: 0, hz: 988, ms: 80 }, { at: 0.07, hz: 659, ms: 80 }, { at: 0.14, hz: 440, ms: 160 }] },
  { id: "tap", label: "Double tap", notes: [{ at: 0, hz: 740, ms: 70 }, { at: 0.065, hz: 740, ms: 70 }, { at: 0.145, hz: 440, ms: 150 }] },
];

/** The rising figures — the tone for Claude waiting on you. Each ends on its
 *  own highest note, which is what "unresolved" is. */
const ASKING_FIGURES: readonly Figure[] = [
  { id: "two", label: "Two notes", notes: [{ at: 0, hz: 440, ms: 90 }, { at: 0.085, hz: 740, ms: 150 }] },
  { id: "arc", label: "Ascent", notes: [{ at: 0, hz: 440, ms: 80 }, { at: 0.07, hz: 659, ms: 80 }, { at: 0.14, hz: 988, ms: 160 }] },
  { id: "tap", label: "Double tap", notes: [{ at: 0, hz: 440, ms: 70 }, { at: 0.065, hz: 440, ms: 70 }, { at: 0.145, hz: 740, ms: 150 }] },
];

/** Every sound each tone can be set to. */
export const FIGURE_SETS: Record<Chime, readonly Figure[]> = {
  done: DONE_FIGURES,
  "needs-input": ASKING_FIGURES,
};

/** What a tab that has never chosen hears. The two #704 shipped, so nobody's
 *  deck changes its sound because this feature landed. */
export const DEFAULT_FIGURE_ID = "two";

/**
 * The notes for one tone's chosen sound, falling back to the default.
 *
 * An unknown id is the default rather than an error or a silence: it arrives
 * from a store that is older, newer or hand-edited, and every one of those
 * should leave the deck audible.
 */
export function figureFor(chime: Chime, id: string | null | undefined): readonly Note[] {
  const set = FIGURE_SETS[chime];
  return (set.find(f => f.id === id) ?? set.find(f => f.id === DEFAULT_FIGURE_ID) ?? set[0]).notes;
}

/** One stored figure id, or the default when it names nothing on offer. Kept
 *  separate from `figureFor` because the MENU needs the id — to mark the right
 *  option selected — and the player needs the notes. */
export function figureIdFrom(chime: Chime, raw: string | null | undefined): string {
  const set = FIGURE_SETS[chime];
  return set.some(f => f.id === raw) ? (raw as string) : DEFAULT_FIGURE_ID;
}

/**
 * The two default figures, under the name #704 gave them.
 *
 * Derived rather than restated: this is what `figureFor` answers for a tab that
 * has chosen nothing, so the defaults cannot drift away from the sets the menu
 * offers. deck-chimes-704.test.ts holds the contour argument against these.
 */
export const FIGURES: Record<Chime, readonly Note[]> = {
  done: figureFor("done", DEFAULT_FIGURE_ID),
  "needs-input": figureFor("needs-input", DEFAULT_FIGURE_ID),
};

// ── how loud (#711) ─────────────────────────────────────────────────────────
//
// #704 shipped one constant for both figures and no way to move it, so the
// tones were on or off. A notification you cannot turn down is one you
// eventually turn off, which is the report this answers.
//
// The setting is a LEVEL, 0–100, not a gain. Three things follow and all three
// are the reason:
//
//  - the number a `range` input carries, a screen reader announces and the
//    menu prints is one number, not three. `min=0 max=100` is what makes a
//    native range announce "50%" without an aria-valuetext saying it again;
//  - nothing outside this file can hand the oscillator a gain. `gainForLevel`
//    is the only door and it clamps, so a corrupt store, a hand-edited value
//    or a future caller cannot make the deck loud;
//  - the floor and the ceiling are stated once, here, and every other file
//    reads them off the level.
//
// The map is linear in amplitude rather than geometric in decibels, and that
// is a choice rather than an oversight. Geometric is the textbook answer for a
// volume control, because loudness is roughly logarithmic; it was worked out
// and rejected, and the honest reason is not that the two are indistinguishable
// — over this span they part by about 3 dB in the middle of the track, which is
// audible. It is that the span is short enough for either to give a usable
// slider (floor to ceiling is 15.6 dB, a quarter of what a media player
// covers), and that linear buys two things geometric cannot:
//
//  - the default lands dead centre. A geometric map putting 0.14 between 0.04
//    and 0.24 sits at level 70, so the slider a user opens for the first time
//    is already two thirds along and looks like somebody else's setting;
//  - every step is exactly 0.01 of gain, so the arithmetic is checkable by
//    eye and statable exactly in a test. Geometric steps are irrational and
//    can only be asserted approximately.
//
// A control this coarse is judged by ear against its own default, not read off
// as a measurement, so legibility wins over the curve.

/** The bottom of the slider, and deliberately NOT silence. Zero is what the
 *  switch is for: a volume control whose floor is mute gives the deck two
 *  off switches that disagree, and leaves the user unable to tell a muted
 *  slider from a broken feature. About 11 dB under the default — quiet enough
 *  to sit under music, loud enough to still be a notification. */
export const GAIN_FLOOR = 0.04;

/** The top. This is a tone in a room, not an alarm: 0.24 is roughly 5 dB over
 *  the default, audible across a desk, and still far enough under full scale
 *  that a sine at this peak cannot clip whatever else the machine is playing. */
export const GAIN_CEILING = 0.24;

/** The ends of the slider's own scale. */
export const LEVEL_MIN = 0;
export const LEVEL_MAX = 100;

/**
 * How far one arrow press moves it.
 *
 * Five rather than one, and it is an accessibility number rather than a taste
 * one. A `range` with `step=1` takes fifty arrow presses to cross half the
 * track, which is not a control a keyboard user will reach for twice; at five
 * it is ten, and each press is 0.01 of gain — the smallest move that is
 * audible at all on the figures in this file.
 */
export const LEVEL_STEP = 5;

/** Dead centre, and the value #704 shipped. Anyone who never opens the menu
 *  hears exactly what they heard before this feature existed. */
export const DEFAULT_LEVEL = 50;

/**
 * A level the slider could actually be at: snapped to the step, then held
 * inside the ends.
 *
 * Anything that is not a finite number is the default rather than an end of
 * the track. A NaN arriving here means somebody's arithmetic went wrong
 * upstream, and answering "silent" or "loudest" to that is a guess; answering
 * "what a fresh profile gets" is not.
 */
export function clampLevel(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_LEVEL;
  const snapped = Math.round(value / LEVEL_STEP) * LEVEL_STEP;
  return Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, snapped));
}

/**
 * What one stored level means.
 *
 * Missing and corrupt collapse to the same answer on purpose: both mean "this
 * tab has never been told", and both must leave the deck sounding the way it
 * sounded before. The parse is strict rather than `Number()` — that reads ""
 * and "   " as 0, which is the FLOOR, so a store that answered with an empty
 * string would have silently turned the deck down to its quietest and looked
 * like a setting the user had chosen. `0x10`, `1e2`, `Infinity` and `12abc`
 * are refused for the same reason: none of them is a spelling this file ever
 * writes, so each is evidence the value did not come from here.
 */
export function levelFrom(raw: string | null | undefined): number {
  if (raw == null) return DEFAULT_LEVEL;
  const text = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return DEFAULT_LEVEL;
  return clampLevel(Number(text));
}

/**
 * The gain at the peak of a note, for a level.
 *
 * Rounded to four places so the number is one a test can state exactly and a
 * reader can recognise: 0.04 + 0.2 × 0.5 is 0.14000000000000001 in binary
 * floating point, and PEAK_GAIN has been the literal 0.14 since #704.
 */
export function gainForLevel(level: number): number {
  const held = clampLevel(level);
  const raw = GAIN_FLOOR + (GAIN_CEILING - GAIN_FLOOR) * (held / LEVEL_MAX);
  return Math.round(raw * 10_000) / 10_000;
}

/** How loud, at the peak of a note, for a tone that has never been set. Well
 *  under 1: this is a notification in a room, not an alarm. Kept under its own
 *  name because it is what #704 shipped and what every reader of that issue
 *  will come here looking for — it is the DEFAULT now rather than the only
 *  value, and gainForLevel is what the player actually calls. */
export const PEAK_GAIN = gainForLevel(DEFAULT_LEVEL);

/**
 * How long after the last change to a tone the deck plays it back.
 *
 * A volume you cannot hear is a volume you are guessing at, so touching a tone
 * plays it. Trailing rather than leading, and 160ms rather than nothing: a drag
 * crosses a dozen steps and a tone on each of them would stack twelve
 * overlapping figures, which is both unpleasant and useless for judging
 * loudness. 160ms is under the ~200ms at which a response stops feeling
 * attached to the gesture, and long enough that a held arrow key repeats
 * through several steps before it fires once.
 *
 * The preview BUTTON does not wait for this. A deliberate press is not a drag
 * and deserves an immediate answer; the debounce exists to collapse a stream of
 * small changes, and a press is not a stream.
 */
export const PREVIEW_DELAY_MS = 160;

// ── where the settings live ─────────────────────────────────────────────────
//
// Four keys, not one blob, and the reason is failure isolation: a JSON value
// that fails to parse takes every setting inside it down together, so one bad
// character would reset both volumes AND both sounds. Read separately, a
// corrupt level costs a level.
//
// Spelled out as four constants rather than built from the chime id with a
// template literal, because display-name.test.ts sweeps this client for storage
// keys by reading string literals — a key assembled at runtime is a key that
// test cannot see, and the `agent-dag.*` boundary it guards is one this file
// should be inside rather than invisible to.

export const DONE_LEVEL_KEY = "agent-dag.soundLevel.done";
export const ASKING_LEVEL_KEY = "agent-dag.soundLevel.needs-input";
export const DONE_FIGURE_KEY = "agent-dag.soundFigure.done";
export const ASKING_FIGURE_KEY = "agent-dag.soundFigure.needs-input";

export const LEVEL_KEYS: Record<Chime, string> = {
  done: DONE_LEVEL_KEY,
  "needs-input": ASKING_LEVEL_KEY,
};
export const FIGURE_KEYS: Record<Chime, string> = {
  done: DONE_FIGURE_KEY,
  "needs-input": ASKING_FIGURE_KEY,
};

/** Everything one tone is set to. */
export interface ToneSettings {
  /** 0–100, the slider's own number. */
  level: number;
  /** The id of one of this tone's figures. */
  figure: string;
}

/** Both tones, which is the whole of what the menu edits. */
export type TonePrefs = Record<Chime, ToneSettings>;

/** What a tab that has never opened the menu is set to. */
export const DEFAULT_PREFS: TonePrefs = {
  done: { level: DEFAULT_LEVEL, figure: DEFAULT_FIGURE_ID },
  "needs-input": { level: DEFAULT_LEVEL, figure: DEFAULT_FIGURE_ID },
};

/**
 * Both tones' settings, read through whatever the caller uses to reach the
 * store.
 *
 * The reader is an argument rather than `localStorage` so the round trip is a
 * pure function the DOM-less suite can drive — and so the browser half stays
 * exactly one call (`readStored`), which already collapses a THROWING accessor
 * to "not stored". A private window and a browser with site data blocked throw
 * out of the `window.localStorage` getter itself, and this is read inside a
 * useState initialiser where an escaping throw takes the whole deck down.
 */
export function readPrefs(read: (key: string) => string | null): TonePrefs {
  const one = (chime: Chime): ToneSettings => ({
    level: levelFrom(read(LEVEL_KEYS[chime])),
    figure: figureIdFrom(chime, read(FIGURE_KEYS[chime])),
  });
  return { done: one("done"), "needs-input": one("needs-input") };
}

/** The events that earn a tone. Everything else is silent on purpose. */
const CHIMES: Record<string, Chime> = {
  Stop: "done",
  Notification: "needs-input",
};

/**
 * Which chime this envelope deserves, if any.
 *
 * `isReplay` is the load-bearing argument, not a detail. A tab that reconnects
 * is sent the whole ring — up to two thousand envelopes in one burst — and
 * every `Stop` in a day's work is in there. Without this the first thing a
 * returning tab would do is play a hundred tones over each other. The caller
 * passes the same `isReplay` it already computes for the coalescer, which
 * covers the flag, the replay window, and an envelope older than 30 seconds
 * from a server too old to send the flag at all.
 */
export function chimeFor(
  env: { payload?: { hook_event_name?: string } | null } | null | undefined,
  isReplay: boolean,
): Chime | null {
  if (isReplay) return null;
  const name = env?.payload?.hook_event_name;
  if (typeof name !== "string") return null;
  return CHIMES[name] ?? null;
}

/** What the player can be doing, for the switch to describe honestly. */
export type ChimeState =
  | "off"      // the user turned it off
  | "locked"   // on, but the page has not been interacted with yet
  | "ready";   // on and able to make a sound

type Ctor = typeof AudioContext;

/**
 * A player that survives the autoplay rules.
 *
 * Browsers create an AudioContext `suspended` and only let it run after a
 * genuine user gesture. For a dashboard left open all day that is satisfied
 * long before the first chime, but a tab reloaded and never touched is silent
 * — so the state is reported rather than hidden, and any pointer or key press
 * anywhere in the page unlocks it. The context is built lazily, on that first
 * gesture, because constructing one before it is allowed is what leaves a
 * permanently suspended object behind.
 */
export function createChimePlayer(opts: {
  enabled: () => boolean;
  /** Both tones' settings, read at play time rather than captured — the same
   *  shape as `enabled`, and for the same reason: the player is built once, on
   *  mount, and the settings move under it for the life of the tab. */
  prefs?: () => TonePrefs;
  ctor?: Ctor | null;
  onState?: (s: ChimeState) => void;
} = { enabled: () => true }) {
  const Ctx: Ctor | null = opts.ctor
    ?? (typeof window !== "undefined"
      ? ((window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor }).AudioContext
        ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext
        ?? null)
      : null);

  let ctx: AudioContext | null = null;
  let unlocked = false;

  const state = (): ChimeState =>
    !opts.enabled() ? "off" : unlocked && ctx?.state === "running" ? "ready" : "locked";
  const announce = () => opts.onState?.(state());

  function unlock() {
    if (!Ctx || unlocked) return;
    try {
      ctx = ctx ?? new Ctx();
      // `resume` returns a promise on every engine that needs it; a browser
      // that resolves it late still ends up running before the first event
      // worth playing, because a gesture precedes the work by a long way.
      void ctx.resume?.().then(announce, () => {});
      unlocked = true;
      announce();
    } catch { /* no audio on this machine; the switch will say "locked" */ }
  }

  /**
   * `audition` is the one caller allowed past the switch, and it is the sound
   * menu — its preview buttons, and the controls that change a tone.
   *
   * Every other sound this deck makes is a report about something that
   * happened, and the switch is the user saying they do not want those.
   * Pressing "hear it" is not that: it is a direct request for the tone, the
   * only gesture in the app whose entire purpose is to make a sound, and
   * refusing it would leave the menu silent in exactly the state a user who
   * turned the sound OFF BECAUSE IT WAS TOO LOUD is in when they open it. So
   * the flag governs the deck's own tones and not the user's own press.
   * `unlocked` is NOT waived with it — that one is the browser's rule, not the
   * deck's, and nothing here can override it.
   */
  function play(chime: Chime, audition = false) {
    if ((!audition && !opts.enabled()) || !ctx || ctx.state !== "running") return false;
    const tone = (opts.prefs?.() ?? DEFAULT_PREFS)[chime] ?? DEFAULT_PREFS[chime];
    const peak = gainForLevel(tone.level);
    const now = ctx.currentTime;
    for (const note of figureFor(chime, tone.figure)) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      // A sine with a shaped envelope, rather than a raw start/stop: an
      // abruptly gated oscillator clicks, and a click is the part people find
      // unpleasant, not the tone.
      osc.type = "sine";
      osc.frequency.value = note.hz;
      const t0 = now + note.at;
      const t1 = t0 + note.ms / 1000;
      gain.gain.setValueAtTime(0.0001, t0);
      // `peak`, not PEAK_GAIN. The ramp is exponential and an exponential ramp
      // to zero is undefined behaviour in the spec — which is the second
      // reason GAIN_FLOOR is above zero rather than the first.
      gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t1);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t1 + 0.02);
    }
    return true;
  }

  return { unlock, play, state, get context() { return ctx; } };
}
