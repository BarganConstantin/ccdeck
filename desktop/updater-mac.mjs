// macOS self-update, without Squirrel and without an Apple Developer ID (#1160).
//
// electron-updater's macOS path hands the install to Squirrel.Mac, which only
// accepts an update that satisfies the running app's designated requirement —
// and an ad-hoc app's requirement is its own code hash, so no update can ever
// pass. ccdeck is signed with its own certificate (scripts/sign-mac.cjs), which
// would satisfy Squirrel in principle, but only one report from 2021 says it
// works in practice. So the install is ours, and every check Squirrel would
// have made is made here instead, in the order that fails safest:
//
//   1. the manifest names a version newer than this one, for this CPU
//   2. the zip's SHA-256 and size match the manifest
//   3. the zip carries two Ed25519 signatures by ccdeck's update key, whose
//      public half is compiled into this file: one over its bytes, and one
//      over its bytes, name and the version the manifest offers it as — a
//      download from anywhere else, altered on the way, or not released as
//      that version, stops here
//   4. the unpacked app satisfies the RUNNING app's designated requirement:
//      same app id, same signing certificate. A dev build (ad-hoc, requirement
//      = its own hash) can therefore never be updated over, which is correct
//   5. the unpacked app is the version the manifest offered it as, read from
//      its own Info.plist, which the code signature verified in check 4 seals
//   6. only then is the bundle swapped — by a detached script that waits for
//      this process to exit, so nothing replaces files under a running app
//
// The manifest and the zip are plain files on a GitHub Release, fetched from
// `releases/latest/download/…`, which GitHub redirects to the newest release.
import { createHash, createPublicKey, verify } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** ccdeck's update key, public half. The private half signs releases in CI
 *  (scripts/sign-update.mjs) and is never in this repo. */
export const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAKBFU7DGqrSDbiQVt8oYZZZ/WQkdRnDFPVIiAlWIAEn4=
-----END PUBLIC KEY-----
`;

/** `3.25.4` > `3.25.3`, and a release outranks its own prerelease
 *  (`3.25.4` > `3.25.4-beta`). Anything unparseable is never newer. */
export function isNewer(candidate, current) {
  const parse = v => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(v));
    return m ? { nums: [+m[1], +m[2], +m[3]], pre: m[4] ?? null } : null;
  };
  const a = parse(candidate), b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i];
  if (a.pre === b.pre) return false;
  if (a.pre === null) return true;
  if (b.pre === null) return false;
  return a.pre.localeCompare(b.pre, "en", { numeric: true }) > 0;
}

/** The manifest's entry for this CPU, or null. */
export function pickFile(manifest, arch = process.arch) {
  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  return files.find(f => f && f.arch === arch && typeof f.url === "string") ?? null;
}

/** Checks 2 and 3: the bytes are the ones the manifest describes, and ccdeck's
 *  update key signed them. */
export function verifyZip(bytes, file, publicKeyPem = UPDATE_PUBLIC_KEY) {
  if (!Buffer.isBuffer(bytes) || !file) return false;
  if (Number.isFinite(file.size) && bytes.length !== file.size) return false;
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== file.sha256) return false;
  try {
    return verify(null, bytes, createPublicKey(publicKeyPem), Buffer.from(String(file.signature), "base64"));
  } catch {
    return false;
  }
}

/**
 * What a release signature covers: the version a file is published as, its
 * name and its SHA-256, in one message.
 *
 * The first signature (`signature` in latest-mac.json, `ed25519` in the ymls)
 * covers the file's bytes, while the version the app compares sits beside it
 * as plain text. This second one, `ed25519Release`, signs the three together,
 * so a file installs only as the version it was released as.
 *
 * CI writes both. Apps released before `ed25519Release` existed verify only
 * the first and must go on updating, which is why it stays; apps released
 * after it require both.
 */
export function releaseMessage(version, name, bytes) {
  const sha = createHash("sha256").update(bytes).digest("hex");
  return Buffer.from(`ccdeck-update\0${version}\0${name}\0${sha}`, "utf8");
}

/** Is `signatureB64` ccdeck's release signature for these bytes, published as
 *  `version` under `name`? */
export function verifyRelease(bytes, { version, name, signature }, publicKeyPem = UPDATE_PUBLIC_KEY) {
  if (!Buffer.isBuffer(bytes) || !version || !name || !signature) return false;
  try {
    return verify(null, releaseMessage(version, name, bytes), createPublicKey(publicKeyPem), Buffer.from(String(signature), "base64"));
  } catch {
    return false;
  }
}

/** The .app bundle this process runs from: …/ccdeck.app/Contents/MacOS/ccdeck. */
export function bundleOf(exePath) {
  return dirname(dirname(dirname(exePath)));
}

/**
 * Can this account put a new version where the app at `path` is: move the old
 * one aside or delete it, and write the new one beside it? That takes write
 * access to the folder it is in, and to the app itself for the old one to go.
 * A copy run from its disk image, or one macOS translocated because it was
 * opened from Downloads without being moved, is on a read-only mount; a
 * standard account cannot write to /Applications. An update staged for any
 * of them quits the app into a swap that cannot happen.
 */
export async function canReplace(path) {
  try {
    await access(dirname(path), constants.W_OK);
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The release the swap script last failed to put in place, as it wrote it
 *  to `markerPath`, or null. */
export async function failedSwap(markerPath) {
  try {
    return (await readFile(markerPath, "utf8")).trim() || null;
  } catch {
    return null;
  }
}

/** The running app's designated requirement, as codesign prints it. */
async function designatedRequirement(appPath, execFileImpl = run) {
  const { stderr, stdout } = await execFileImpl("codesign", ["-d", "-r-", appPath]);
  const line = `${stdout}\n${stderr}`.split("\n").find(l => l.startsWith("designated => "));
  if (!line) throw new Error("the running app has no designated requirement");
  return line.slice("designated => ".length);
}

/** The version an unpacked app says it is: the CFBundleShortVersionString
 *  electron-builder writes, which is the version it packaged. */
async function bundleVersion(appPath, execFileImpl = run) {
  const plist = join(appPath, "Contents", "Info.plist");
  const { stdout } = await execFileImpl("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", plist]);
  return String(stdout).trim();
}

/** Look for an update. Returns what to install, or null when there is none. */
export async function checkForUpdate({ manifestUrl, currentVersion, arch = process.arch, fetchImpl = fetch }) {
  const res = await fetchImpl(manifestUrl, { redirect: "follow", cache: "no-store" });
  if (!res.ok) throw new Error(`manifest ${res.status}`);
  const manifest = await res.json();
  if (!isNewer(manifest?.version, currentVersion)) return null;
  const file = pickFile(manifest, arch);
  if (!file) return null;
  return { version: manifest.version, file, url: new URL(file.url, manifestUrl).href };
}

/**
 * Download, verify, unpack and check the identity. Returns the staged app.
 *
 * `execFileImpl` and `publicKeyPem` are there for the tests, which have no
 * ccdeck-signed bundle and no update key to hand.
 */
export async function stageUpdate(update, { runningApp, fetchImpl = fetch, execFileImpl = run, publicKeyPem = UPDATE_PUBLIC_KEY }) {
  const res = await fetchImpl(update.url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!verifyZip(bytes, update.file, publicKeyPem)) throw new Error("the download failed its hash or signature check");
  if (!verifyRelease(bytes, { version: update.version, name: basename(String(update.file.url)), signature: update.file.ed25519Release }, publicKeyPem)) {
    throw new Error(`the download is not signed as ccdeck ${update.version}`);
  }

  const dir = await mkdtemp(join(tmpdir(), "ccdeck-update-"));
  try {
    const zip = join(dir, "update.zip");
    await writeFile(zip, bytes);
    // ditto, not unzip: it keeps the bundle's symlinks and extended attributes,
    // which the code signature covers.
    await execFileImpl("ditto", ["-x", "-k", zip, join(dir, "app")]);
    const entry = (await readdir(join(dir, "app"))).find(n => n.endsWith(".app"));
    if (!entry) throw new Error("the update holds no .app");
    const staged = join(dir, "app", entry);

    // Check 4: same identity as the app that is running.
    const requirement = await designatedRequirement(runningApp, execFileImpl);
    await execFileImpl("codesign", ["--verify", "--deep", "--strict", `-R=${requirement}`, staged]);

    // Check 5: the version that will run is the one that was offered, so an
    // update only ever moves forward, by as far as it said it would.
    const version = await bundleVersion(staged, execFileImpl);
    if (version !== update.version) throw new Error(`the update is ccdeck ${version || "of no version"}, not the ${update.version} it was offered as`);
    return { staged, dir };
  } catch (err) {
    // A refused update is thrown away here, because nothing else knows where it
    // is: the caller only ever hears of a dir that staged. Left behind, every
    // refused check — a dev build is refused at check 4 every six hours —
    // leaves the zip and the unpacked app in the temp directory (#1176).
    await discard(dir).catch(() => {});
    throw err;
  }
}

/**
 * Swap the bundle once this process has gone, then — for a restart — start
 * the new one.
 *
 * A detached /bin/sh, handed everything as argv — never interpolated — so a
 * path with a space or a quote is data. The old bundle is moved aside rather
 * than deleted until the new one is in place, and put back if the move fails.
 * `relaunch` is "1" when the app is restarting into the update; a plain Quit
 * is the person closing ccdeck, and leaves it closed (#1758).
 *
 * A swap that fails still opens the app for a restart — the version that was
 * running — and still throws the download away. It writes the release it
 * could not put in place to `failed`, which the next check reads, so the same
 * release is not staged and tried again every couple of minutes; a swap that
 * succeeds clears it.
 */
export const SWAP_SCRIPT = `
pid="$1"; target="$2"; staged="$3"; work="$4"; relaunch="$5"; failed="$6"; version="$7"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
backup="$target.ccdeck-old"
swapped=0
rm -rf "$backup"
if mv "$target" "$backup"; then
  if ditto "$staged" "$target"; then
    rm -rf "$backup"; swapped=1
  else
    rm -rf "$target"; mv "$backup" "$target"
  fi
  xattr -dr com.apple.quarantine "$target" 2>/dev/null
fi
rm -rf "$work"
if [ -n "$failed" ]; then
  if [ "$swapped" = 1 ]; then rm -f "$failed"; else printf '%s\\n' "$version" > "$failed"; fi
fi
if [ "$relaunch" = 1 ]; then open "$target"; fi
[ "$swapped" = 1 ]
`;

export function installOnExit({ pid, target, staged, dir, relaunch = false, failed = "", version = "" }) {
  const child = spawn("/bin/sh", ["-c", SWAP_SCRIPT, "ccdeck-swap", String(pid), target, staged, dir, relaunch ? "1" : "0", failed, version], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

/** Throw away a staged update that will not be installed. */
export async function discard(dir) {
  await rm(dir, { recursive: true, force: true });
}
