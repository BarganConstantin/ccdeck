// Where the desktop app keeps the notification sounds and voices a person adds
// from the sound menu (#1207), and the checks every write passes first.
//
// The page reaches this through preload.cjs, and that page is only as
// trustworthy as whatever the deck serves on its port. So nothing here takes a
// path, a size or a count on the page's word: an asset is addressed by an
// opaque id that never becomes part of a path, its bytes, length and gain are
// held to the same limits the page's own importer applies, and the library has
// a ceiling — without one, a page could put asset after asset until the disk
// was full, and every one of them would be read back on every chime.
//
// Knows nothing about Electron, so it can be pinned directly. main.mjs owns the
// IPC and who is allowed to call it.
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export const MAX_BYTES = 1024 * 1024;
export const MAX_SECONDS = 5;
/** More than anyone needs for two tones, and a bound on what one file holds:
 *  at the byte limit, base64 on disk, this is about 32 MB. */
export const MAX_ASSETS = 24;
const MAX_GAIN = 16;
const MIMES = new Set(["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3", "audio/ogg", "audio/webm", "audio/mp4"]);

export function validAssetId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9._-]{1,96}$/.test(id);
}

/** The asset as it may be stored, or null when any part of it is out of bounds.
 *  Built field by field, so nothing the page adds rides along to disk. */
export function cleanAsset(asset) {
  if (!asset || typeof asset !== "object" || !validAssetId(asset.id) || typeof asset.name !== "string") return null;
  const name = asset.name.trim().slice(0, 80);
  if (!name) return null;
  if (asset.kind === "tts") {
    if (typeof asset.text !== "string" || !asset.text.trim() || asset.text.length > 180) return null;
    if (typeof asset.voiceURI !== "string" || asset.voiceURI.length > 240) return null;
    if (!Number.isFinite(asset.rate) || asset.rate < 0.5 || asset.rate > 2) return null;
    if (!Number.isFinite(asset.pitch) || asset.pitch < 0.5 || asset.pitch > 2) return null;
    return { id: asset.id, name, kind: "tts", text: asset.text.trim(), voiceURI: asset.voiceURI, rate: asset.rate, pitch: asset.pitch };
  }
  if (asset.kind !== "audio" || typeof asset.mime !== "string" || !MIMES.has(asset.mime)) return null;
  if (!Number.isFinite(asset.duration) || asset.duration <= 0 || asset.duration > MAX_SECONDS) return null;
  if (!Number.isFinite(asset.normalizationGain) || asset.normalizationGain <= 0 || asset.normalizationGain > MAX_GAIN) return null;
  const bytes = asset.bytes instanceof ArrayBuffer
    ? Buffer.from(new Uint8Array(asset.bytes))
    : ArrayBuffer.isView(asset.bytes)
      ? Buffer.from(asset.bytes.buffer, asset.bytes.byteOffset, asset.bytes.byteLength)
      : null;
  if (!bytes || bytes.byteLength <= 0 || bytes.byteLength > MAX_BYTES) return null;
  return { id: asset.id, name, kind: "audio", mime: asset.mime, duration: asset.duration, normalizationGain: asset.normalizationGain, bytes };
}

/** On disk the bytes are base64, so the library stays one JSON file. */
function toDisk(asset) {
  return asset.kind === "audio" ? { ...asset, bytes: asset.bytes.toString("base64") } : asset;
}

/** Back over IPC they are an ArrayBuffer, which is what decodeAudioData takes. */
function toWire(asset) {
  if (!asset || asset.kind !== "audio" || typeof asset.bytes !== "string") return asset;
  const bytes = Buffer.from(asset.bytes, "base64");
  return { ...asset, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

/** @param {() => string} file Where the library lives, asked for on first use
 *  so it can be the app's userData folder. */
export function createNotificationAudioStore(file) {
  // Read once and kept. A `get` runs on every chime, on the main process, and
  // parsing a file of up to MAX_ASSETS clips each time would stall the window.
  let assets = null;

  function read() {
    if (assets) return assets;
    try {
      const parsed = JSON.parse(readFileSync(file(), "utf8"));
      assets = Array.isArray(parsed) ? parsed.filter(a => a && typeof a === "object" && validAssetId(a.id)) : [];
    } catch {
      assets = [];
    }
    return assets;
  }

  // Written beside and renamed over. A write cut short in place left half a
  // JSON file, which reads back as an empty library — and the next put then
  // saved that, losing every sound the person had added.
  function write(next) {
    const path = file();
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next)}\n`, "utf8");
    renameSync(tmp, path);
    assets = next;
  }

  return {
    list: () => read().map(toWire),
    get(id) {
      if (!validAssetId(id)) return null;
      const found = read().find(a => a.id === id);
      return found ? toWire(found) : null;
    },
    put(asset) {
      const clean = cleanAsset(asset);
      if (!clean) throw new Error("Invalid notification audio asset.");
      const current = read();
      const rest = current.filter(a => a.id !== clean.id);
      // A rename replaces; only a new asset counts against the ceiling.
      if (rest.length === current.length && current.length >= MAX_ASSETS) {
        throw new Error(`There are already ${MAX_ASSETS} custom sounds. Delete one first.`);
      }
      write([...rest, toDisk(clean)]);
    },
    remove(id) {
      if (!validAssetId(id)) return;
      const current = read();
      const rest = current.filter(a => a.id !== id);
      if (rest.length !== current.length) write(rest);
    },
  };
}
