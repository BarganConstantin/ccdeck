// A recording nobody is waiting for any more (#1759).
//
// Record asks the browser for the microphone and waits. The sound menu can
// close while it waits — Escape, a press outside, V — and closing unmounts the
// section that owns the recorder. When the answer came after that, the hook
// saw no recorder in its ref (the unmount had just cleared it), built one,
// recorded 4.4 seconds with no Stop button and nothing on screen saying so, and
// imported the clip into the library through the App-level import, which
// outlives the menu.
//
// Run, not read: React is replaced by the three hooks this one calls — a state
// whose setter does nothing, a ref that keeps its value, and an effect whose
// cleanup the test calls as the unmount — and the microphone and the recorder
// are fakes the test answers by hand. Nothing here opens a real device.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const react = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
}));

vi.mock("react", () => ({
  useState: (init: unknown) => [typeof init === "function" ? (init as () => unknown)() : init, () => {}],
  useRef: (init: unknown) => ({ current: init }),
  useEffect: (run: () => void | (() => void)) => { react.effects.push(run); },
}));

const { useClipRecorder, RECORDING_LIMIT_MS } = await import("../use-clip-recorder");

/** A microphone answer the test gives when it chooses. */
function pendingMicrophone() {
  let answer!: (stream: MediaStream) => void;
  let refuse!: (error: Error) => void;
  const getUserMedia = vi.fn(() => new Promise<MediaStream>((resolve, reject) => { answer = resolve; refuse = reject; }));
  return { getUserMedia, answer: (stream: MediaStream) => answer(stream), refuse: (error: Error) => refuse(error) };
}

/** A stream whose tracks count their stops. */
function fakeStream() {
  const tracks = [{ stops: 0, stop() { this.stops++; } }, { stops: 0, stop() { this.stops++; } }];
  return { tracks, stream: { getTracks: () => tracks } as unknown as MediaStream };
}

let started = 0;
let built = 0;

class FakeRecorder {
  static isTypeSupported = () => true;
  state = "inactive";
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { built++; }
  start() {
    started++;
    this.state = "recording";
    this.ondataavailable?.({ data: new Blob([new Uint8Array(16)]) });
  }
  stop() { this.state = "inactive"; this.onstop?.(); }
}

function mount() {
  const setCustomError = vi.fn();
  const onImportCustom = vi.fn(async () => {});
  const runCustom = vi.fn(async (work: () => Promise<void>) => { await work(); });
  const hook = useClipRecorder({ full: false, setCustomError, runCustom, onImportCustom });
  const cleanups = react.effects.map(run => run()).filter((c): c is () => void => typeof c === "function");
  return { hook, setCustomError, onImportCustom, runCustom, unmount: () => cleanups.forEach(c => c()) };
}

beforeEach(() => {
  react.effects = [];
  started = 0;
  built = 0;
  vi.useFakeTimers();
  vi.stubGlobal("MediaRecorder", FakeRecorder);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("closing the sound menu while the microphone prompt is pending", () => {
  it("records nothing, imports nothing, and lets the microphone go", async () => {
    const mic = pendingMicrophone();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: mic.getUserMedia } });
    const { hook, runCustom, onImportCustom, unmount } = mount();

    const press = hook.startRecording();
    expect(mic.getUserMedia).toHaveBeenCalledTimes(1);
    unmount();

    const { stream, tracks } = fakeStream();
    mic.answer(stream);
    await press;
    await vi.advanceTimersByTimeAsync(RECORDING_LIMIT_MS + 1000);

    expect(built).toBe(0);
    expect(started).toBe(0);
    expect(runCustom).not.toHaveBeenCalled();
    expect(onImportCustom).not.toHaveBeenCalled();
    expect(tracks.map(t => t.stops)).toEqual([1, 1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("says nothing about a refusal that arrives after the menu closed", async () => {
    const mic = pendingMicrophone();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: mic.getUserMedia } });
    const { hook, setCustomError, unmount } = mount();

    const press = hook.startRecording();
    unmount();
    mic.refuse(new Error("NotAllowedError"));
    await press;

    expect(setCustomError.mock.calls).toEqual([[""]]);
  });

  it("still records and imports when the menu stays open", async () => {
    // The guard must not cost the ordinary case: the answer arrives with the
    // section mounted, the recorder runs to its limit, and the clip is saved.
    const mic = pendingMicrophone();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: mic.getUserMedia } });
    const { hook, onImportCustom } = mount();

    const press = hook.startRecording();
    const { stream, tracks } = fakeStream();
    mic.answer(stream);
    await press;
    expect(started).toBe(1);
    await vi.advanceTimersByTimeAsync(RECORDING_LIMIT_MS);

    expect(onImportCustom).toHaveBeenCalledTimes(1);
    expect(tracks.map(t => t.stops)).toEqual([1, 1]);
  });
});
