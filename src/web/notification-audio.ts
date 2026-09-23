import type { Chime } from "./sound";

export const MAX_CUSTOM_AUDIO_BYTES = 1024 * 1024;
export const MAX_CUSTOM_AUDIO_SECONDS = 5;
export const CUSTOM_TARGET_PEAK = 0.8;
/** The same ceiling the desktop store enforces (desktop/notification-audio-store.mjs),
 *  checked here too so the person reads why rather than an IPC error. */
export const MAX_CUSTOM_ASSETS = 24;

const DONE_CUSTOM_KEY = "agent-dag.soundCustom.done";
const ASKING_CUSTOM_KEY = "agent-dag.soundCustom.needs-input";
export const CUSTOM_AUDIO_KEYS: Record<Chime, string> = {
  done: DONE_CUSTOM_KEY,
  "needs-input": ASKING_CUSTOM_KEY,
};

export type CustomSelections = Record<Chime, string | null>;
export const EMPTY_CUSTOM_SELECTIONS: CustomSelections = { done: null, "needs-input": null };

export interface CustomAudioAsset {
  id: string;
  name: string;
  kind: "audio";
  mime: string;
  duration: number;
  normalizationGain: number;
  bytes: ArrayBuffer;
}

export interface CustomVoiceAsset {
  id: string;
  name: string;
  kind: "tts";
  text: string;
  voiceURI: string;
  rate: number;
  pitch: number;
}

export type CustomNotificationAsset = CustomAudioAsset | CustomVoiceAsset;

/** What the sound menu lists: every field but a clip's bytes. A menu row needs
 *  a name, a kind and a length, and the bytes are up to a megabyte a clip —
 *  twenty-four of them decoded, carried over IPC and held in React state from
 *  boot, for a list that only ever read the names. Playback asks for the one
 *  clip it is about to play (`getCustomNotificationAsset`), when it plays it. */
export type CustomAssetSummary = Omit<CustomAudioAsset, "bytes"> | CustomVoiceAsset;

export function summarizeCustomAsset(asset: CustomNotificationAsset): CustomAssetSummary {
  if (asset.kind !== "audio") return asset;
  const { bytes: _bytes, ...summary } = asset;
  return summary;
}

type DecodedAudio = {
  duration: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
};

type DesktopAssetBridge = {
  list(): Promise<CustomAssetSummary[]>;
  get(id: string): Promise<CustomNotificationAsset | null>;
  put(asset: CustomNotificationAsset): Promise<void>;
  remove(id: string): Promise<void>;
};

declare global {
  interface Window {
    ccdeckNotificationAudio?: DesktopAssetBridge;
  }
}

function safeId(raw: string | null | undefined): string | null {
  if (!raw || !/^[a-zA-Z0-9._-]{1,96}$/.test(raw)) return null;
  return raw;
}

export function readCustomSelections(read: (key: string) => string | null): CustomSelections {
  return {
    done: safeId(read(CUSTOM_AUDIO_KEYS.done)),
    "needs-input": safeId(read(CUSTOM_AUDIO_KEYS["needs-input"])),
  };
}

export function clearCustomAssetSelections(current: CustomSelections, id: string): CustomSelections {
  return {
    done: current.done === id ? null : current.done,
    "needs-input": current["needs-input"] === id ? null : current["needs-input"],
  };
}

export function sameCustomSelection(current: CustomSelections): string | null {
  return current.done && current.done === current["needs-input"] ? current.done : null;
}

const MIME_BY_EXT: Record<string, string> = {
  wav: "audio/wav",
  wave: "audio/wav",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  webm: "audio/webm",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
};

const ALLOWED_AUDIO_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3", "audio/ogg", "audio/webm", "audio/mp4"]);

export function audioMime(name: string, declared: string): string {
  const clean = declared.toLowerCase().split(";")[0].trim();
  if (ALLOWED_AUDIO_TYPES.has(clean)) return clean;
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return MIME_BY_EXT[ext] ?? clean;
}

export function validateAudioImport(meta: { name: string; type: string; size: number }, duration?: number): string | null {
  const mime = audioMime(meta.name, meta.type);
  if (!ALLOWED_AUDIO_TYPES.has(mime)) return "Use a WAV, MP3, OGG, or browser-recorded audio file.";
  if (!Number.isFinite(meta.size) || meta.size <= 0) return "The audio file is empty.";
  if (meta.size > MAX_CUSTOM_AUDIO_BYTES) return "Audio must be 1 MB or smaller.";
  if (duration !== undefined) {
    if (!Number.isFinite(duration) || duration <= 0) return "The audio file could not be decoded.";
    if (duration > MAX_CUSTOM_AUDIO_SECONDS) return `Audio must be ${MAX_CUSTOM_AUDIO_SECONDS} seconds or shorter.`;
  }
  return null;
}

/** Why another custom sound cannot be added, or null when it can. */
export function libraryFullReason(count: number): string | null {
  return count >= MAX_CUSTOM_ASSETS ? `There are already ${MAX_CUSTOM_ASSETS} custom sounds. Delete one first.` : null;
}

/**
 * Which row's Delete takes focus once `id`'s row is gone, or null for the
 * import control. The row that held focus is removed by the press, and a
 * keyboard user left on `<body>` starts again from the top of the document
 * (2.4.3). The next row first, so repeated deleting walks down the list the way
 * the eye does; the previous one when the last row went; the control that adds
 * a sound when there is no row left to land on.
 */
export function deleteFocusTarget(ids: readonly string[], id: string): string | null {
  const at = ids.indexOf(id);
  if (at < 0) return null;
  return ids[at + 1] ?? ids[at - 1] ?? null;
}

export function normalizationGain(channels: readonly Float32Array[]): number {
  let peak = 0;
  for (const samples of channels) {
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  }
  if (peak <= 0.00001) return 1;
  return Math.min(16, CUSTOM_TARGET_PEAK / peak);
}

/** A new asset's id. `crypto.randomUUID` exists only in a secure context, and a
 *  deck reached over the LAN is plain http — the same fallback presence.ts
 *  uses, in the alphabet `safeId` and the desktop store accept. */
export function newAssetId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch { /* not a secure context */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function importCustomAudio(
  file: Blob & { name?: string; type: string; size: number },
  decode: (bytes: ArrayBuffer) => Promise<DecodedAudio>,
  id = newAssetId(),
): Promise<CustomAudioAsset> {
  const name = file.name?.trim() || "Custom sound";
  const firstError = validateAudioImport({ name, type: file.type, size: file.size });
  if (firstError) throw new Error(firstError);
  const bytes = await file.arrayBuffer();
  let decoded: DecodedAudio;
  try {
    decoded = await decode(bytes.slice(0));
  } catch {
    throw new Error("The audio file could not be decoded.");
  }
  const decodedError = validateAudioImport({ name, type: file.type, size: file.size }, decoded.duration);
  if (decodedError) throw new Error(decodedError);
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, channel) => decoded.getChannelData(channel));
  return {
    id,
    name: name.replace(/\.(wav|wave|mp3|ogg|oga|webm|m4a|mp4)$/i, "") || "Custom sound",
    kind: "audio",
    mime: audioMime(name, file.type),
    duration: decoded.duration,
    normalizationGain: normalizationGain(channels),
    bytes,
  };
}

export function createCustomVoice(input: {
  name: string;
  text: string;
  voiceURI?: string;
  rate?: number;
  pitch?: number;
}, id = newAssetId()): CustomVoiceAsset {
  const name = input.name.trim() || "Custom voice";
  const text = input.text.trim();
  if (!text) throw new Error("Enter the words this voice should say.");
  const rate = Number.isFinite(input.rate) ? input.rate! : 1;
  const pitch = Number.isFinite(input.pitch) ? input.pitch! : 1;
  return {
    id,
    name,
    kind: "tts",
    text: text.slice(0, 180),
    voiceURI: input.voiceURI ?? "",
    rate: Math.min(2, Math.max(0.5, rate)),
    pitch: Math.min(2, Math.max(0.5, pitch)),
  };
}

const DB_NAME = "ccdeck-notification-audio";
/** Version 2 gave the listing a store of its own; see openDb. */
const DB_VERSION = 2;
/** Whole assets, bytes included, read one at a time to play. */
const STORE = "assets";
/** The same assets without their bytes, which is all `list` reads. */
const SUMMARIES = "summaries";

function desktopBridge(): DesktopAssetBridge | null {
  return typeof window !== "undefined" ? window.ccdeckNotificationAudio ?? null : null;
}

// Two stores rather than one, because IndexedDB has no way to read part of a
// record: a `getAll` over the assets hands back every clip's bytes, and a
// cursor that dropped them would still have read each one off disk first. So
// the listing is written beside the asset, in the same transaction, and the
// menu never opens the store the bytes are in.
//
// A library saved before version 2 has assets and no listing. The upgrade
// builds the listing from them once, inside the version change, so no sound a
// person already added goes missing from the menu — and then from the tone it
// was chosen for, which the boot load clears for any id it cannot find.
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = event => {
      const db = req.result;
      const assets = db.objectStoreNames.contains(STORE)
        ? req.transaction!.objectStore(STORE)
        : db.createObjectStore(STORE, { keyPath: "id" });
      if (db.objectStoreNames.contains(SUMMARIES)) return;
      const summaries = db.createObjectStore(SUMMARIES, { keyPath: "id" });
      if (event.oldVersion < 1) return;
      const walk = assets.openCursor();
      walk.onsuccess = () => {
        const cursor = walk.result;
        if (!cursor) return;
        summaries.put(summarizeCustomAsset(cursor.value as CustomNotificationAsset));
        cursor.continue();
      };
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Could not open local audio storage."));
  });
}

/** One transaction over `stores`, settled when it COMMITS rather than when its
 *  first request answers: a write to both stores is only done when both are,
 *  and a listing that outlived its asset would be a row with nothing to play. */
async function idbRun<T>(
  stores: string[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      const req = run(tx);
      const failed = () => reject(tx.error ?? new Error("Local audio storage failed."));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = failed;
      tx.onabort = failed;
    });
  } finally {
    db.close();
  }
}

export async function listCustomNotificationAssets(): Promise<CustomAssetSummary[]> {
  const bridge = desktopBridge();
  if (bridge) return bridge.list();
  if (typeof indexedDB === "undefined") return [];
  return (await idbRun<CustomAssetSummary[]>([SUMMARIES], "readonly", tx => tx.objectStore(SUMMARIES).getAll())) ?? [];
}

export async function getCustomNotificationAsset(id: string): Promise<CustomNotificationAsset | null> {
  const bridge = desktopBridge();
  if (bridge) return bridge.get(id);
  if (typeof indexedDB === "undefined") return null;
  return (await idbRun<CustomNotificationAsset | undefined>([STORE], "readonly", tx => tx.objectStore(STORE).get(id))) ?? null;
}

export async function saveCustomNotificationAsset(asset: CustomNotificationAsset): Promise<void> {
  const bridge = desktopBridge();
  if (bridge) { await bridge.put(asset); return; }
  if (typeof indexedDB === "undefined") throw new Error("Local audio storage is unavailable in this browser.");
  await idbRun([STORE, SUMMARIES], "readwrite", tx => {
    tx.objectStore(STORE).put(asset);
    tx.objectStore(SUMMARIES).put(summarizeCustomAsset(asset));
  });
}

/**
 * A new name for a stored asset. The menu holds only the listing, so the
 * asset is read back whole and written again under the new name: in the
 * browser inside one transaction, and on the desktop through the bridge's own
 * `get` and `put` — a rename is rare enough that one clip crossing IPC twice
 * costs less than a fifth call on the one surface a page in that window can
 * reach (preload.cjs). An asset that is gone by now is left gone.
 */
export async function renameCustomNotificationAsset(id: string, name: string): Promise<void> {
  const bridge = desktopBridge();
  if (bridge) {
    const found = await bridge.get(id);
    if (found) await bridge.put({ ...found, name });
    return;
  }
  if (typeof indexedDB === "undefined") throw new Error("Local audio storage is unavailable in this browser.");
  await idbRun([STORE, SUMMARIES], "readwrite", tx => {
    const assets = tx.objectStore(STORE);
    const read = assets.get(id);
    read.onsuccess = () => {
      const found = read.result as CustomNotificationAsset | undefined;
      if (!found) return;
      const next = { ...found, name };
      assets.put(next);
      tx.objectStore(SUMMARIES).put(summarizeCustomAsset(next));
    };
  });
}

export async function deleteCustomNotificationAsset(id: string): Promise<void> {
  const bridge = desktopBridge();
  if (bridge) { await bridge.remove(id); return; }
  if (typeof indexedDB === "undefined") return;
  await idbRun([STORE, SUMMARIES], "readwrite", tx => {
    tx.objectStore(STORE).delete(id);
    tx.objectStore(SUMMARIES).delete(id);
  });
}
