// How loud a custom sound plays (#1207), called rather than reached through a
// fake AudioContext.
//
// A custom clip and a spoken voice have no volume control of their own: the
// tone's level is the one control, and these two functions are where it is
// read for them. They lived inside the player, beside the Web Audio calls,
// where nothing in this suite could ask them a question. What is pinned here
// is the promise the level makes — a custom sound at a level is as loud as the
// deck's own tone at that level, and never louder than the ceiling.
import { describe, it, expect } from "vitest";
import {
  clipGain, DEFAULT_LEVEL, DEFAULT_PREFS, GAIN_CEILING, GAIN_FLOOR, gainForLevel,
  LEVEL_MAX, LEVEL_MIN, LEVEL_STEP, toneFor, voiceVolume, type TonePrefs,
} from "../sound";
import { CUSTOM_TARGET_PEAK, normalizationGain } from "../notification-audio";

const LEVELS: number[] = [];
for (let l = LEVEL_MIN; l <= LEVEL_MAX; l += LEVEL_STEP) LEVELS.push(l);

describe("a spoken voice's volume", () => {
  it("is the tone band read as a share of its ceiling", () => {
    expect(voiceVolume(LEVEL_MAX)).toBe(1);
    expect(voiceVolume(DEFAULT_LEVEL)).toBe(gainForLevel(DEFAULT_LEVEL) / GAIN_CEILING);
    expect(voiceVolume(LEVEL_MIN)).toBe(GAIN_FLOOR / GAIN_CEILING);
  });

  it("rises with the level, stays inside SpeechSynthesis' 0-1, and is never silent", () => {
    let last = 0;
    for (const level of LEVELS) {
      const v = voiceVolume(level);
      expect(v, `level ${level}`).toBeGreaterThan(last);
      expect(v, `level ${level}`).toBeLessThanOrEqual(1);
      last = v;
    }
    expect(voiceVolume(LEVEL_MIN)).toBeGreaterThan(0);
  });

  it("reads a level off the slider's own scale the way a tone does", () => {
    // Off the track, or not a number at all, is what gainForLevel makes of it.
    expect(voiceVolume(250)).toBe(1);
    expect(voiceVolume(-40)).toBe(voiceVolume(LEVEL_MIN));
    expect(voiceVolume(Number.NaN)).toBe(voiceVolume(DEFAULT_LEVEL));
  });
});

describe("an imported clip's gain", () => {
  it("brings a clip normalised at import to the peak a tone reaches at the same level", () => {
    for (const level of LEVELS) {
      expect(CUSTOM_TARGET_PEAK * clipGain(1, level), `level ${level}`).toBeCloseTo(gainForLevel(level), 12);
    }
  });

  it("does so for a real file's measured peak, quiet or loud", () => {
    // Peaks a Float32Array holds exactly, so the sample buffer adds no rounding
    // of its own to the comparison.
    for (const peak of [0.125, 0.25, 0.5, 0.75, 1]) {
      const gain = normalizationGain([new Float32Array([0, peak, -peak / 2])]);
      for (const level of [LEVEL_MIN, DEFAULT_LEVEL, LEVEL_MAX]) {
        expect(peak * clipGain(gain, level), `peak ${peak}, level ${level}`).toBeCloseTo(gainForLevel(level), 12);
      }
    }
  });

  it("never sets the gain to zero", () => {
    expect(clipGain(0, DEFAULT_LEVEL)).toBe(0.0001);
    expect(clipGain(-3, LEVEL_MAX)).toBe(0.0001);
  });
});

describe("the settings a tone plays at", () => {
  it("are the default for a player handed none", () => {
    expect(toneFor(undefined, "done")).toBe(DEFAULT_PREFS.done);
    expect(toneFor(undefined, "needs-input")).toBe(DEFAULT_PREFS["needs-input"]);
  });

  it("are the default for a tone the settings leave out, and the settings' own otherwise", () => {
    const partial = { done: { level: 80, figure: "bell" } } as unknown as TonePrefs;
    expect(toneFor(partial, "done")).toEqual({ level: 80, figure: "bell" });
    expect(toneFor(partial, "needs-input")).toBe(DEFAULT_PREFS["needs-input"]);
  });
});
