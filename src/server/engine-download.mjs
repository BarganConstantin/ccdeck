// The Command Panel's engine fetched from the npm registry, for a deck that
// did not come with it: an install made with --omit=optional, a git checkout,
// a mirror that skipped the platform package.
//
// THE SAME PACKAGE, NOT A SECOND CHANNEL. What is fetched is the platform
// package npm would have installed beside the deck (ENGINE_PACKAGE_NAMES in
// engine-package.mjs), at the exact version the deck's own package.json pins
// in its optionalDependencies — the pin the desktop build reads too
// (desktop/scripts/deck-runtime.cjs). No pin, no download: a deck released
// before the engine packages exist offers none.
//
// THE TRUST IS NOT IN THE REGISTRY. The registry's sha512 integrity is checked
// so a cut or garbled transfer fails here, but what makes an engine trusted is
// what makes the package beside the deck trusted: its manifest signed by one
// of the deck's keys, the executable's size and SHA-256, its header and its
// version, all checked by importEngine on the unpacked bytes. This file only
// fetches and unpacks; it never installs and never runs anything.
//
// ONLY ON A PRESS. Nothing here is called except by engine-install.mjs, and
// that only from the route a person's Install press reaches. Importing this
// does no I/O.
//
// UNPACKED STRICTLY. A package tarball is a gzipped tar of `package/<file>`
// entries. Only plain files directly under `package/` with plain names are
// written, each new (O_EXCL, never through a link) and owner-only; a link,
// a device, a nested path, `..`, a repeated name or an archive past the caps
// refuses the whole package.
import { constants, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_PACKAGE_NAMES } from "./engine-package.mjs";

/** The registry the deck itself is published to. */
export const ENGINE_REGISTRY = "https://registry.npmjs.org/";

/** A package is one executable and its manifest: tens of MB at most. A
 *  download or an unpacked archive past these is not one. */
export const ENGINE_TARBALL_MAX = 160 * 1024 * 1024;
const UNPACKED_MAX = 320 * 1024 * 1024;
const METADATA_MAX = 256 * 1024;
const FILES_MAX = 16;
const METADATA_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** Where the deck's own package.json is: two folders up from this file. */
const DECK_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXACT = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

/** A failure this file names, with the step it happened at. */
export class EngineDownloadError extends Error {
  constructor(code, step) {
    super(code);
    this.code = code;
    this.step = step;
  }
}

/** The package and exact version the deck pins for this machine, or null:
 *  no package for the platform, no pin in package.json, or a pin that is a
 *  range rather than one version. */
export async function enginePin({ platform = process.platform, arch = process.arch, root = DECK_ROOT } = {}) {
  const name = Object.hasOwn(ENGINE_PACKAGE_NAMES, `${platform}-${arch}`) ? ENGINE_PACKAGE_NAMES[`${platform}-${arch}`] : null;
  if (!name) return null;
  try {
    const manifest = JSON.parse(await fs.readFile(join(root, "package.json"), "utf8"));
    const spec = manifest?.optionalDependencies?.[name];
    return typeof spec === "string" && EXACT.test(spec) ? { name, version: spec } : null;
  } catch {
    return null;
  }
}

/** Whether `error` is the network not answering rather than an answer. */
function offline(error) {
  const codes = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);
  const cause = error?.cause ?? {};
  return error?.name === "TimeoutError" || codes.has(error?.code) || codes.has(cause.code) || (error instanceof TypeError && /fetch failed/i.test(error.message));
}

/** One signal that aborts when either does. AbortSignal.any is not in
 *  Node 18, the deck's floor. */
function eitherSignal(timeout, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), timeout);
  timer.unref?.();
  const onAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener("abort", onAbort, { once: true });
  return { signal: controller.signal, done: () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); } };
}

/** A fetch that names its failure: `cancelled` when `signal` was aborted,
 *  `offline` when the network did not answer, `download-failed` otherwise.
 *  The timeout covers the whole body, which the caller reads before `done`. */
async function request(fetchImpl, url, signal, timeout) {
  const either = eitherSignal(timeout, signal);
  try {
    return { res: await fetchImpl(url, { redirect: "error", signal: either.signal }), done: either.done };
  } catch (error) {
    either.done();
    if (signal?.aborted) throw new EngineDownloadError("cancelled", "download");
    throw new EngineDownloadError(offline(error) ? "offline" : "download-failed", "download");
  }
}

/** The body, chunk by chunk, telling `progress` the bytes so far; refused
 *  past `cap`. */
async function readCapped(res, cap, progress, signal) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const whole = Buffer.from(await res.arrayBuffer());
    if (whole.length > cap) throw new EngineDownloadError("too-large", "download");
    progress(whole.length);
    return whole;
  }
  const chunks = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > cap) throw new EngineDownloadError("too-large", "download");
      chunks.push(Buffer.from(value));
      progress(received);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof EngineDownloadError) throw error;
    if (signal?.aborted) throw new EngineDownloadError("cancelled", "download");
    throw new EngineDownloadError(offline(error) ? "offline" : "download-failed", "download");
  }
  return Buffer.concat(chunks, received);
}

/**
 * The pinned package's tarball from the registry, its sha512 integrity
 * checked. Throws EngineDownloadError: `offline`, `not-published` (the
 * registry has no such version), `download-failed`, `too-large`,
 * `cancelled`, or `check-failed` (the bytes are not the ones the registry
 * describes).
 *
 * `onProgress({ received, total })` hears the bytes as they arrive; `total`
 * is null when neither the registry nor the server said.
 */
export async function fetchEngineTarball({
  name, version, registry = ENGINE_REGISTRY, fetchImpl = globalThis.fetch, signal, onProgress = () => {},
} = {}) {
  const base = new URL(registry);
  let dist;
  const meta = await request(fetchImpl, new URL(`${name.replace("/", "%2f")}/${encodeURIComponent(version)}`, base), signal, METADATA_TIMEOUT_MS);
  try {
    if (meta.res.status === 404) throw new EngineDownloadError("not-published", "download");
    if (!meta.res.ok) throw new EngineDownloadError("download-failed", "download");
    const text = (await readCapped(meta.res, METADATA_MAX, () => {}, signal)).toString("utf8");
    const doc = JSON.parse(text);
    if (doc?.name !== name || doc?.version !== version) throw new Error("other package");
    dist = doc.dist;
  } catch (error) {
    if (error instanceof EngineDownloadError) throw error;
    throw new EngineDownloadError("download-failed", "download");
  } finally { meta.done(); }
  const integrity = /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(String(dist?.integrity ?? ""));
  let tarball;
  try { tarball = new URL(String(dist?.tarball ?? "")); } catch { tarball = null; }
  // From the registry itself, over https, carrying no credentials.
  if (!integrity || !tarball || tarball.protocol !== "https:" || tarball.origin !== base.origin || tarball.username || tarball.password) {
    throw new EngineDownloadError("download-failed", "download");
  }
  const { res, done } = await request(fetchImpl, tarball, signal, DOWNLOAD_TIMEOUT_MS);
  let bytes;
  try {
    if (!res.ok) throw new EngineDownloadError(res.status === 404 ? "not-published" : "download-failed", "download");
    const length = Number(res.headers?.get?.("content-length") ?? 0);
    if (length > ENGINE_TARBALL_MAX) throw new EngineDownloadError("too-large", "download");
    const total = length > 0 ? length : null;
    onProgress({ received: 0, total });
    bytes = await readCapped(res, ENGINE_TARBALL_MAX, (received) => onProgress({ received, total }), signal);
  } finally { done(); }
  if (createHash("sha512").update(bytes).digest("base64") !== integrity[1]) throw new EngineDownloadError("check-failed", "verify");
  return bytes;
}

const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** A tar header's octal number, or NaN. */
function octal(block, at, length) {
  const text = block.subarray(at, at + length).toString("latin1").replace(/\0.*$/s, "").trim();
  return /^[0-7]+$/.test(text) ? parseInt(text, 8) : (text === "" ? 0 : NaN);
}

/** A pax header's `path`, when it sets one. */
function paxPath(data) {
  let at = 0;
  let path = null;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const length = Number(data.subarray(at, space).toString("latin1"));
    if (!Number.isSafeInteger(length) || length <= 0 || at + length > data.length) throw new Error("pax");
    const record = data.subarray(space + 1, at + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0 && record.slice(0, eq) === "path") path = record.slice(eq + 1);
    at += length;
  }
  return path;
}

/**
 * The plain files directly under `package/` in a gzipped package tarball, as
 * `[{ name, data }]`. Throws for anything else: a link or a device, a nested
 * or climbing path, a repeated name, an archive past the caps.
 */
export function readPackageTarball(tgz) {
  let tar;
  try {
    tar = gunzipSync(tgz, { maxOutputLength: UNPACKED_MAX });
  } catch {
    throw new EngineDownloadError("check-failed", "verify");
  }
  const files = [];
  const seen = new Set();
  let at = 0;
  let pending = null;
  try {
    while (at + 512 <= tar.length) {
      const block = tar.subarray(at, at + 512);
      if (block.every((b) => b === 0)) break;
      const size = octal(block, 124, 12);
      if (!Number.isSafeInteger(size) || size < 0 || at + 512 + size > tar.length) throw new Error("size");
      const type = String.fromCharCode(block[156] || 0x30);
      const data = tar.subarray(at + 512, at + 512 + size);
      at += 512 + Math.ceil(size / 512) * 512;
      if (type === "x") { pending = paxPath(data); continue; }
      if (type === "g") continue;
      const prefix = block.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
      const short = block.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
      const path = pending ?? (prefix ? `${prefix}/${short}` : short);
      pending = null;
      if (type === "5") continue; // a folder entry: the folder is ours to make
      if (type !== "0") throw new Error("not a plain file");
      const parts = path.split("/");
      if (parts.length !== 2 || parts[0] !== "package" || !PLAIN_NAME.test(parts[1]) || parts[1].includes("..")) throw new Error("path");
      if (seen.has(parts[1])) throw new Error("repeated");
      seen.add(parts[1]);
      files.push({ name: parts[1], data: Buffer.from(data) });
      if (files.length > FILES_MAX) throw new Error("too many");
    }
  } catch {
    throw new EngineDownloadError("check-failed", "verify");
  }
  if (!files.some((f) => f.name === "manifest.json") || !files.some((f) => f.name === "package.json")) {
    throw new EngineDownloadError("check-failed", "verify");
  }
  return files;
}

/**
 * Writes a package's files where importEngine looks for it when asked to
 * start at `staging`: `<staging>/node_modules/<name>/`. The folders are made
 * owner-only, each file new and owner-only, flushed. `staging` must exist.
 */
export async function placePackage(staging, name, files) {
  const folder = join(staging, "node_modules", ...name.split("/"));
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  for (let dir = folder; dir !== staging; dir = dirname(dir)) await fs.chmod(dir, 0o700).catch(() => {});
  for (const { name: file, data } of files) {
    const handle = await fs.open(join(folder, file), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally { await handle.close(); }
  }
  return folder;
}
