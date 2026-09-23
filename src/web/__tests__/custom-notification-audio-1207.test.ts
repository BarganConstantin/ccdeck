import { describe, expect, it, vi } from "vitest";
import {
  CUSTOM_AUDIO_KEYS, MAX_CUSTOM_ASSETS, MAX_CUSTOM_AUDIO_BYTES, clearCustomAssetSelections,
  createCustomVoice, importCustomAudio, libraryFullReason, newAssetId, normalizationGain,
  readCustomSelections, sameCustomSelection, validateAudioImport,
  type CustomAudioAsset,
} from "../notification-audio";
import { createChimePlayer, DEFAULT_FIGURE_ID, DEFAULT_PREFS } from "../sound";

const audio = (size = 4, name = "voice.wav") =>
  Object.assign(new Blob([new Uint8Array(size)], { type: "audio/wav" }), { name });
const decode = (duration = 2, samples = new Float32Array([0.1, -0.4])) =>
  vi.fn(async () => ({ duration, numberOfChannels: 1, getChannelData: () => samples }));

describe("custom notification assets (#1207)", () => {
  it("rejects unsupported, empty, oversized, undecodable, and too-long files with a reason", async () => {
    expect(validateAudioImport({ name: "bad.exe", type: "application/octet-stream", size: 100 })).toMatch(/WAV/);
    expect(validateAudioImport({ name: "bad.wav", type: "audio/wav", size: 0 })).toMatch(/empty/);
    expect(validateAudioImport({ name: "bad.wav", type: "audio/wav", size: MAX_CUSTOM_AUDIO_BYTES + 1 })).toMatch(/1 MB/);
    expect(validateAudioImport({ name: "bad.wav", type: "audio/wav", size: 30 }, 5.01)).toMatch(/5 seconds/);
    const oversized = audio(MAX_CUSTOM_AUDIO_BYTES + 1);
    const skipDecode = decode();
    await expect(importCustomAudio(oversized, skipDecode, "large")).rejects.toThrow(/1 MB/);
    expect(skipDecode).not.toHaveBeenCalled();
    await expect(importCustomAudio(audio(), decode(6), "long")).rejects.toThrow(/5 seconds/);
    await expect(importCustomAudio(audio(), vi.fn(async () => { throw Error("decode failed"); }), "broken"))
      .rejects.toThrow(/could not be decoded/);
  });

  it("normalizes peak amplitude at import, including silent and quiet clips", async () => {
    const asset = await importCustomAudio(audio(), decode(2, new Float32Array([-0.4, 0.2])), "tone-1");
    expect(asset).toMatchObject({ id: "tone-1", name: "voice", kind: "audio", duration: 2 });
    expect(asset.normalizationGain).toBeCloseTo(2);
    expect(asset.bytes.byteLength).toBe(4);
    expect(normalizationGain([new Float32Array([0, 0])])).toBe(1);
    expect(normalizationGain([new Float32Array([0.0001])])).toBe(16);
  });

  it("keeps independent selections across storage round trips and warns only on a shared id", () => {
    const stored = new Map([[CUSTOM_AUDIO_KEYS.done, "one"], [CUSTOM_AUDIO_KEYS["needs-input"], "two"]]);
    const first = readCustomSelections(key => stored.get(key) ?? null);
    expect(first).toEqual({ done: "one", "needs-input": "two" });
    expect(sameCustomSelection(first)).toBeNull();
    stored.set(CUSTOM_AUDIO_KEYS["needs-input"], "one");
    const shared = readCustomSelections(key => stored.get(key) ?? null);
    expect(sameCustomSelection(shared)).toBe("one");
    expect(clearCustomAssetSelections(shared, "one")).toEqual({ done: null, "needs-input": null });
    stored.set(CUSTOM_AUDIO_KEYS.done, "invalid/id");
    expect(readCustomSelections(key => stored.get(key) ?? null).done).toBeNull();
  });

  it("validates TTS text and bounds its playback controls", () => {
    expect(() => createCustomVoice({ name: "", text: "   " }, "no-text")).toThrow(/Enter the words/);
    expect(createCustomVoice({ name: "", text: " Finished ", rate: 9, pitch: -1 }, "voice-1"))
      .toMatchObject({ id: "voice-1", name: "Custom voice", text: "Finished", rate: 2, pitch: 0.5 });
  });

  it("names a new asset even on a deck reached over plain-http LAN, where randomUUID is missing", () => {
    const real = crypto.randomUUID;
    try {
      Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
      const id = newAssetId();
      expect(readCustomSelections(() => id).done).toBe(id);
      const voiceId = createCustomVoice({ name: "v", text: "hi" }).id;
      expect(readCustomSelections(() => voiceId).done).toBe(voiceId);
    } finally {
      Object.defineProperty(crypto, "randomUUID", { value: real, configurable: true });
    }
  });

  it("says why a full library cannot take another sound, before the store refuses it", () => {
    expect(libraryFullReason(MAX_CUSTOM_ASSETS - 1)).toBeNull();
    expect(libraryFullReason(MAX_CUSTOM_ASSETS)).toMatch(/Delete one first/);
  });

  it("falls back to the default figure after a missing asset or a failed decode", async () => {
    const started = vi.fn();
    const gain = () => ({ gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn(() => ({ connect: vi.fn() })) });
    const context = {
      state: "running", currentTime: 0, destination: {}, resume: () => Promise.resolve(),
      createOscillator: () => ({ type: "sine", frequency: { value: 0 }, connect: vi.fn(() => ({ connect: vi.fn() })), start: started, stop: vi.fn() }),
      createGain: gain, createBufferSource: () => ({ connect: vi.fn(() => ({ connect: vi.fn() })), start: vi.fn() }),
      decodeAudioData: vi.fn(async () => { throw Error("corrupt"); }),
    };
    const Ctor = class { constructor() { return context; } } as unknown as typeof AudioContext;
    const failed = vi.fn();
    const asset: CustomAudioAsset = {
      id: "broken", name: "Broken", kind: "audio", mime: "audio/wav", duration: 1,
      normalizationGain: 1, bytes: new ArrayBuffer(4),
    };
    let selected: string | null = "missing";
    const player = createChimePlayer({
      enabled: () => true, ctor: Ctor, prefs: () => DEFAULT_PREFS,
      customSelection: () => ({ done: selected, "needs-input": null }),
      loadCustom: async id => id === "broken" ? asset : null,
      onCustomFailure: (chime, id) => { failed(chime, id, DEFAULT_FIGURE_ID); selected = null; },
    });
    player.unlock();
    expect(player.play("done")).toBe(true);
    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith("done", "missing", DEFAULT_FIGURE_ID));
    expect(started).toHaveBeenCalled();
    started.mockClear();
    selected = "broken";
    expect(player.play("done")).toBe(true);
    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith("done", "broken", DEFAULT_FIGURE_ID));
    expect(started).toHaveBeenCalled();
  });

  it("plays the default figure once, and keeps the choice, when storage fails to answer", async () => {
    const started = vi.fn();
    const context = {
      state: "running", currentTime: 0, destination: {}, resume: () => Promise.resolve(),
      createOscillator: () => ({ type: "sine", frequency: { value: 0 }, connect: vi.fn(() => ({ connect: vi.fn() })), start: started, stop: vi.fn() }),
      createGain: () => ({ gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn(() => ({ connect: vi.fn() })) }),
    };
    const Ctor = class { constructor() { return context; } } as unknown as typeof AudioContext;
    const failed = vi.fn();
    const player = createChimePlayer({
      enabled: () => true, ctor: Ctor, prefs: () => DEFAULT_PREFS,
      customSelection: () => ({ done: "kept", "needs-input": null }),
      loadCustom: async () => { throw new Error("IPC unavailable during reload"); },
      onCustomFailure: failed,
    });
    player.unlock();
    expect(player.play("done")).toBe(true);
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    expect(failed).not.toHaveBeenCalled();
  });
});
