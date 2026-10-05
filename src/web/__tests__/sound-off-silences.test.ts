// Turning the sound off while a custom sound is still playing.
//
// M, or the Sounds switch, only wrote the flag down. Nothing stopped what was
// already sounding, so a spoken voice — up to 180 characters, at a rate down to
// 0.5 — went on for twenty or thirty seconds after the person had muted it,
// and an imported clip played to its end, because nothing kept hold of it to
// stop. The switch now silences what is playing as well as what plays next.
//
// Run, not read: the player is the real one, over a fake AudioContext and a
// fake speechSynthesis, and the switch is the real hook, drawn on
// fake-react.ts's React. Nothing here speaks or plays.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { flush, mount } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

const { createChimePlayer } = await import("../chime-player");
const { useSoundSwitch } = await import("../use-sound-switch");

/** speechSynthesis as far as the player uses it: a queue, and whether it is
 *  saying something now. */
function fakeSpeech() {
  const speech = {
    speaking: false,
    said: [] as string[],
    getVoices: () => [],
    speak(u: { text: string }) { speech.said.push(u.text); speech.speaking = true; },
    cancel() { speech.speaking = false; },
  };
  return speech;
}

/** Every buffer source the player started, and whether it was stopped. */
const sources: Array<{ stopped: boolean }> = [];

class FakeCtx extends EventTarget {
  state: "suspended" | "running" = "running";
  currentTime = 0;
  destination = {} as AudioNode;
  resume() { return Promise.resolve(); }
  decodeAudioData() { return Promise.resolve({ duration: 5 } as AudioBuffer); }
  createGain() {
    return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (n: unknown) => n } as unknown as GainNode;
  }
  createOscillator() {
    return { type: "", frequency: { value: 0 }, connect: (n: unknown) => n, start() {}, stop() {} } as unknown as OscillatorNode;
  }
  createBufferSource() {
    const node = Object.assign(new EventTarget(), {
      buffer: null as AudioBuffer | null,
      stopped: false,
      connect: (n: unknown) => n,
      start() {},
      stop() { node.stopped = true; },
      disconnect() {},
    });
    sources.push(node);
    return node as unknown as AudioBufferSourceNode;
  }
}
const Ctor = FakeCtx as unknown as typeof AudioContext;

const VOICE = { id: "v1", name: "Long", kind: "tts" as const, text: "A long sentence, read slowly. ".repeat(6), voiceURI: "", rate: 0.5, pitch: 1 };
const CLIP = { id: "c1", name: "Clip", kind: "audio" as const, mime: "audio/wav", duration: 5, normalizationGain: 1, bytes: new ArrayBuffer(8) };

let speech: ReturnType<typeof fakeSpeech>;
let stored: Map<string, string>;

beforeEach(() => {
  sources.length = 0;
  speech = fakeSpeech();
  stored = new Map([["agent-dag.sound", "on"]]);
  vi.stubGlobal("window", {
    speechSynthesis: speech,
    localStorage: {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => { stored.set(k, v); },
      removeItem: (k: string) => { stored.delete(k); },
    },
  });
  vi.stubGlobal("SpeechSynthesisUtterance", class { text: string; voice = null; rate = 1; pitch = 1; volume = 1; constructor(t: string) { this.text = t; } });
});
afterEach(() => { vi.unstubAllGlobals(); });

/** The page's player, with `asset` chosen for "Turn finished", and the switch
 *  that governs it. */
function deck(asset: typeof VOICE | typeof CLIP) {
  let soundOn: boolean | null = true;
  const player = createChimePlayer({
    enabled: () => soundOn === true,
    ctor: Ctor,
    customSelection: () => ({ done: asset.id, "needs-input": null }),
    loadCustom: async id => (id === asset.id ? asset : null),
  });
  player.unlock();
  const chimesRef = { current: player };
  let sw!: ReturnType<typeof useSoundSwitch>;
  mount(() => { sw = useSoundSwitch(chimesRef); soundOn = sw.soundOn; return null; }, {});
  return { player, get sw() { return sw; }, sync() { soundOn = sw.soundOn; } };
}

describe("turning the sound off", () => {
  it("stops a spoken voice that is still talking", async () => {
    const d = deck(VOICE);
    expect(d.sw.soundOn).toBe(true);
    d.player.play("done");
    await flush();
    expect(speech.speaking, "the voice never started").toBe(true);

    d.sw.toggleSound();
    d.sync();
    expect(d.sw.soundOn).toBe(false);
    expect(speech.speaking, "the voice went on after the sound was turned off").toBe(false);
  });

  it("stops an imported clip that is still playing", async () => {
    const d = deck(CLIP);
    d.player.play("done");
    await flush();
    expect(sources).toHaveLength(1);
    expect(sources[0].stopped).toBe(false);

    d.sw.toggleSound();
    expect(sources[0].stopped, "the clip played on after the sound was turned off").toBe(true);
  });

  it("does not stop anything when the sound is turned ON", async () => {
    stored.set("agent-dag.sound", "off");
    const d = deck(VOICE);
    expect(d.sw.soundOn).toBe(false);
    // The menu's own preview plays past the switch.
    d.player.play("done", true);
    await flush();
    expect(speech.speaking).toBe(true);
    d.sw.toggleSound();
    expect(d.sw.soundOn).toBe(true);
    expect(speech.speaking).toBe(true);
  });
});

describe("the player's silence()", () => {
  it("leaves nothing sounding, and a clip that already ended is not stopped twice", async () => {
    const p = createChimePlayer({
      enabled: () => true,
      ctor: Ctor,
      customSelection: () => ({ done: CLIP.id, "needs-input": VOICE.id }),
      loadCustom: async id => (id === CLIP.id ? CLIP : id === VOICE.id ? VOICE : null),
    });
    p.unlock();
    p.play("done");
    p.play("needs-input");
    await flush();
    expect(sources).toHaveLength(1);
    // The clip ends by itself before anybody mutes.
    (sources[0] as unknown as EventTarget).dispatchEvent(new Event("ended"));
    sources[0].stopped = false;
    p.silence();
    expect(speech.speaking).toBe(false);
    expect(sources[0].stopped, "a clip that had ended was stopped again").toBe(false);
  });
});
