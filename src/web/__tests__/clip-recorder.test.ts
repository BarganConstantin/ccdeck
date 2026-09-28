// The recorder's three rules, called rather than read (#1207): which container
// a recording is made in, what file it is imported as, and when it stops on
// its own.
//
// They sat inside the hook's MediaRecorder callbacks, where the only way to
// check them was to read the source. The one worth the most is the handoff: a
// recording goes through the same import as a file somebody picked, and the
// import refuses any type it does not know. A container the recorder can pick
// and the import refuses is a Record button that fails every time on that
// browser, after the person has spoken for four seconds.
import { describe, it, expect, vi } from "vitest";
import {
  RECORDING_FORMATS, RECORDING_LIMIT_MS, recordedClipName, recordingFormat,
} from "../use-clip-recorder";
import { importCustomAudio, MAX_CUSTOM_AUDIO_SECONDS, validateAudioImport } from "../notification-audio";

const decode = () => vi.fn(async () => ({ duration: 2, numberOfChannels: 1, getChannelData: () => new Float32Array([0.4]) }));

describe("the container a recording is made in", () => {
  it("takes the first one the browser can write, in the order asked", () => {
    expect(recordingFormat(() => true)).toBe("audio/webm;codecs=opus");
    expect(recordingFormat(type => type !== "audio/webm;codecs=opus")).toBe("audio/ogg;codecs=opus");
    expect(recordingFormat(type => type === "audio/mp4")).toBe("audio/mp4");
  });

  it("leaves the choice to the browser when it can write none of them", () => {
    expect(recordingFormat(() => false)).toBeUndefined();
  });

  it("asks the browser about each format until one answers yes", () => {
    const asked: string[] = [];
    recordingFormat(type => { asked.push(type); return type === "audio/ogg;codecs=opus"; });
    expect(asked).toEqual(["audio/webm;codecs=opus", "audio/ogg;codecs=opus"]);
  });
});

describe("the file a recording is imported as", () => {
  it("names each container by its own extension and drops the codec", () => {
    expect(recordedClipName("audio/webm;codecs=opus")).toEqual({ name: "Recorded voice.webm", type: "audio/webm" });
    expect(recordedClipName("audio/ogg;codecs=opus")).toEqual({ name: "Recorded voice.ogg", type: "audio/ogg" });
    expect(recordedClipName("audio/mp4")).toEqual({ name: "Recorded voice.m4a", type: "audio/mp4" });
  });

  it("calls a container it does not recognise webm", () => {
    // A browser left to choose may report its container late or not at all.
    expect(recordedClipName("")).toEqual({ name: "Recorded voice.webm", type: "" });
  });

  it("is a file the import accepts, for every container the recorder can pick and the browser's own", () => {
    for (const mimeType of [...RECORDING_FORMATS, ""]) {
      const { name, type } = recordedClipName(mimeType);
      expect(validateAudioImport({ name, type, size: 1 }), mimeType || "browser's choice").toBeNull();
    }
  });

  it("lands in the library as \"Recorded voice\", whatever container it was made in", async () => {
    for (const mimeType of [...RECORDING_FORMATS, ""]) {
      const { name, type } = recordedClipName(mimeType);
      const clip = Object.assign(new Blob([new Uint8Array(8)], { type }), { name });
      const asset = await importCustomAudio(clip, decode(), `rec-${mimeType}`);
      expect(asset.name, mimeType || "browser's choice").toBe("Recorded voice");
    }
  });
});

describe("when a recording stops on its own", () => {
  it("stops before the import's length limit", () => {
    expect(RECORDING_LIMIT_MS).toBeLessThan(MAX_CUSTOM_AUDIO_SECONDS * 1000);
    expect(RECORDING_LIMIT_MS).toBe(4400);
  });
});
