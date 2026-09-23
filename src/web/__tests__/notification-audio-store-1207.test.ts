// The desktop half of custom notification audio (#1207): the store the preload
// bridge writes into, and the door in main.mjs that decides who may use it.
//
// The window loads whatever the deck serves on its port, so the preload's four
// calls are the one new thing any page in it can reach. These pin that the
// page cannot name a path, cannot store more or larger than the importer
// allows, cannot fill the disk, and cannot call in from anywhere but the
// deck's own page — that the listing it reads at boot carries no clip's bytes,
// and that the packaged app actually ships the two files.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanAsset, createNotificationAudioStore, MAX_ASSETS, MAX_BYTES, MAX_SECONDS, validAssetId,
} from "../../../desktop/notification-audio-store.mjs";

const desktop = (name: string) => readFileSync(fileURLToPath(new URL(`../../../desktop/${name}`, import.meta.url)), "utf8");

const clip = (over: Record<string, unknown> = {}) => ({
  id: "clip-1", name: "Chime", kind: "audio", mime: "audio/wav", duration: 1.5,
  normalizationGain: 2, bytes: new Uint8Array([1, 2, 3, 4]).buffer, ...over,
});
const voice = (over: Record<string, unknown> = {}) => ({
  id: "voice-1", name: "Voice", kind: "tts", text: "Your turn", voiceURI: "", rate: 1, pitch: 1, ...over,
});

describe("what the desktop store will hold (#1207)", () => {
  it("addresses assets by an id that cannot be a path", () => {
    expect(validAssetId("3f1c2a9e-8b7d-4c1a-9f00-123456789abc")).toBe(true);
    for (const id of ["../etc", "a/b", "a\\b", "", "x".repeat(97), 7, null]) expect(validAssetId(id)).toBe(false);
  });

  it("refuses a clip over the importer's own limits, whatever the page claims", () => {
    expect(cleanAsset(clip())).not.toBeNull();
    expect(cleanAsset(clip({ bytes: new ArrayBuffer(MAX_BYTES + 1) }))).toBeNull();
    expect(cleanAsset(clip({ bytes: new ArrayBuffer(0) }))).toBeNull();
    expect(cleanAsset(clip({ bytes: "AAAA" }))).toBeNull();
    expect(cleanAsset(clip({ duration: MAX_SECONDS + 0.01 }))).toBeNull();
    expect(cleanAsset(clip({ duration: Number.NaN }))).toBeNull();
    expect(cleanAsset(clip({ mime: "text/html" }))).toBeNull();
    expect(cleanAsset(clip({ normalizationGain: 17 }))).toBeNull();
    expect(cleanAsset(clip({ name: "   " }))).toBeNull();
    expect(cleanAsset(clip({ id: "../clip" }))).toBeNull();
  });

  it("refuses a voice outside its bounds, and stores only the fields it knows", () => {
    expect(cleanAsset(voice({ text: "x".repeat(181) }))).toBeNull();
    expect(cleanAsset(voice({ rate: 3 }))).toBeNull();
    expect(cleanAsset(voice({ pitch: 0.1 }))).toBeNull();
    expect(cleanAsset(voice({ voiceURI: 4 }))).toBeNull();
    expect(cleanAsset(voice({ path: "/etc/passwd", name: ` ${"n".repeat(100)} ` })))
      .toEqual({ id: "voice-1", name: "n".repeat(80), kind: "tts", text: "Your turn", voiceURI: "", rate: 1, pitch: 1 });
  });
});

describe("the desktop store on disk (#1207)", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccdeck-audio-"));
    file = join(dir, "notification-audio.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("round-trips a clip's bytes and a voice across a restart", () => {
    const store = createNotificationAudioStore(() => file);
    store.put(clip());
    store.put(voice());
    const again = createNotificationAudioStore(() => file);
    const got = again.get("clip-1");
    expect(got?.bytes).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(got.bytes)]).toEqual([1, 2, 3, 4]);
    expect(again.get("voice-1")).toMatchObject({ kind: "tts", text: "Your turn" });
    expect(again.list().map((a: { id: string }) => a.id)).toEqual(["clip-1", "voice-1"]);
    expect(again.get("../clip-1")).toBeNull();
  });

  it("lists names and lengths without a single clip's bytes, which only get hands out", () => {
    // The menu reads the listing at every start, over IPC: at the ceiling and
    // the byte limit, decoding every clip for it was about 24 MB copied into a
    // page that only drew names. The bytes go out one clip at a time, to play.
    const store = createNotificationAudioStore(() => file);
    store.put(clip());
    store.put(voice());
    const listed = createNotificationAudioStore(() => file).list();
    expect(listed).toEqual([
      { id: "clip-1", name: "Chime", kind: "audio", mime: "audio/wav", duration: 1.5, normalizationGain: 2 },
      { id: "voice-1", name: "Voice", kind: "tts", text: "Your turn", voiceURI: "", rate: 1, pitch: 1 },
    ]);
    for (const row of listed) expect(row).not.toHaveProperty("bytes");
    expect(store.get("clip-1")?.bytes).toBeInstanceOf(ArrayBuffer);
  });

  it("lists only the fields it knows, whatever else the file holds", () => {
    // Built field by field like cleanAsset, so a hand-edited file cannot put
    // its bytes, or anything else, back into the listing under another name.
    writeFileSync(file, JSON.stringify([
      { id: "clip-1", name: "Chime", kind: "audio", mime: "audio/wav", duration: 1, normalizationGain: 1, bytes: "AQID", extra: "x" },
      { id: "odd-1", name: "Odd", kind: "video", bytes: "AQID" },
    ]));
    expect(createNotificationAudioStore(() => file).list())
      .toEqual([{ id: "clip-1", name: "Chime", kind: "audio", mime: "audio/wav", duration: 1, normalizationGain: 1 }]);
  });

  it("renames in place, deletes, and leaves no half-written file behind", () => {
    const store = createNotificationAudioStore(() => file);
    store.put(clip());
    store.put(clip({ name: "Renamed" }));
    expect(store.list()).toHaveLength(1);
    expect(store.get("clip-1")?.name).toBe("Renamed");
    store.remove("clip-1");
    expect(store.list()).toEqual([]);
    expect(readdirSync(dir)).toEqual(["notification-audio.json"]);
  });

  it("stops at the ceiling for a new asset but still lets one be renamed", () => {
    const store = createNotificationAudioStore(() => file);
    for (let i = 0; i < MAX_ASSETS; i++) store.put(voice({ id: `v-${i}` }));
    expect(() => store.put(voice({ id: "one-more" }))).toThrow(/Delete one first/);
    expect(() => store.put(voice({ id: "v-0", name: "Renamed" }))).not.toThrow();
    expect(store.list()).toHaveLength(MAX_ASSETS);
  });

  it("refuses an invalid asset without touching the file", () => {
    const store = createNotificationAudioStore(() => file);
    expect(() => store.put(clip({ duration: 60 }))).toThrow(/Invalid/);
    expect(existsSync(file)).toBe(false);
  });

  it("reads a damaged file as an empty library rather than failing every call", () => {
    writeFileSync(file, "{ not json");
    expect(createNotificationAudioStore(() => file).list()).toEqual([]);
  });
});

describe("the bridge and who may use it (#1207)", () => {
  const main = desktop("main.mjs");
  const preload = desktop("preload.cjs");

  it("exposes four calls by id and nothing that takes a path", () => {
    expect(preload.match(/exposeInMainWorld\(/g)).toHaveLength(1);
    const calls = [...preload.matchAll(/^\s+(\w+): .*ipcRenderer\.invoke\("ccdeck:notification-audio:(\w+)"/gm)];
    expect(calls.map(m => [m[1], m[2]])).toEqual([["list", "list"], ["get", "get"], ["put", "put"], ["remove", "remove"]]);
    expect(preload).not.toMatch(/ipcRenderer\.(send|on)\b|require\("(fs|path|child_process)"\)/);
  });

  it("loads the preload into the same sandboxed, isolated window", () => {
    const prefs = main.match(/webPreferences: \{[\s\S]*?\n {4}\}/)?.[0] ?? "";
    expect(prefs).toMatch(/contextIsolation: true/);
    expect(prefs).toMatch(/nodeIntegration: false/);
    expect(prefs).toMatch(/sandbox: true/);
    expect(prefs).toMatch(/preload: join\(here, "preload\.cjs"\)/);
  });

  it("answers only the deck's own page in the deck's own window", () => {
    const door = main.match(/function fromDeckPage\(event\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(door).toMatch(/event\.sender\.id !== win\.webContents\.id/);
    expect(door).toMatch(/navigationFor\(url, `http:\/\/127\.0\.0\.1:\$\{deck\.port\}`\) === "stay"/);
    // One registration, and it is the one that checks the sender first.
    expect(main.match(/ipcMain\.handle\(/g)).toHaveLength(1);
    expect(main).toMatch(/ipcMain\.handle\(`ccdeck:notification-audio:\$\{name\}`, \(event, arg\) => \{\n\s+if \(!fromDeckPage\(event\)\) throw/);
  });

  it("ships the preload and the store in the packaged app", () => {
    const config = desktop("electron-builder.config.cjs");
    expect(config).toMatch(/"preload\.cjs"/);
    expect(config).toMatch(/"notification-audio-store\.mjs"/);
  });
});
