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
