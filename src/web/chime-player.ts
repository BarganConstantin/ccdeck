// The player that makes the deck's two tones heard: the one part of the sound
// code that touches an AudioContext, speech synthesis and the custom sounds'
// store.
//
// Moved out of sound.ts, which keeps what is played — the figures, the
// level-to-gain arithmetic, the envelope, the stored settings — and `chimeFor`,
// which decides whether an event earns a tone at all. Those are data and pure
// functions; this is the state and the side effects: a context built lazily,
// the unlock on the first gesture, and the synthesis and playback.
import { type CustomNotificationAsset, type CustomSelections } from "./notification-audio";
import {
  clampLevel, clipGain, DEFAULT_FIGURE_ID, DEFAULT_LEVEL, ENVELOPE_ATTACK_S, ENVELOPE_FLOOR,
  figureFor, peakFor, toneFor, voiceVolume,
  type Chime, type TonePrefs, type ToneSettings,
} from "./sound";

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
  /** A local custom asset chosen for either tone (#1207). The asset bytes
   *  themselves live in IndexedDB in a browser and in the desktop app's
   *  userData directory. */
  customSelection?: () => CustomSelections;
  loadCustom?: (id: string) => Promise<CustomNotificationAsset | null>;
  /** The chosen asset is gone or no longer decodes. The tone falls back to its
   *  default figure, and the owner persists that. Not called when storage or
   *  speech merely failed to answer this once — that plays the default figure
   *  for this one event and leaves the choice alone. */
  onCustomFailure?: (chime: Chime, id: string) => void;
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
  /** Imported clips still playing, so turning the sound off can stop them. */
  const clips = new Set<AudioBufferSourceNode>();

  // Read off the context itself, never latched (#1760). Not every press is
  // activation — Escape is not, nor is a touch until it lifts — and a resume()
  // asked outside it leaves the context suspended. A flag set on the first
  // press said "unlocked" whatever the context did, and turned every later
  // press away, so a tab whose first input was one of those stayed silent
  // until it was reloaded.
  const state = (): ChimeState =>
    !opts.enabled() ? "off" : ctx?.state === "running" ? "ready" : "locked";
  const announce = () => opts.onState?.(state());

  /** Ask the context to run. Every press that reaches here asks again until it
   *  does, and one that is running is left alone. */
  function unlock() {
    if (!Ctx || ctx?.state === "running") return;
    try {
      if (!ctx) {
        ctx = new Ctx();
        // A resume the browser honours later, or a context it starts on its
        // own, is heard here as well as through the promise below.
        ctx.addEventListener?.("statechange", announce);
      }
      // `resume` returns a promise on every engine that needs it; a browser
      // that resolves it late still ends up running before the first event
      // worth playing, because a gesture precedes the work by a long way.
      void ctx.resume?.().then(announce, () => {});
      announce();
    } catch { /* no audio on this machine; the switch will say "locked" */ }
  }

  function playFigure(chime: Chime, tone: ToneSettings, figureId = tone.figure) {
    if (!ctx || ctx.state !== "running") return false;
    const figure = figureFor(chime, figureId);
    const peak = peakFor(tone.level, figure);
    const now = ctx.currentTime;
    for (const note of figure.notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      // A shaped envelope rather than a raw start/stop: an abruptly gated
      // oscillator clicks, and a click is the part people find unpleasant, not
      // the tone. One gain node PER NOTE, which is what lets two of them start
      // at the same instant and sound as a dyad (#711's `chord`).
      //
      // The waveform is the figure's, defaulting to the sine every figure used
      // before timbre was a lever. Nothing else about the synthesis changes:
      // articulation is `ms` and texture is `at`, both of which this loop
      // already honoured.
      osc.type = figure.type ?? "sine";
      osc.frequency.value = note.hz;
      const t0 = now + note.at;
      const t1 = t0 + note.ms / 1000;
      gain.gain.setValueAtTime(ENVELOPE_FLOOR, t0);
      // `peak`, not PEAK_GAIN: the user's level, trimmed for this waveform. The
      // ramp is exponential and an exponential ramp to zero is undefined
      // behaviour in the spec — which is the second reason GAIN_FLOOR is above
      // zero rather than the first, and the reason peakFor clamps the trim
      // rather than trusting it.
      gain.gain.exponentialRampToValueAtTime(peak, t0 + ENVELOPE_ATTACK_S);
      gain.gain.exponentialRampToValueAtTime(ENVELOPE_FLOOR, t1);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t1 + 0.02);
    }
    return true;
  }

  /**
   * How a custom asset went. Only `missing` and `broken` say something about
   * the asset itself — deleted, or bytes that no longer decode — and so only
   * they are worth changing the user's setting over. `unavailable` is storage
   * or speech failing to answer this once (a desktop IPC call during a reload,
   * a browser with no speechSynthesis), and clearing the choice for that would
   * throw away a working sound because of a moment's hiccup.
   */
  type CustomOutcome = "played" | "locked" | "missing" | "broken" | "unavailable";

  async function playCustomAsset(id: string, tone: ToneSettings): Promise<CustomOutcome> {
    if (!opts.loadCustom) return "unavailable";
    let asset: CustomNotificationAsset | null;
    try { asset = await opts.loadCustom(id); }
    catch { return "unavailable"; }
    if (!asset) return "missing";

    if (asset.kind === "tts") {
      if (typeof window === "undefined" || !("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") return "unavailable";
      const utterance = new SpeechSynthesisUtterance(asset.text);
      const voices = window.speechSynthesis.getVoices();
      utterance.voice = voices.find(v => v.voiceURI === asset.voiceURI) ?? null;
      utterance.rate = asset.rate;
      utterance.pitch = asset.pitch;
      utterance.volume = voiceVolume(tone.level);
      try {
        // Speech QUEUES where a chime overlaps. Five turns finishing together
        // would otherwise be five sentences read out one after another, the
        // last of them long after the moment it was about — so the newest
        // replaces whatever is still being said.
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utterance);
        return "played";
      } catch { return "unavailable"; }
    }

    if (!ctx || ctx.state !== "running") return "locked";
    let decoded: AudioBuffer;
    try { decoded = await ctx.decodeAudioData(asset.bytes.slice(0)); }
    catch { return "broken"; }
    try {
      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      source.buffer = decoded;
      gain.gain.setValueAtTime(clipGain(asset.normalizationGain, tone.level), ctx.currentTime);
      source.connect(gain).connect(ctx.destination);
      clips.add(source);
      source.addEventListener?.("ended", () => clips.delete(source));
      source.start(ctx.currentTime);
      return "played";
    } catch {
      return "unavailable";
    }
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
   * A suspended context is NOT waived with it — that one is the browser's
   * rule, not the deck's, and nothing here can override it.
   */
  function play(chime: Chime, audition = false) {
    if (!audition && !opts.enabled()) return false;
    const tone = toneFor(opts.prefs?.(), chime);
    const customId = opts.customSelection?.()[chime] ?? null;
    if (customId && opts.loadCustom) {
      void playCustomAsset(customId, tone).then(outcome => {
        if (outcome === "played" || outcome === "locked") return;
        if (outcome === "missing" || outcome === "broken") opts.onCustomFailure?.(chime, customId);
        // Something still sounds: a notification that fails silently is the
        // one outcome worse than the wrong sound.
        playFigure(chime, { ...tone, figure: DEFAULT_FIGURE_ID }, DEFAULT_FIGURE_ID);
      });
      return true;
    }
    if (!ctx || ctx.state !== "running") return false;
    return playFigure(chime, tone);
  }

  function previewCustom(id: string, level = DEFAULT_LEVEL) {
    void playCustomAsset(id, { level: clampLevel(level), figure: DEFAULT_FIGURE_ID });
    return true;
  }

  /**
   * Stop what is sounding now: a spoken voice, and any imported clip still
   * playing. Turning the sound off used to govern only what played NEXT, and a
   * voice of 180 characters read at half speed went on for half a minute after
   * the person had muted it. The figures are a fraction of a second, and are
   * left to finish.
   */
  function silence() {
    try {
      if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    } catch { /* nothing is being said, or nothing can be */ }
    for (const source of clips) {
      try { source.stop(); } catch { /* it had already ended */ }
    }
    clips.clear();
  }

  return { unlock, play, previewCustom, silence, state, get context() { return ctx; } };
}
