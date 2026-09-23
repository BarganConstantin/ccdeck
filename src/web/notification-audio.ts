import type { Chime } from "./sound";

export const MAX_CUSTOM_AUDIO_BYTES = 1024 * 1024;
export const MAX_CUSTOM_AUDIO_SECONDS = 5;
export const CUSTOM_TARGET_PEAK = 0.8;

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

type DecodedAudio = {
  duration: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
};

type DesktopAssetBridge = {
  list(): Promise<CustomNotificationAsset[]>;
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

export function normalizationGain(channels: readonly Float32Array[]): number {
  let peak = 0;
  for (const samples of channels) {
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  }
  if (peak <= 0.00001) return 1;
  return Math.min(16, CUSTOM_TARGET_PEAK / peak);
}

export async function importCustomAudio(
  file: Blob & { name?: string; type: string; size: number },
  decode: (bytes: ArrayBuffer) => Promise<DecodedAudio>,
  id = crypto.randomUUID(),
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
}, id = crypto.randomUUID()): CustomVoiceAsset {
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
const STORE = "assets";

function desktopBridge(): DesktopAssetBridge | null {
  return typeof window !== "undefined" ? window.ccdeckNotificationAudio ?? null : null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Could not open local audio storage."));
  });
}

async function idbRequest<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("Local audio storage failed."));
    });
  } finally {
    db.close();
  }
}

export async function listCustomNotificationAssets(): Promise<CustomNotificationAsset[]> {
  const bridge = desktopBridge();
  if (bridge) return bridge.list();
  if (typeof indexedDB === "undefined") return [];
  return idbRequest("readonly", store => store.getAll());
}

export async function getCustomNotificationAsset(id: string): Promise<CustomNotificationAsset | null> {
  const bridge = desktopBridge();
  if (bridge) return bridge.get(id);
  if (typeof indexedDB === "undefined") return null;
  return (await idbRequest<CustomNotificationAsset | undefined>("readonly", store => store.get(id))) ?? null;
}

export async function saveCustomNotificationAsset(asset: CustomNotificationAsset): Promise<void> {
  const bridge = desktopBridge();
  if (bridge) { await bridge.put(asset); return; }
  if (typeof indexedDB === "undefined") throw new Error("Local audio storage is unavailable in this browser.");
  await idbRequest("readwrite", store => store.put(asset));
}

export async function deleteCustomNotificationAsset(id: string): Promise<void> {
  const bridge = desktopBridge();
  if (bridge) { await bridge.remove(id); return; }
  if (typeof indexedDB === "undefined") return;
  await idbRequest("readwrite", store => store.delete(id));
}
