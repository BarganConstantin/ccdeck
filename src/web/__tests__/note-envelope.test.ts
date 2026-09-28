// The one envelope every note is played in, and the two things that build it
// (#1160): the page's player, live, and chime-wav.ts, which renders the desktop
// app's notification files offline and has to sound like the page.
//
// Both wrote the shape out by hand — a 12ms attack from 0.0001 — and nothing
// tied the two copies together, so an edit to one would have left the desktop
// notifications sounding unlike the tab. sound.ts states it once now. What is
// pinned here is that each builder follows it: the player's ramps land where
// the constants say, and a rendered note is loudest where its attack ends.
import { describe, it, expect } from "vitest";
import { renderChime } from "../chime-wav";
import {
  createChimePlayer, DEFAULT_LEVEL, ENVELOPE_ATTACK_S, ENVELOPE_FLOOR, figureFor, peakFor,
} from "../sound";

type Call = [what: "set" | "ramp", value: number, at: number];

function recordingPlayer() {
  const notes: Call[][] = [];
  class Ctx {
    state = "running";
    currentTime = 3;
    destination = {};
    resume() { return Promise.resolve(); }
    createOscillator() {
      return { type: "", frequency: { value: 0 }, connect: (n: unknown) => n, start() {}, stop() {} };
    }
    createGain() {
      const calls: Call[] = [];
      notes.push(calls);
      return {
        gain: {
          setValueAtTime: (v: number, t: number) => { calls.push(["set", v, t]); },
          exponentialRampToValueAtTime: (v: number, t: number) => { calls.push(["ramp", v, t]); },
        },
        connect: (n: unknown) => n,
      };
    }
  }
  const player = createChimePlayer({ enabled: () => true, ctor: Ctx as unknown as typeof AudioContext });
  player.unlock();
  return { player, notes };
}

describe("the player", () => {
  it("ramps every note from the floor to its peak over the attack, and back to the floor at its end", () => {
    for (const chime of ["done", "needs-input"] as const) {
      const { player, notes } = recordingPlayer();
      expect(player.play(chime)).toBe(true);
      const figure = figureFor(chime, undefined);
      const peak = peakFor(DEFAULT_LEVEL, figure);
      expect(notes).toHaveLength(figure.notes.length);
      figure.notes.forEach((note, i) => {
        const t0 = 3 + note.at;
        const [start, attack, decay] = notes[i];
        expect(start.slice(0, 2)).toEqual(["set", ENVELOPE_FLOOR]);
        expect(start[2]).toBeCloseTo(t0, 12);
        expect(attack.slice(0, 2)).toEqual(["ramp", peak]);
        expect(attack[2] - t0).toBeCloseTo(ENVELOPE_ATTACK_S, 12);
        expect(decay.slice(0, 2)).toEqual(["ramp", ENVELOPE_FLOOR]);
        expect(decay[2] - t0).toBeCloseTo(note.ms / 1000, 12);
      });
    }
  });
});

describe("the WAV renderer", () => {
  it("makes a square note loudest where the same attack ends, starting at the same floor", () => {
    // A square oscillator is ±1 at every sample, so what the file holds is the
    // envelope itself. Blip is the square figure, and its first note ends
    // before its second begins.
    const SR = 48_000;
    const figure = figureFor("done", "blip");
    expect(figure.type).toBe("square");
    const [first, second] = figure.notes;
    expect(first.at + first.ms / 1000).toBeLessThan(second.at);
    const s = renderChime("done", "blip", SR);
    const from = Math.round(first.at * SR);
    const to = Math.floor((first.at + first.ms / 1000) * SR);
    let loudest = from;
    for (let i = from; i <= to; i++) if (Math.abs(s[i]) > Math.abs(s[loudest])) loudest = i;
    expect(loudest - from).toBe(Math.round(ENVELOPE_ATTACK_S * SR));
    expect(Math.abs(s[from])).toBe(Math.round(ENVELOPE_FLOOR * 32767));
  });
});
