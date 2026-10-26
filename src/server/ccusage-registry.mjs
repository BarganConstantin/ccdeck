// ccusage fetched straight from the npm registry, for a machine with no npm.
//
// The managed install in ccusage-install.mjs is `npm install ccusage --prefix`,
// and the fallback after it is `npx -y ccusage@latest`. Both need Node's npm,
// and the desktop app is the one way of running this deck that never needed
// Node at all: it runs the deck on its own Electron binary. Reproduced on a
// clean Windows VM with the 3.46.0 app and no Node: the boot logged
// `'"npm.cmd"' is not recognized`, the npx fallback failed the same way, and the
// Usage panel never had anything from ccusage to show — on the machine of a
// first-time user, which is the one that judges the tool.
//
// What npm would have done here is small enough to do without it. ccusage 20
// has no dependencies. Its package is a cli.js that runs a native binary, and
// that binary ships as one optional dependency per platform
// (`@ccusage/ccusage-<platform>-<arch>`, a few MB, no install scripts). So this
// asks the registry for the two packages, checks each tarball against the
// sha512 the registry publishes for it, which is the check npm itself makes, and
// unpacks them into the same directory npm would have produced, so
// resolveEntry, nativeCcusage and cli.js find everything where they always have.
//
// Nothing is installed anywhere but the deck's own cache directory, and no
// package script is run, because npm would not run one for these two either.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";

const gunzipAsync = promisify(gunzip);

/** The registry this asks, unless the environment names another. npm exports
 *  `npm_config_registry` to everything it runs, and a user who set it by hand
 *  has said where their packages come from. */
export function registryBase(env = process.env) {
  const named = String(env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY ?? "").trim();
  return (named || "https://registry.npmjs.org").replace(/\/+$/, "");
}

/** ccusage's platform package for this machine, named the way its cli.js names
 *  it, or null on a platform ccusage publishes no binary for. */
export function nativePackageName(platform = process.platform, arch = process.arch) {
  if (!["darwin", "linux", "win32"].includes(platform)) return null;
  if (arch !== "x64" && arch !== "arm64") return null;
  return `@ccusage/ccusage-${platform}-${arch}`;
}

/** Bigger than either package by an order of magnitude, and a stop for a
 *  registry or proxy that answers with something that is not a package. */
const MAX_TARBALL_BYTES = 64 << 20;

// A dist-tag or an exact version. Anything else would be put into a URL path.
const SPEC = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

async function getJson(url, { fetch, signal }) {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

/**
 * The registry's record of one version of one package: its version, where its
 * tarball is, the integrity string that tarball has to match, and its optional
 * dependencies. `spec` is a dist-tag ("latest") or an exact version.
 */
export async function packageVersion(name, spec, { fetch = globalThis.fetch, base = registryBase(), signal } = {}) {
  if (!SPEC.test(String(spec))) throw new Error(`not a version or tag: ${spec}`);
  // A scoped name keeps its `@` and has its `/` escaped, which is how the
  // registry spells it in a path.
  const url = `${base}/${name.replace("/", "%2F")}/${spec}`;
  const doc = await getJson(url, { fetch, signal });
  const tarball = doc?.dist?.tarball;
  const integrity = doc?.dist?.integrity;
  if (typeof doc?.version !== "string" || typeof tarball !== "string" || typeof integrity !== "string") {
    throw new Error(`${url} did not describe a package version`);
  }
  if (!/^https?:\/\//.test(tarball)) throw new Error(`${name}@${doc.version} has no usable tarball URL`);
  return { name, version: doc.version, tarball, integrity, optional: doc.optionalDependencies ?? {} };
}

/**
 * Whether `bytes` are what `integrity` says, by the sha512 entries in it.
 *
 * An integrity string is space-separated `<algo>-<base64>` entries. Only sha512
 * is accepted: the registry publishes it for every package this fetches, and a
 * record that offers only something weaker is not one to trust a binary to.
 */
export function integrityMatches(bytes, integrity) {
  const wanted = String(integrity ?? "").split(/\s+/)
    .filter(e => e.startsWith("sha512-"))
    .map(e => e.slice("sha512-".length).split("?")[0]);
  if (!wanted.length) return false;
  const got = createHash("sha512").update(bytes).digest("base64");
  return wanted.includes(got);
}

async function download(pkg, { fetch, signal }) {
  const res = await fetch(pkg.tarball, { signal });
  if (!res.ok) throw new Error(`${pkg.tarball} answered ${res.status}`);
  const declared = Number(res.headers?.get?.("content-length"));
  if (declared > MAX_TARBALL_BYTES) throw new Error(`${pkg.name}@${pkg.version} is ${declared} bytes, more than a ccusage package should be`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_TARBALL_BYTES) throw new Error(`${pkg.name}@${pkg.version} is ${bytes.length} bytes, more than a ccusage package should be`);
  if (!integrityMatches(bytes, pkg.integrity)) {
    throw new Error(`${pkg.name}@${pkg.version} does not match the integrity the registry published for it`);
  }
  return bytes;
}

const text = (buf, start, len) => {
  const raw = buf.subarray(start, start + len);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
};

const octal = (buf, start, len) => {
  if (buf[start] & 0x80) throw new Error("tar entry uses a size encoding no npm package needs");
  const s = text(buf, start, len).trim();
  return s ? parseInt(s, 8) : 0;
};

/** The `path` record out of a pax extended header, or null. */
function paxPath(body) {
  for (const line of body.toString("utf8").split("\n")) {
    const m = /^\d+ path=(.*)$/.exec(line);
    if (m) return m[1];
  }
  return null;
}

/**
 * The entries of an uncompressed tar archive: `{ name, mode, type, body }`.
 *
 * Only what npm tarballs use: ustar headers with their prefix field, pax `path`
 * records and GNU long names. Everything is read out of one buffer that has
 * already passed the integrity check, so a truncated archive is the one
 * malformation worth naming.
 *
 * Exported for tests.
 */
export function* tarEntries(buf) {
  let off = 0;
  let longName = null;
  while (off + 512 <= buf.length) {
    const head = buf.subarray(off, off + 512);
    if (head.every(b => b === 0)) return;
    const size = octal(head, 124, 12);
    const type = head[156] ? String.fromCharCode(head[156]) : "0";
    const prefix = text(head, 257, 6).startsWith("ustar") ? text(head, 345, 155) : "";
    const start = off + 512;
    if (start + size > buf.length) throw new Error("the package archive is truncated");
    const body = buf.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
    if (type === "x" || type === "L") { longName = type === "x" ? paxPath(body) : text(body, 0, body.length); continue; }
    if (type === "g") continue;
    const short = text(head, 0, 100);
    const name = longName ?? (prefix ? `${prefix}/${short}` : short);
    longName = null;
    yield { name, mode: octal(head, 100, 8), type, body };
  }
}

/**
 * Unpack an npm tarball into `dest`, without its top directory (`package/` in
 * every tarball npm publishes).
 *
 * Regular files and directories only. npm drops links out of a package too,
 * and a link is the one entry that could make a later write land outside
 * `dest`. Every name is also checked to stay inside `dest`: a `..`, a drive
 * letter or a colon, which on Windows names a stream of another file, fails the
 * whole unpack rather than skipping one entry, because a package that contains
 * one of those is not one to run.
 *
 * Exported for tests.
 */
export async function unpack(tgz, dest) {
  const tar = await gunzipAsync(tgz);
  const root = path.resolve(dest);
  await mkdir(root, { recursive: true });
  for (const entry of tarEntries(tar)) {
    if (entry.type !== "0" && entry.type !== "5") continue;
    const parts = entry.name.replace(/\\/g, "/").split("/").filter(p => p && p !== ".");
    parts.shift();
    if (!parts.length) continue;
    if (parts.some(p => p === ".." || p.includes(":"))) {
      throw new Error(`the package archive names a path outside itself: ${entry.name}`);
    }
    const target = path.resolve(root, ...parts);
    if (!target.startsWith(root + path.sep)) {
      throw new Error(`the package archive names a path outside itself: ${entry.name}`);
    }
    if (entry.type === "5") { await mkdir(target, { recursive: true }); continue; }
    await mkdir(path.dirname(target), { recursive: true });
    // An executable bit is kept, as npm keeps it. ccusage's cli.js would set it
    // on the native binary anyway before running it, but a copy that looks
    // like npm's is one nothing downstream has to know about. Windows has no
    // such bit and ignores the mode.
    await writeFile(target, entry.body, { mode: entry.mode & 0o111 ? 0o755 : 0o644 });
  }
}

/**
 * Put ccusage `spec` and this platform's native package into `pkgDir`, the
 * directory npm would have made `node_modules/ccusage`.
 *
 * The native package goes INSIDE it, under `pkgDir/node_modules/@ccusage/…`,
 * where Node's resolution from cli.js finds it first. That keeps the whole
 * install one directory, so it is swapped in with one rename: a run that starts
 * while this works sees the old copy or the new one, never half of each.
 *
 * Built in a sibling directory and renamed into place. If the old copy cannot
 * be moved aside — on Windows, a ccusage.exe still running out of it — the new
 * one is thrown away and the old one stays, which is the same outcome as an npm
 * update that failed, and the next check tries again.
 *
 * Resolves to the version installed. `fetch` and `platform`/`arch` are
 * injectable for tests.
 */
export async function fetchCcusage({
  spec = "latest",
  pkgDir,
  fetch = globalThis.fetch,
  base = registryBase(),
  platform = process.platform,
  arch = process.arch,
  timeoutMs = 120_000,
} = {}) {
  if (typeof fetch !== "function") throw new Error("this Node has no fetch");
  const nativeName = nativePackageName(platform, arch);
  if (!nativeName) throw new Error(`ccusage publishes no build for ${platform}-${arch}`);
  const signal = AbortSignal.timeout(timeoutMs);
  const opts = { fetch, base, signal };

  const main = await packageVersion("ccusage", spec, opts);
  const nativeSpec = main.optional[nativeName];
  if (typeof nativeSpec !== "string" || !SPEC.test(nativeSpec)) {
    throw new Error(`ccusage@${main.version} names no exact ${nativeName} version`);
  }
  const native = await packageVersion(nativeName, nativeSpec, opts);
  const [mainTgz, nativeTgz] = await Promise.all([download(main, opts), download(native, opts)]);

  const stamp = `${process.pid}-${Date.now()}`;
  const staging = `${pkgDir}.fetching-${stamp}`;
  const old = `${pkgDir}.old-${stamp}`;
  try {
    await unpack(mainTgz, staging);
    await unpack(nativeTgz, path.join(staging, "node_modules", ...nativeName.split("/")));
    await mkdir(path.dirname(pkgDir), { recursive: true });
    const hadOld = existsSync(pkgDir);
    if (hadOld) await renameSoon(pkgDir, old);
    try {
      await renameSoon(staging, pkgDir);
    } catch (err) {
      if (hadOld) await renameSoon(old, pkgDir).catch(() => {});
      throw err;
    }
    // Only once the new copy is in place: until then `old` is the copy to put back.
    if (hadOld) await rm(old, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }).catch(() => {});
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
  return main.version;
}

/**
 * `rename`, given a moment when Windows says the file is busy.
 *
 * A freshly written ccusage.exe is opened by the antivirus scanner before
 * anything else gets to it, and while it is open its directory cannot be
 * renamed. That is a hold of a moment, not a refusal, and npm's own file system
 * layer retries the same three codes for the same reason.
 */
async function renameSoon(from, to, tries = 8) {
  for (let i = 1; ; i++) {
    try {
      return await rename(from, to);
    } catch (err) {
      if (i >= tries || !["EPERM", "EACCES", "EBUSY"].includes(err?.code)) throw err;
      await new Promise(r => setTimeout(r, 50 * i));
    }
  }
}

/** The version the registry calls `latest`, for the daily update check on a
 *  machine with no `npm view` to ask. */
export async function latestCcusage({ fetch = globalThis.fetch, base = registryBase(), timeoutMs = 30_000 } = {}) {
  const { version } = await packageVersion("ccusage", "latest", { fetch, base, signal: AbortSignal.timeout(timeoutMs) });
  return version;
}
