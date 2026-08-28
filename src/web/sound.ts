// The two moments worth hearing, played by the deck itself.
//
// This used to be a `Stop` hook written into the user's settings.json running
// `afplay` / a PowerShell one-liner / `paplay`, chosen per platform — see #704
// for why that shape kept failing. Both moments already arrive here as events,
// on every platform, so the tab plays them and nothing is written to anyone's
// config.
//
// The file is split so the suite can reach the half that matters. `chimeFor`
// and `FIGURES` are data and arithmetic and are tested directly; only
// `createChimePlayer` touches an AudioContext, which no test in this repo has.

/** A tone the deck can play. Two, deliberately: more becomes noise. */
export type Chime = "done" | "needs-input";

/** One note of a figure. `at` is seconds from the start of the figure. */
export type Note = { at: number; hz: number; ms: number };

/**
 * What each chime sounds like, as data rather than as calls, so a test can
 * assert the shape without an audio device.
 *
 * The two are told apart by CONTOUR, not by pitch alone: a listener who was
 * not told which is which should still be able to guess. `done` falls and
 * settles — the shape of a sentence ending. `needs-input` rises and stops on
 * the higher note, which is what a question does. Rising-and-unresolved is the
 * one people read as "you", and that is the one that wants an answer.
 *
 * Frequencies are a major sixth apart (A4 440 / F#5 740) rather than adjacent,
 * because two notes a tone apart read as one wobbling note on laptop speakers.
 */
export const FIGURES: Record<Chime, Note[]> = {
  done:         [{ at: 0, hz: 740, ms: 90 }, { at: 0.085, hz: 440, ms: 150 }],
  "needs-input": [{ at: 0, hz: 440, ms: 90 }, { at: 0.085, hz: 740, ms: 150 }],
};

/** How loud, at the peak of a note. Well under 1: this is a notification in a
 *  room, not an alarm. */
export const PEAK_GAIN = 0.14;

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

  function play(chime: Chime) {
    if (!opts.enabled() || !ctx || ctx.state !== "running") return false;
    const now = ctx.currentTime;
    for (const note of FIGURES[chime]) {
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
      gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t1);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t1 + 0.02);
    }
    return true;
  }

  return { unlock, play, state, get context() { return ctx; } };
}
