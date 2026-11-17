// TEST-ONLY. NOT SHIPPED. The Windows Command Panel preview: a local
// development and test configuration for one Windows VM, never a production
// feature and never permission to publish anything.
//
// WHY IT IS HERE AND NOT IN src/server. package.json `files` publishes bin,
// hook, src/server and dist/web, and the desktop app copies the same four
// (desktop/electron-builder.config.cjs `extraResources`). This folder is in
// neither, so a published package or an installed app does not contain this
// file, and the deck's gate (src/server/command-panel-platform.mjs) refuses
// the preview there whatever it is asked: it turns the preview on only when
// it can load this module. The suite pins both (command-panel-windows-preview.test.ts).
//
// WHAT IT ADDS, AND ONLY ON WINDOWS:
//   - `verifyWindowsPreviewInstallation`: the engine installation check the
//     deck's own (src/server/pro-engine-install.mjs) refuses to make on
//     Windows, where it knows no target and cannot read an owner: the
//     manifest signed with Ed25519 by one of the keys the CALLER gives (the
//     preview's fresh test key, never a key of the deck's), naming exactly
//     the protocol, a Windows target, the sha256, the size, the version and
//     an `ccdeck-pro-engine*.exe` file in that folder, and the file's bytes
//     matching them. Neither file may be a link. NOT checked here, as the
//     deck's own check says it is the native platform gate's (M-13): the
//     folder's and the file's ACL and owner, and whether this account is an
//     administrator. The preview's lab puts the folder in the standard test
//     account's own folder;
//   - `createWindowsPreviewClient`: the deck's own client
//     (src/server/pro-engine-client.mjs) built with that check in place of
//     the deck's. Everything else is the deck's: the hello's target, digest,
//     version and capability checks, the per-run nonce every request
//     carries, the stream relay, the opt-in (CCDECK_ENGINE_TERMINAL=1 only
//     when `terminal` is true);
//   - `windowsPreviewEngine`: that client and engineTerminals(client), what a
//     startServer caller hands the deck as `terminal.engine`.
// Nothing here runs on import, reads the environment or reaches the network.
// Called off Windows, or without a key, it refuses.
import { createHash, createPublicKey, verify } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { ProEngineClient } from "../src/server/pro-engine-client.mjs";
import { ENGINE_PROTOCOL } from "../src/server/pro-engine-install.mjs";
import { engineTerminals } from "../src/server/pro-engine-terminal.mjs";

/** What the deck's gate looks for before it turns the preview on. */
export const WINDOWS_PREVIEW = true;

/** The Windows targets an engine's manifest may name, by Node's platform and arch. */
export const WINDOWS_TARGETS = Object.freeze({ "win32-x64": "x86_64-pc-windows-msvc", "win32-arm64": "aarch64-pc-windows-msvc" });

const MANIFEST_LIMIT = 16 * 1024;
const ENGINE_LIMIT = 128 * 1024 * 1024;
const ENGINE_FILE = /^ccdeck-pro-engine(?:-[a-zA-Z0-9.-]+)?\.exe$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/;
const invalid = () => new Error("The installed terminal engine could not be verified.");
const notHere = () => new Error("The Windows Command Panel preview runs on Windows only.");

/** A regular file of at most `limit` bytes that is not a link, read whole, and
 *  unchanged between the look before and the look after. */
async function readPlain(file, limit) {
  const first = await fs.lstat(file);
  if (!first.isFile() || first.isSymbolicLink() || first.size < 1 || first.size > limit) throw invalid();
  const handle = await fs.open(file, constants.O_RDONLY);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== first.size || before.ino !== first.ino) throw invalid();
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const data = buffer.subarray(0, offset);
    const after = await handle.stat();
    if (data.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw invalid();
    return data;
  } finally { await handle.close(); }
}

/**
 * The installed engine in `directory`, verified as above against `publicKey`
 * (one PEM, or a list any of which may have signed). Answers
 * what the deck's own verifier answers, `{ executable, digest, target,
 * version }`, or throws the same one sentence for anything wrong. `platform`
 * and `arch` are for tests.
 */
export async function verifyWindowsPreviewInstallation({ directory, publicKey }, { platform = process.platform, arch = process.arch } = {}) {
  if (platform !== "win32") throw notHere();
  const keys = Array.isArray(publicKey) ? publicKey : publicKey === undefined || publicKey === null ? [] : [publicKey];
  if (keys.length === 0) throw invalid();
  try {
    const target = WINDOWS_TARGETS[`${platform}-${arch}`];
    if (!target || typeof directory !== "string" || !directory) throw invalid();
    const root = await fs.realpath(directory);
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw invalid();
    const manifestBytes = await readPlain(path.join(root, "manifest.json"), MANIFEST_LIMIT);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    if (!manifest || Object.keys(manifest).sort().join(",") !== "payload,signature" || typeof manifest.payload !== "string" || typeof manifest.signature !== "string") throw invalid();
    const trusted = keys.map(key => createPublicKey(key));
    if (trusted.some(key => key.asymmetricKeyType !== "ed25519")) throw invalid();
    const payload = Buffer.from(manifest.payload, "base64");
    const signature = Buffer.from(manifest.signature, "base64");
    if (payload.toString("base64") !== manifest.payload || signature.toString("base64") !== manifest.signature || !trusted.some(key => verify(null, payload, key, signature))) throw invalid();
    const entry = JSON.parse(payload.toString("utf8"));
    if (!entry || Object.keys(entry).sort().join(",") !== "file,protocol,sha256,size,target,version" || entry.protocol !== ENGINE_PROTOCOL || entry.target !== target
      || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > ENGINE_LIMIT
      || typeof entry.version !== "string" || !VERSION.test(entry.version) || typeof entry.file !== "string" || !ENGINE_FILE.test(entry.file)) throw invalid();
    const executable = path.join(root, entry.file);
    const data = await readPlain(executable, entry.size);
    if (data.length !== entry.size || createHash("sha256").update(data).digest("hex") !== entry.sha256) throw invalid();
    return Object.freeze({ executable, digest: entry.sha256, target, version: entry.version });
  } catch { throw invalid(); }
}

/**
 * The deck's own client for the engine installed in `directory`, trusting
 * `publicKey` only, verified by verifyWindowsPreviewInstallation. Refuses off
 * Windows and without a key, before anything is read or started.
 */
export function createWindowsPreviewClient({ directory, publicKey, hostVersion, terminal = false, enabled = true } = {}, { platform = process.platform, arch = process.arch } = {}) {
  if (platform !== "win32") throw notHere();
  const keys = Array.isArray(publicKey) ? publicKey : publicKey === undefined || publicKey === null ? [] : [publicKey];
  if (keys.length === 0) throw invalid();
  return new ProEngineClient(
    { enabled: enabled === true, directory, publicKey: [...keys], ...(hostVersion === undefined ? {} : { hostVersion }), terminal: terminal === true },
    { verifyInstallation: (options) => verifyWindowsPreviewInstallation(options, { platform, arch }) },
  );
}

/** The client and what startServer takes as `terminal.engine` for it. */
export function windowsPreviewEngine(options, at) {
  const client = createWindowsPreviewClient(options, at);
  return { client, engine: engineTerminals(client) };
}
