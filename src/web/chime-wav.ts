// The deck's two tones as WAV files, for the desktop app's notifications
// (#1160).
//
// A closed deck stands in for its own sounds: where an open tab would have
// played "turn finished" or "Claude is asking", the app raises a notification.
// On macOS a notification can carry a sound file from the app's bundle, so the
// mirror can be exact — the same tone, not the system's generic chime. This
// renders the page's figures offline with the synthesis sound.ts runs live:
// one oscillator per note, the figure's waveform, a 12 ms exponential attack to
// the peak and an exponential decay to silence at the note's end.
//
// The default figure at the default level, because the tone a person picked is
// kept in their browser's storage, where a file baked into the app at build
// time cannot see it. Scaled up from the page's peak, which is set for a
// speaker already carrying other audio; a notification is heard at the
// system's alert volume beside other alert sounds.
import { DEFAULT_FIGURE_ID, DEFAULT_LEVEL, figureFor, peakFor } from "./sound";
import type { Chime } from "./sound";

/** How far above the page's own peak the file is written. The page's loudest
 *  level peaks at 0.24; this brings the default near half of full scale. */
export const NOTIFICATION_GAIN = 3;

function oscillator(type: string | undefined, phase: number): number {
  const p = phase - Math.floor(phase);
  if (type === "square") return p < 0.5 ? 1 : -1;
  if (type === "triangle") return 1 - 4 * Math.abs(p - 0.5);
  return Math.sin(2 * Math.PI * p);
}

/** The envelope sound.ts builds with exponentialRampToValueAtTime. */
function envelope(t: number, t0: number, t1: number, peak: number): number {
  const floor = 0.0001;
  const attackEnd = t0 + 0.012;
  if (t < t0) return 0;
  if (t < attackEnd) return floor * Math.pow(peak / floor, (t - t0) / 0.012);
  if (t <= t1) return peak * Math.pow(floor / peak, (t - attackEnd) / Math.max(t1 - attackEnd, 1e-6));
  return 0;
}

/** Mono 16-bit PCM samples of one tone. */
export function renderChime(chime: Chime, figureId = DEFAULT_FIGURE_ID, sampleRate = 44_100): Int16Array {
  const figure = figureFor(chime, figureId);
  const peak = Math.min(0.95, peakFor(DEFAULT_LEVEL, figure) * NOTIFICATION_GAIN);
  const end = Math.max(...figure.notes.map(n => n.at + n.ms / 1000)) + 0.05;
  const out = new Int16Array(Math.ceil(end * sampleRate));
  for (let i = 0; i < out.length; i++) {
    const t = i / sampleRate;
    let v = 0;
    for (const n of figure.notes) {
      const t0 = n.at, t1 = n.at + n.ms / 1000;
      if (t < t0 || t > t1) continue;
      v += oscillator(figure.type, (t - t0) * n.hz) * envelope(t, t0, t1, peak);
    }
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  return out;
}

/** A complete .wav file: RIFF header, then the samples. */
export function wavFile(samples: Int16Array, sampleRate = 44_100): Uint8Array {
  const data = samples.length * 2;
  const buf = new ArrayBuffer(44 + data);
  const v = new DataView(buf);
  const ascii = (at: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  ascii(0, "RIFF"); v.setUint32(4, 36 + data, true); ascii(8, "WAVE");
  ascii(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ascii(36, "data"); v.setUint32(40, data, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, samples[i], true);
  return new Uint8Array(buf);
}

/** The file names the app ships and the server's notification names. */
export const CHIME_FILES: Record<Chime, string> = {
  done: "ccdeck-done.wav",
  "needs-input": "ccdeck-asking.wav",
};
