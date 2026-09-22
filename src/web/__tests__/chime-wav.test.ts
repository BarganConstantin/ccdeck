// The deck's tones as the desktop app's notification sounds (#1160): the same
// figures sound.ts plays live, rendered to WAV, and the server naming which of
// the two a notification stands in for — by the page's own rule.
import { describe, it, expect } from "vitest";
import { CHIME_FILES, renderChime, wavFile } from "../chime-wav";
import { chimeFor, figureFor, DEFAULT_FIGURE_ID } from "../sound";
import { chimeOf, isChimeEvent } from "../../server/block-notify.mjs";

describe("the rendered tones", () => {
  it("last as long as the figure, and are not silent", () => {
    for (const chime of ["done", "needs-input"] as const) {
      const figure = figureFor(chime, DEFAULT_FIGURE_ID);
      const end = Math.max(...figure.notes.map(n => n.at + n.ms / 1000));
      const samples = renderChime(chime, DEFAULT_FIGURE_ID, 8000);
      expect(samples.length).toBeGreaterThanOrEqual(Math.floor(end * 8000));
      expect(Math.max(...Array.from(samples, s => Math.abs(s)))).toBeGreaterThan(3000);
    }
  });

  it("start and end at silence, so the file does not click", () => {
    const s = renderChime("done", DEFAULT_FIGURE_ID, 8000);
    expect(Math.abs(s[0])).toBeLessThan(50);
    expect(Math.abs(s[s.length - 1])).toBeLessThan(50);
  });

  it("are a valid mono 16-bit WAV", () => {
    const wav = wavFile(new Int16Array([0, 1000, -1000]), 44_100);
    const text = (a: number, b: number) => String.fromCharCode(...wav.slice(a, b));
    expect(text(0, 4)).toBe("RIFF");
    expect(text(8, 12)).toBe("WAVE");
    expect(text(36, 40)).toBe("data");
    expect(wav.length).toBe(44 + 6);
  });

  it("say mono, 16-bit and the rate they were rendered at, field by field (#1173)", () => {
    // The case above reads the three tags and the length, which a wrong channel
    // count, sample rate or byte rate all pass. macOS reads every one of these
    // fields to play the file, so a wrong one is a notification tone at the
    // wrong pitch or speed, or no tone at all — shipped in the desktop bundle
    // by desktop/scripts/chimes.mjs. Read at 22,050 Hz rather than the default
    // 44,100, so a rate that ignored its argument would show.
    const wav = wavFile(new Int16Array([0, 1000, -1000]), 22_050);
    const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const text = (a: number, b: number) => String.fromCharCode(...wav.slice(a, b));
    expect(v.getUint32(4, true), "RIFF size: 36 + the data").toBe(36 + 6);
    expect(text(12, 16)).toBe("fmt ");
    expect(v.getUint32(16, true), "fmt chunk size").toBe(16);
    expect(v.getUint16(20, true), "format: PCM").toBe(1);
    expect(v.getUint16(22, true), "channels").toBe(1);
    expect(v.getUint32(24, true), "sample rate").toBe(22_050);
    expect(v.getUint32(28, true), "byte rate: rate x 2 bytes").toBe(44_100);
    expect(v.getUint16(32, true), "block align").toBe(2);
    expect(v.getUint16(34, true), "bits per sample").toBe(16);
    expect(v.getUint32(40, true), "data size").toBe(6);
    // The samples themselves, little-endian and signed, after the 44 bytes.
    expect(v.getInt16(44, true)).toBe(0);
    expect(v.getInt16(46, true)).toBe(1000);
    expect(v.getInt16(48, true)).toBe(-1000);
  });

  it("render the triangle and the square as well as the sine (#1173)", () => {
    // The desktop app ships the default figure, which is a sine, so the other
    // two oscillators had never run. A person can pick Bell (triangle) or Blip
    // (square) on the page, and the page's own synthesis is what this mirrors.
    //
    // Loud enough and click-free is not enough to tell them apart: a waveform
    // swapped for a sine is still both. So each is read over one period just
    // after its attack, at 44.1 kHz — a hundred samples of a 440 Hz note, sixty
    // of a 740 Hz one:
    //   floor     the smallest magnitude over the largest. A square sits at its
    //             envelope and flips; a sine and a triangle pass through zero.
    //   evenness  the median step between samples over the largest. A triangle
    //             climbs and falls in equal steps; a sine's steps follow its
    //             cosine, about 0.7 of their largest at the median.
    //   above     the share of samples above zero: half, for anything that
    //             swings both ways rather than sitting to one side of silence.
    const SR = 44_100;
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const period = (s: Int16Array, hz: number) => {
      const from = Math.round(0.02 * SR);
      const w = Array.from(s.slice(from, from + Math.round(SR / hz) + 1));
      const mags = w.map(Math.abs);
      const steps = w.slice(1).map((x, i) => Math.abs(x - w[i]));
      return {
        floor: Math.min(...mags) / Math.max(...mags),
        evenness: median(steps) / Math.max(...steps),
        above: w.filter(x => x > 0).length / w.length,
      };
    };
    for (const chime of ["done", "needs-input"] as const) {
      const firstHz = figureFor(chime, "two").notes[0].hz;
      for (const id of ["bell", "blip"]) {
        const s = renderChime(chime, id, SR);
        expect(Math.max(...Array.from(s, x => Math.abs(x))), `${chime}/${id} is silent`).toBeGreaterThan(3000);
        expect(Math.abs(s[0]), `${chime}/${id} clicks in`).toBeLessThan(50);
        expect(Math.abs(s[s.length - 1]), `${chime}/${id} clicks out`).toBeLessThan(50);
      }
      // Each figure opens on the same note as the default, so the three are one
      // period of the same pitch read three ways.
      expect(figureFor(chime, "bell").notes[0].hz).toBe(firstHz);
      expect(figureFor(chime, "blip").notes[0].hz).toBe(firstHz);
      const sine = period(renderChime(chime, "two", SR), firstHz);
      const triangle = period(renderChime(chime, "bell", SR), firstHz);
      const square = period(renderChime(chime, "blip", SR), firstHz);

      expect(square.floor, `${chime}/blip is not a square`).toBeGreaterThan(0.5);
      expect(triangle.floor, `${chime}/bell does not pass through zero`).toBeLessThan(0.05);
      expect(sine.floor, `${chime}/two does not pass through zero`).toBeLessThan(0.05);
      expect(triangle.evenness, `${chime}/bell is not a triangle`).toBeGreaterThan(0.85);
      expect(sine.evenness, `${chime}/two is not a sine`).toBeGreaterThan(0.55);
      expect(sine.evenness, `${chime}/two is not a sine`).toBeLessThan(0.8);
      for (const [id, shape] of [["two", sine], ["bell", triangle], ["blip", square]] as const) {
        expect(shape.above, `${chime}/${id} does not swing both ways`).toBeGreaterThan(0.4);
        expect(shape.above, `${chime}/${id} does not swing both ways`).toBeLessThan(0.6);
      }
    }
  });

  it("have one file per tone", () => {
    expect(CHIME_FILES).toEqual({ done: "ccdeck-done.wav", "needs-input": "ccdeck-asking.wav" });
  });
});

describe("which tone a notification stands in for", () => {
  it("is the one the page would have played", () => {
    const events = [
      { hook_event_name: "Stop" },
      { hook_event_name: "Notification", notification_type: "permission_prompt" },
      { hook_event_name: "Notification", notification_type: "idle_prompt" },
      { hook_event_name: "Notification", notification_type: "agent_needs_input" },
    ];
    for (const raw of events) {
      expect(isChimeEvent(raw)).toBe(true);
      expect(chimeOf(raw)).toBe(chimeFor({ payload: raw }, false));
    }
  });
});
