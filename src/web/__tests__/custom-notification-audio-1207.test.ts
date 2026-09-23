import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CUSTOM_AUDIO_KEYS, MAX_CUSTOM_ASSETS, MAX_CUSTOM_AUDIO_BYTES, clearCustomAssetSelections,
  createCustomVoice, deleteCustomNotificationAsset, getCustomNotificationAsset,
  importCustomAudio, libraryFullReason, listCustomNotificationAssets, newAssetId, normalizationGain,
  readCustomSelections, renameCustomNotificationAsset, sameCustomSelection, saveCustomNotificationAsset,
  summarizeCustomAsset, validateAudioImport,
  type CustomAudioAsset, type CustomNotificationAsset, type CustomVoiceAsset,
} from "../notification-audio";
import { createChimePlayer, DEFAULT_FIGURE_ID, DEFAULT_PREFS } from "../sound";
import { withoutComments } from "./tsx-scan";

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

// ── the listing and the bytes ───────────────────────────────────────────────
//
// The menu used to be handed every clip whole at boot — up to 24 × 1 MB, read
// with `getAll` in a browser and decoded and copied over IPC in the desktop app
// — and to keep them in React state for a list that only ever drew names. Now
// `list` is the listing and nothing else, and the player asks for one clip's
// bytes when it plays that clip.

const clip = (): CustomAudioAsset => ({
  id: "clip-1", name: "Chime", kind: "audio", mime: "audio/wav", duration: 1.5,
  normalizationGain: 2, bytes: new Uint8Array([1, 2, 3, 4]).buffer,
});
const voice = (): CustomVoiceAsset => ({
  id: "voice-1", name: "Voice", kind: "tts", text: "Your turn", voiceURI: "", rate: 1, pitch: 1,
});
const clipRow = { id: "clip-1", name: "Chime", kind: "audio", mime: "audio/wav", duration: 1.5, normalizationGain: 2 };
const source = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
/** Comment-stripped, so a sentence explaining the code cannot pass for it. */
const menu = withoutComments(source("components/SoundMenu.tsx"));
const app = withoutComments(source("App.tsx"));
const bytesOf = (asset: CustomNotificationAsset | null) =>
  asset?.kind === "audio" ? [...new Uint8Array(asset.bytes)] : null;

/**
 * Just enough IndexedDB for notification-audio.ts, in memory: a versioned
 * open with its upgrade transaction, and get / getAll / put / delete /
 * openCursor inside transactions that commit once their last request has
 * answered. Every value goes in and comes out through structuredClone, as it
 * would through the real thing. `reads` names the store each read touched,
 * which is the whole question for the listing.
 */
function memoryIdb(seed: { version: number; stores: Record<string, { id: string }[]> } = { version: 0, stores: {} }) {
  let version = seed.version;
  const data = new Map(Object.entries(seed.stores).map(([name, rows]) =>
    [name, new Map(rows.map(row => [row.id, structuredClone(row)]))] as const));
  const reads: string[] = [];
  const later = (fn: () => void) => { setTimeout(fn, 0); };
  type Req = { result: unknown; onsuccess: null | (() => void) };

  function transaction() {
    let pending = 0;
    let done = false;
    const tx = {
      error: null,
      oncomplete: null as null | (() => void),
      onerror: null as null | (() => void),
      onabort: null as null | (() => void),
      settle() {
        if (pending > 0 || done) return;
        done = true;
        later(() => tx.oncomplete?.());
      },
      ask(work: () => unknown, req: Req = { result: undefined, onsuccess: null }) {
        pending++;
        later(() => { req.result = work(); req.onsuccess?.(); pending--; tx.settle(); });
        return req;
      },
      objectStore(name: string) {
        const rows = () => data.get(name)!;
        return {
          get: (id: string) => tx.ask(() => { reads.push(name); return structuredClone(rows().get(id)); }),
          getAll: () => tx.ask(() => { reads.push(name); return [...rows().values()].map(row => structuredClone(row)); }),
          put: (row: { id: string }) => tx.ask(() => { rows().set(row.id, structuredClone(row)); return row.id; }),
          delete: (id: string) => tx.ask(() => { rows().delete(id); }),
          openCursor: () => {
            const keys = [...rows().keys()];
            const req: Req = { result: null, onsuccess: null };
            const step = (i: number): Req => tx.ask(() => {
              reads.push(name);
              return i < keys.length ? { value: structuredClone(rows().get(keys[i])), continue: () => { step(i + 1); } } : null;
            }, req);
            return step(0);
          },
        };
      },
    };
    // A transaction nobody asks anything of still commits.
    later(() => tx.settle());
    return tx;
  }

  const factory = {
    open(_name: string, want: number) {
      const req = {
        result: null as unknown,
        error: null,
        transaction: null as ReturnType<typeof transaction> | null,
        onupgradeneeded: null as null | ((event: { oldVersion: number }) => void),
        onsuccess: null as null | (() => void),
        onerror: null as null | (() => void),
      };
      later(() => {
        let upgrade: ReturnType<typeof transaction> | null = null;
        req.result = {
          objectStoreNames: { contains: (name: string) => data.has(name) },
          createObjectStore: (name: string) => { data.set(name, new Map()); return upgrade!.objectStore(name); },
          transaction: () => transaction(),
          close: () => {},
        };
        if (want <= version) { req.onsuccess?.(); return; }
        const old = version;
        upgrade = transaction();
        upgrade.oncomplete = () => { version = want; req.transaction = null; req.onsuccess?.(); };
        req.transaction = upgrade;
        req.onupgradeneeded?.({ oldVersion: old });
      });
      return req;
    },
  };
  return { factory, reads, stores: data };
}

describe("the listing carries no bytes (#1207)", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("is the asset without its bytes, and a voice as it is", () => {
    expect(summarizeCustomAsset(clip())).toEqual(clipRow);
    expect(summarizeCustomAsset(voice())).toEqual(voice());
  });

  it("lists from a browser without opening the store the bytes are in, and plays from it", async () => {
    const idb = memoryIdb();
    vi.stubGlobal("indexedDB", idb.factory);
    await saveCustomNotificationAsset(clip());
    await saveCustomNotificationAsset(voice());
    idb.reads.length = 0;
    const listed = await listCustomNotificationAssets();
    expect(listed).toEqual([clipRow, voice()]);
    expect(idb.reads).toEqual(["summaries"]);
    expect(bytesOf(await getCustomNotificationAsset("clip-1"))).toEqual([1, 2, 3, 4]);
  });

  it("builds the listing once from a library saved before it had one", async () => {
    // Version 1 kept whole assets and nothing else. Were the upgrade to skip
    // them, the boot load would find no row for a chosen id and clear the
    // tone it was chosen for — a person's sound gone because of a schema.
    const idb = memoryIdb({ version: 1, stores: { assets: [clip(), voice()] } });
    vi.stubGlobal("indexedDB", idb.factory);
    expect(await listCustomNotificationAssets()).toEqual([clipRow, voice()]);
    idb.reads.length = 0;
    expect(await listCustomNotificationAssets()).toHaveLength(2);
    expect(idb.reads).toEqual(["summaries"]);
    expect(bytesOf(await getCustomNotificationAsset("clip-1"))).toEqual([1, 2, 3, 4]);
  });

  it("renames in both stores and keeps the bytes, and deletes from both", async () => {
    const idb = memoryIdb();
    vi.stubGlobal("indexedDB", idb.factory);
    await saveCustomNotificationAsset(clip());
    await saveCustomNotificationAsset(voice());
    await renameCustomNotificationAsset("clip-1", "Renamed");
    expect((await listCustomNotificationAssets())[0]).toEqual({ ...clipRow, name: "Renamed" });
    const renamed = await getCustomNotificationAsset("clip-1");
    expect(renamed?.name).toBe("Renamed");
    expect(bytesOf(renamed)).toEqual([1, 2, 3, 4]);
    // One that is gone by now stays gone rather than coming back as a row.
    await renameCustomNotificationAsset("gone", "Ghost");
    expect(await listCustomNotificationAssets()).toHaveLength(2);
    await deleteCustomNotificationAsset("clip-1");
    expect((await listCustomNotificationAssets()).map(row => row.id)).toEqual(["voice-1"]);
    expect(await getCustomNotificationAsset("clip-1")).toBeNull();
    expect([...idb.stores.get("assets")!.keys()]).toEqual(["voice-1"]);
  });

  it("keeps only the listing in the deck's state, and gives an import back as a row", () => {
    expect(app).toMatch(/useState<CustomAssetSummary\[\]>\(\[\]\)/);
    expect(menu).toMatch(/customAssets: CustomAssetSummary\[\];/);
    // Both ways a sound is added put its row in state, never the asset.
    expect([...app.matchAll(/const row = summarizeCustomAsset\(asset\);\s*setCustomAssets\(prev => \[\.\.\.prev\.filter\(item => item\.id !== row\.id\), row\]\);/g)]).toHaveLength(2);
    expect(app).toMatch(/await renameCustomNotificationAsset\(id, nextName\);/);
  });

  it("renames through the desktop bridge's own get and put, bytes and all", async () => {
    const stored = new Map<string, CustomNotificationAsset>([["clip-1", clip()]]);
    const put = vi.fn(async (asset: CustomNotificationAsset) => { stored.set(asset.id, asset); });
    vi.stubGlobal("window", {
      ccdeckNotificationAudio: {
        list: async () => [...stored.values()].map(summarizeCustomAsset),
        get: async (id: string) => stored.get(id) ?? null,
        put,
        remove: async (id: string) => { stored.delete(id); },
      },
    });
    await renameCustomNotificationAsset("clip-1", "Renamed");
    expect(put).toHaveBeenCalledTimes(1);
    expect(bytesOf(stored.get("clip-1")!)).toEqual([1, 2, 3, 4]);
    expect(await listCustomNotificationAssets()).toEqual([{ ...clipRow, name: "Renamed" }]);
    await renameCustomNotificationAsset("gone", "Ghost");
    expect(put).toHaveBeenCalledTimes(1);
  });
});
