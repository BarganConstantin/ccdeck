// Put the Command Panel's engine package for each arch being packed into the
// root node_modules, where scripts/deck-runtime.cjs copies it into the app from.
//
//   node desktop/scripts/engine-packages.cjs <platform> <arch> [<arch>...]
//
// WHY. The macOS build makes the Intel and the Apple silicon app from ONE root
// `npm ci`, on an Apple silicon runner. npm installs the optional dependency
// whose `os` and `cpu` fit that machine and skips the others, so the Intel
// app's engine package is never installed and beforePack would refuse to pack
// it. This adds it. Windows and Linux build one arch on a runner of that arch,
// so their own `npm ci` already brings the one they need.
//
// WHAT IS TRUSTED is package-lock.json, as `npm ci` trusts it: the tarball comes
// from the registry URL it records for the package, and its bytes must match
// the sha512 integrity it records before anything is written into
// node_modules. The version must be the exact one the root package.json pins,
// in the lock and in the unpacked package.json alike. A package already there
// at that version is left as it is.
//
// Nothing to do, and one line saying so, while the root package.json lists no
// engine package.
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, dirname, join, resolve } = require("node:path");
const { enginePackages, exactPin } = require("./deck-runtime.cjs");

const ROOT = resolve(__dirname, "../..");
const REGISTRY = "https://registry.npmjs.org/";
const PLATFORMS = ["darwin", "linux", "win32"];
const ARCHES = ["x64", "arm64"];
// An engine tarball is a single executable and its manifest, tens of MB at
// most; a body past this is not one.
const MAX_BYTES = 256 * 1024 * 1024;
const TIMEOUT_MS = 5 * 60 * 1000;

const readJson = path => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

/** The lock's record of `name`, checked against the pinned `version`. */
function lockEntry(root, name, version) {
  const lock = readJson(join(root, "package-lock.json"));
  if (!lock) throw new Error(`${name}: no readable package-lock.json at ${root}`);
  const entry = lock.packages?.[`node_modules/${name}`];
  if (!entry) throw new Error(`${name}: package-lock.json has no node_modules/${name} entry; run npm install at the repository root to record it`);
  if (entry.version !== version) throw new Error(`${name}: package-lock.json records ${entry.version}, and the root package.json pins ${version}`);
  let url = null;
  try { url = new URL(entry.resolved); } catch { /* refused below */ }
  if (!url || !String(entry.resolved).startsWith(REGISTRY) || url.origin !== new URL(REGISTRY).origin || url.username || url.password) {
    // Named by its scheme and host only: a URL in a lock can carry credentials.
    const where = url ? `${url.protocol}//${url.host}` : JSON.stringify(entry.resolved);
    throw new Error(`${name}: package-lock.json resolves it to ${where}, not a ${REGISTRY} URL`);
  }
  if (typeof entry.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity)) {
    throw new Error(`${name}: package-lock.json gives it no sha512 integrity (${JSON.stringify(entry.integrity)})`);
  }
  return { resolved: entry.resolved, integrity: entry.integrity };
}

/** The tarball's bytes, at most MAX_BYTES of them. */
async function download(url, name, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`${name}: downloading ${url} failed: ${error?.message || error}`);
  }
  if (!response.ok) throw new Error(`${name}: ${url} answered ${response.status}`);
  if (Number(response.headers?.get?.("content-length")) > MAX_BYTES) throw new Error(`${name}: ${url} is larger than ${MAX_BYTES} bytes`);
  const chunks = [];
  let size = 0;
  try {
    if (!response.body) {
      chunks.push(Buffer.from(await response.arrayBuffer()));
      size = chunks[0].length;
    } else {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_BYTES) break;
        chunks.push(Buffer.from(chunk));
      }
    }
  } catch (error) {
    throw new Error(`${name}: reading ${url} failed: ${error?.message || error}`);
  }
  if (size > MAX_BYTES) throw new Error(`${name}: ${url} is larger than ${MAX_BYTES} bytes`);
  return Buffer.concat(chunks);
}

/** Unpack verified tarball `bytes` into `target`, through a staging folder
 *  beside it, so the package appears whole or not at all. */
function unpack(bytes, target, name, version) {
  mkdirSync(dirname(target), { recursive: true });
  // Beside the target, so the last step is a rename on one filesystem.
  const staging = mkdtempSync(join(dirname(target), `.${basename(target)}-`));
  const aside = `${staging}-previous`;
  let work = null;
  try {
    work = mkdtempSync(join(tmpdir(), "ccdeck-engine-"));
    writeFileSync(join(work, "package.tgz"), bytes);
    // The archive by a relative name, from its own folder: GNU tar reads a
    // `C:` in an archive's name as a remote host. npm packs everything under
    // `package/`. argv, never a shell.
    try {
      execFileSync("tar", ["-xzf", "package.tgz", "-C", staging, "--strip-components=1"], { cwd: work, stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      throw new Error(`${name}: unpacking the tarball failed: ${error?.message || error}`);
    }
    const unpacked = readJson(join(staging, "package.json"));
    if (unpacked?.name !== name || unpacked?.version !== version) {
      throw new Error(`${name}: the tarball holds ${unpacked?.name}@${unpacked?.version}, not ${name}@${version}`);
    }
    // A different version already there is set aside first, and put back if
    // the new one cannot take its place.
    const replacing = existsSync(target);
    if (replacing) renameSync(target, aside);
    try {
      renameSync(staging, target);
    } catch (error) {
      if (replacing) renameSync(aside, target);
      throw error;
    }
    if (replacing) rmSync(aside, { recursive: true, force: true });
  } finally {
    if (work) rmSync(work, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Make sure the root node_modules holds the engine package of `platform` for
 *  each of `arches` that the root package.json lists. Resolves to the names
 *  it installed; throws, naming the package, on anything it refuses. `fetch`
 *  and `root` are there for the tests. */
async function ensureEnginePackages(platform, arches, { root = ROOT, fetch: fetchImpl = globalThis.fetch, log = console.log } = {}) {
  if (!PLATFORMS.includes(platform)) throw new Error(`unknown platform ${JSON.stringify(platform)}: expected one of ${PLATFORMS.join(", ")}`);
  if (!arches.length) throw new Error("name at least one arch");
  for (const arch of arches) {
    if (!ARCHES.includes(arch)) throw new Error(`unknown arch ${JSON.stringify(arch)}: expected one of ${ARCHES.join(", ")}`);
  }
  root = resolve(root);
  const listed = enginePackages(root);
  if (!listed.length) {
    log("engine-packages: the root package.json lists no @ccdeck/engine-* package; nothing to install");
    return [];
  }
  const installed = [];
  for (const arch of arches) {
    const name = `@ccdeck/engine-${platform}-${arch}`;
    const engine = listed.find(candidate => candidate.name === name);
    if (!engine) {
      log(`engine-packages: ${name} is not listed in the root package.json; nothing to install`);
      continue;
    }
    const version = exactPin(engine);
    const target = join(root, "node_modules", ...name.split("/"));
    const present = readJson(join(target, "package.json"));
    if (present?.name === name && present?.version === version) {
      log(`engine-packages: ${name}@${version} is already installed`);
      continue;
    }
    const { resolved, integrity } = lockEntry(root, name, version);
    const bytes = await download(resolved, name, fetchImpl);
    if (createHash("sha512").update(bytes).digest("base64") !== integrity.slice("sha512-".length)) {
      throw new Error(`${name}: the tarball from ${resolved} does not match the integrity package-lock.json records`);
    }
    unpack(bytes, target, name, version);
    log(`engine-packages: installed ${name}@${version}`);
    installed.push(name);
  }
  return installed;
}

/** The command line: 0 when every listed package is in place, 1 on a refusal,
 *  2 on a usage error. */
async function main(argv, options = {}) {
  const [platform, ...arches] = argv;
  if (!platform || !arches.length) {
    console.error("usage: node desktop/scripts/engine-packages.cjs <platform> <arch> [<arch>...]");
    return 2;
  }
  try {
    await ensureEnginePackages(platform, arches, options);
    return 0;
  } catch (error) {
    console.error(`engine-packages: ${error?.message || error}`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}

module.exports = { ensureEnginePackages, main };
