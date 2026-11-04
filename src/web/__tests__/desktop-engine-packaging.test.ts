// The desktop app carrying the Command Panel's engine, the way `npm i -g ccdeck`
// already does: each platform's engine is its own npm package, listed in the
// root package.json's optionalDependencies, and the deck finds it by walking up
// from its own folder through each node_modules (engine-package.mjs). In the app
// the deck runs from Resources/deck, so the package has to land in
// Resources/deck/node_modules — copied there by the config's platform sections
// (deck-runtime.cjs), checked by beforePack, fetched for the second Mac arch by
// engine-packages.cjs, and left byte for byte as published by the Mac signing
// (sign-mac.cjs).
//
// The packages are not published yet, so the root package.json lists none and
// all of this has to be DORMANT: nothing added to the app, nothing checked,
// nothing fetched. Every case below runs against a repository root made here in
// a temporary folder, once listing no engine package and once listing them, so
// both halves are proved today. Nothing touches the network or runs rcodesign:
// the fetch is a stand-in serving a tarball made here with `tar -czf`, and the
// signing is a stand-in that writes down its argv.
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error plain server module
import { ENGINE_PACKAGE_NAMES, findEnginePackage } from "../../server/engine-package.mjs";

const require = createRequire(import.meta.url);
const runtime = require("../../../desktop/scripts/deck-runtime.cjs");
const engines = require("../../../desktop/scripts/engine-packages.cjs");
const signMac = require("../../../desktop/scripts/sign-mac.cjs");
const config = require("../../../desktop/electron-builder.config.cjs");

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const desktop = join(repo, "desktop");
const ENGINE_NAMES: string[] = Object.values(ENGINE_PACKAGE_NAMES);
// electron-builder's Arch enum, as beforePack receives it.
const X64 = 1, ARM64 = 3, UNIVERSAL = 4;
// The config's platform sections and the platform names they pack for.
const SECTIONS = [["mac", "darwin"], ["win", "win32"], ["linux", "linux"]] as const;

const temps: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "ccdeck-engine-packaging-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) rmTempDir(dir);
});

const writeJson = (path: string, data: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
};
const sha512 = (bytes: Buffer) => createHash("sha512").update(bytes).digest("base64");
const packageDir = (root: string, name: string) => join(root, "node_modules", ...name.split("/"));
const quiet = () => {};

/** A repository root as the desktop scripts read it: the deck's one native
 *  dependency with a prebuild for every packed target, an optional dependency
 *  that is no engine (fsevents, as many manifests have), and `engines` as the
 *  rest of optionalDependencies. */
function repoRoot(engineDeps: Record<string, string> = {}) {
  const root = temp();
  writeJson(join(root, "package.json"), {
    name: "ccdeck", version: "9.9.9",
    dependencies: { "fs-native-extensions": "1.5.2" },
    optionalDependencies: { fsevents: "2.3.3", ...engineDeps },
  });
  const native = join(root, "node_modules", "fs-native-extensions");
  writeJson(join(native, "package.json"), { name: "fs-native-extensions", version: "1.5.2" });
  for (const target of ["darwin-x64", "darwin-arm64", "linux-x64", "win32-x64"]) {
    mkdirSync(join(native, "prebuilds", target), { recursive: true });
    writeFileSync(join(native, "prebuilds", target, "fs-native-extensions.node"), "fixture");
  }
  return root;
}

/** Every engine package the deck knows, pinned at `version`. */
const allEngines = (version = "1.2.3") => Object.fromEntries(ENGINE_NAMES.map(name => [name, version]));

/** The files of an engine package: an executable stand-in, its manifest and
 *  its package.json. Never run. */
const engineFiles = (name: string, version: string): Record<string, string> => ({
  "package.json": JSON.stringify({ name, version }),
  "manifest.json": JSON.stringify({ version, note: "fixture" }),
  "engine": `stand-in executable for ${name}@${version}`,
  "LICENSE": "fixture licence",
});

/** An engine package installed in `root` the way npm leaves one. */
function installEngine(root: string, name: string, version: string, { manifest = true } = {}) {
  const dir = packageDir(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(engineFiles(name, version))) {
    if (file === "manifest.json" && !manifest) continue;
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

/** package-lock.json with an npm registry entry for each [name, version, bytes]. */
function writeLock(root: string, entries: [string, string, Buffer][], override: Record<string, unknown> = {}) {
  const packages: Record<string, unknown> = { "": { name: "ccdeck", version: "9.9.9" } };
  for (const [name, version, bytes] of entries) {
    packages[`node_modules/${name}`] = {
      version,
      resolved: `https://registry.npmjs.org/${name}/-/${name.split("/")[1]}-${version}.tgz`,
      integrity: `sha512-${sha512(bytes)}`,
      optional: true,
      ...override,
    };
  }
  writeJson(join(root, "package-lock.json"), { name: "ccdeck", version: "9.9.9", lockfileVersion: 3, requires: true, packages });
}

/** A fetch that serves `bytes` for any URL and writes down what it was asked. */
const serving = (bytes: Buffer) => vi.fn(async (_url: string) => new Response(bytes));

describe("the engine packages the desktop app knows", () => {
  it("are the root package.json's @ccdeck/engine-* optional dependencies, each the platform and arch the deck looks it up by", () => {
    const listed = runtime.enginePackages(repoRoot(allEngines()));
    expect(listed.map((engine: { name: string }) => engine.name).sort()).toEqual([...ENGINE_NAMES].sort());
    for (const [target, name] of Object.entries(ENGINE_PACKAGE_NAMES)) {
      const engine = listed.find((candidate: { name: string }) => candidate.name === name);
      expect(`${engine.platform}-${engine.arch}`).toBe(target);
      expect(engine.spec).toBe("1.2.3");
    }
  });

  it("accepts from the repository's own package.json only names the deck looks for", () => {
    // None today. The day the packages are listed, a name the deck never looks
    // up would be an engine packed into the app and never found.
    for (const { name } of runtime.enginePackages()) expect(ENGINE_NAMES).toContain(name);
  });

  it("refuses an @ccdeck/engine-* name it cannot place, rather than packing nothing for it", () => {
    const root = repoRoot({ "@ccdeck/engine-macos-arm64": "1.2.3" });
    expect(() => runtime.enginePackages(root)).toThrow(/@ccdeck\/engine-macos-arm64 .* not a package the desktop app can place/);
  });
});

describe("while the root package.json lists no engine package", () => {
  it("adds nothing to any platform section", () => {
    const root = repoRoot();
    for (const [, platform] of SECTIONS) expect(runtime.engineResources(platform, root)).toEqual({});
  });

  it("packs every target as before, checking for no engine", () => {
    const root = repoRoot();
    for (const [platform, arch] of [["darwin", X64], ["darwin", ARM64], ["darwin", UNIVERSAL], ["linux", X64], ["win32", X64]] as const) {
      expect(() => runtime.validateRuntime({ electronPlatformName: platform, arch }, root)).not.toThrow();
    }
  });

  it("fetches nothing, writes nothing, says so in one line and exits 0", async () => {
    const root = repoRoot();
    const before = readdirSync(join(root, "node_modules")).sort();
    const fetch = vi.fn();
    const log = vi.fn();
    expect(await engines.ensureEnginePackages("darwin", ["x64", "arm64"], { root, fetch, log })).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/lists no @ccdeck\/engine-\* package/);
    expect(readdirSync(join(root, "node_modules")).sort()).toEqual(before);
    expect(existsSync(join(root, "package-lock.json"))).toBe(false);
    vi.spyOn(console, "log").mockImplementation(quiet);
    expect(await engines.main(["darwin", "x64", "arm64"], { root, fetch })).toBe(0);
  });

  it("is what the config itself says, platform by platform", () => {
    // The config is read with the repository's own package.json, so this holds
    // today (nothing) and the day the packages are listed (the entries).
    for (const [section, platform] of SECTIONS) {
      expect(config[section].extraResources).toEqual(runtime.engineResources(platform).extraResources);
    }
    // And never at the top level, which every platform packs.
    expect(config.extraResources.filter((entry: { to: string }) => entry.to.includes("@ccdeck/engine-"))).toEqual([]);
  });
});

describe("once the root package.json lists the engine packages", () => {
  it("copies the package for the arch being packed into Resources/deck/node_modules, where the deck finds it", async () => {
    const root = repoRoot(allEngines());
    for (const [, platform] of SECTIONS) {
      const { extraResources } = runtime.engineResources(platform, root);
      expect(extraResources).toEqual([{
        from: `../node_modules/@ccdeck/engine-${platform}-\${arch}`,
        to: `deck/node_modules/@ccdeck/engine-${platform}-\${arch}`,
      }]);
      for (const arch of ["x64", "arm64"]) {
        // electron-builder's own expansion of the macro, for the arch it packs.
        const name = `@ccdeck/engine-${platform}-${arch}`;
        if (!ENGINE_NAMES.includes(name)) continue;
        const [entry] = extraResources.map((e: { from: string; to: string }) => ({ from: e.from.replace("${arch}", arch), to: e.to.replace("${arch}", arch) }));
        // `from` is read relative to desktop/, the config's own folder.
        expect(resolve(desktop, entry.from)).toBe(packageDir(repo, name));
        // Laid out as Resources is, the deck — running from deck/src/server —
        // finds it by its own lookup.
        const resources = temp();
        const placed = join(resources, entry.to);
        installEngine(dirname(dirname(dirname(placed))), name, "1.2.3");
        mkdirSync(join(resources, "deck", "src", "server"), { recursive: true });
        // The native realpath, as the lookup's own: a Windows runner's temp
        // folder is an 8.3 short name the JS one leaves as it is.
        expect(await findEnginePackage(name, join(resources, "deck", "src", "server"))).toBe(realpathSync.native(placed));
      }
    }
  });

  it("adds the entry only to the platforms the root package.json names", () => {
    const root = repoRoot({ "@ccdeck/engine-darwin-arm64": "1.2.3" });
    expect(runtime.engineResources("darwin", root).extraResources).toHaveLength(1);
    expect(runtime.engineResources("win32", root)).toEqual({});
    expect(runtime.engineResources("linux", root)).toEqual({});
  });
});

describe("beforePack, once the engine packages are listed", () => {
  const macs = { "@ccdeck/engine-darwin-x64": "1.2.3", "@ccdeck/engine-darwin-arm64": "1.2.3" };

  it("refuses an arch whose engine package is not installed, naming the package and the target", () => {
    const root = repoRoot(macs);
    installEngine(root, "@ccdeck/engine-darwin-arm64", "1.2.3");
    expect(() => runtime.validateRuntime({ electronPlatformName: "darwin", arch: X64 }, root))
      .toThrow(/Missing engine package @ccdeck\/engine-darwin-x64 for darwin-x64/);
    // A universal build needs both.
    expect(() => runtime.validateRuntime({ electronPlatformName: "darwin", arch: UNIVERSAL }, root))
      .toThrow(/Missing engine package @ccdeck\/engine-darwin-x64 for darwin-x64/);
  });

  it("refuses an engine package at another version than the one pinned", () => {
    const root = repoRoot(macs);
    installEngine(root, "@ccdeck/engine-darwin-arm64", "1.2.2");
    expect(() => runtime.validateRuntime({ electronPlatformName: "darwin", arch: ARM64 }, root))
      .toThrow(/@ccdeck\/engine-darwin-arm64 for darwin-arm64 is 1\.2\.2, and the root package.json pins 1\.2\.3/);
  });

  it("refuses a folder that holds another package", () => {
    const root = repoRoot(macs);
    writeJson(join(packageDir(root, "@ccdeck/engine-darwin-arm64"), "package.json"), { name: "something-else", version: "1.2.3" });
    expect(() => runtime.validateRuntime({ electronPlatformName: "darwin", arch: ARM64 }, root))
      .toThrow(/holds something-else, not @ccdeck\/engine-darwin-arm64/);
  });

  it("refuses an engine package without its manifest.json", () => {
    const root = repoRoot(macs);
    installEngine(root, "@ccdeck/engine-darwin-arm64", "1.2.3", { manifest: false });
    expect(() => runtime.validateRuntime({ electronPlatformName: "darwin", arch: ARM64 }, root))
      .toThrow(/@ccdeck\/engine-darwin-arm64 for darwin-arm64 has no manifest\.json/);
  });

  it("refuses a range where the root package.json has to pin one exact version", () => {
    for (const range of ["^1.2.3", "~1.2.3", ">=1.2.3", "1.x", "1.2", "*", "latest", ""]) {
      const root = repoRoot({ "@ccdeck/engine-darwin-arm64": range });
      installEngine(root, "@ccdeck/engine-darwin-arm64", "1.2.3");
      expect(() => runtime.validateRuntime({ electronPlatformName: "darwin", arch: ARM64 }, root), range)
        .toThrow(/must pin @ccdeck\/engine-darwin-arm64 to an exact version/);
    }
  });

  it("packs a universal Mac with both arches' packages, and one arch with its own", () => {
    const both = repoRoot(macs);
    installEngine(both, "@ccdeck/engine-darwin-x64", "1.2.3");
    installEngine(both, "@ccdeck/engine-darwin-arm64", "1.2.3");
    expect(() => runtime.validateRuntime({ electronPlatformName: "darwin", arch: UNIVERSAL }, both)).not.toThrow();
    const one = repoRoot(macs);
    installEngine(one, "@ccdeck/engine-darwin-arm64", "1.2.3");
    expect(() => runtime.validateRuntime({ electronPlatformName: "darwin", arch: ARM64 }, one)).not.toThrow();
    expect(() => runtime.validateRuntime({ electronPlatformName: "darwin", arch: "arm64" }, one)).not.toThrow();
  });

  it("checks nothing for a target the root package.json does not list", () => {
    const root = repoRoot(macs);
    expect(() => runtime.validateRuntime({ electronPlatformName: "linux", arch: X64 }, root)).not.toThrow();
    expect(() => runtime.validateRuntime({ electronPlatformName: "win32", arch: X64 }, root)).not.toThrow();
  });
});

describe("engine-packages.cjs, refusing before anything is unpacked", () => {
  const X64_PACKAGE = "@ccdeck/engine-darwin-x64";
  const listed = () => repoRoot({ [X64_PACKAGE]: "1.2.3", "@ccdeck/engine-darwin-arm64": "1.2.3" });

  it("leaves a package already installed at the pinned version untouched, without reading the lock", async () => {
    const root = listed();
    const dir = installEngine(root, X64_PACKAGE, "1.2.3");
    const engine = join(dir, "engine");
    const before = { text: readFileSync(engine, "utf8"), mtime: statSync(engine).mtimeMs };
    const fetch = vi.fn();
    expect(await engines.ensureEnginePackages("darwin", ["x64"], { root, fetch, log: quiet })).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect({ text: readFileSync(engine, "utf8"), mtime: statSync(engine).mtimeMs }).toEqual(before);
  });

  it("refuses a tarball whose bytes are not the ones the lock's integrity names, and writes nothing into node_modules", async () => {
    const root = listed();
    writeLock(root, [[X64_PACKAGE, "1.2.3", Buffer.from("the tarball the lock recorded")]]);
    const fetch = serving(Buffer.from("some other bytes"));
    await expect(engines.ensureEnginePackages("darwin", ["x64"], { root, fetch, log: quiet }))
      .rejects.toThrow(/@ccdeck\/engine-darwin-x64: the tarball from https:\/\/registry\.npmjs\.org\/\S+ does not match the integrity/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(existsSync(packageDir(root, X64_PACKAGE))).toBe(false);
    expect(existsSync(join(root, "node_modules", "@ccdeck"))).toBe(false);
  });

  it("refuses a lock that records another version than the pin, before downloading", async () => {
    const root = listed();
    writeLock(root, [[X64_PACKAGE, "1.2.2", Buffer.from("x")]]);
    const fetch = vi.fn();
    await expect(engines.ensureEnginePackages("darwin", ["x64"], { root, fetch, log: quiet }))
      .rejects.toThrow(/@ccdeck\/engine-darwin-x64: package-lock.json records 1\.2\.2, and the root package.json pins 1\.2\.3/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a tarball from anywhere but the npm registry, before downloading", async () => {
    for (const resolved of [
      "https://registry.npmjs.org.example.com/@ccdeck/engine-darwin-x64/-/engine-darwin-x64-1.2.3.tgz",
      "http://registry.npmjs.org/@ccdeck/engine-darwin-x64/-/engine-darwin-x64-1.2.3.tgz",
      "https://user:secret@registry.npmjs.org/@ccdeck/engine-darwin-x64/-/engine-darwin-x64-1.2.3.tgz",
      "https://example.com/engine-darwin-x64-1.2.3.tgz",
      "file:../engine-darwin-x64-1.2.3.tgz",
      undefined,
    ]) {
      const root = listed();
      writeLock(root, [[X64_PACKAGE, "1.2.3", Buffer.from("x")]], { resolved });
      const fetch = vi.fn();
      await expect(engines.ensureEnginePackages("darwin", ["x64"], { root, fetch, log: quiet }), String(resolved))
        .rejects.toThrow(/@ccdeck\/engine-darwin-x64: package-lock.json resolves it to .*, not a https:\/\/registry\.npmjs\.org\/ URL/);
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("refuses a lock with no entry for the package, or no sha512 integrity for it", async () => {
    const missing = listed();
    writeLock(missing, []);
    await expect(engines.ensureEnginePackages("darwin", ["x64"], { root: missing, fetch: vi.fn(), log: quiet }))
      .rejects.toThrow(/@ccdeck\/engine-darwin-x64: package-lock.json has no node_modules\/@ccdeck\/engine-darwin-x64 entry/);
    for (const integrity of ["sha1-3q2+7w==", "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=", "", undefined]) {
      const root = listed();
      writeLock(root, [[X64_PACKAGE, "1.2.3", Buffer.from("x")]], { integrity });
      const fetch = vi.fn();
      await expect(engines.ensureEnginePackages("darwin", ["x64"], { root, fetch, log: quiet }), String(integrity))
        .rejects.toThrow(/@ccdeck\/engine-darwin-x64: package-lock.json gives it no sha512 integrity/);
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("refuses a range where the root package.json has to pin one exact version", async () => {
    const root = repoRoot({ [X64_PACKAGE]: "^1.2.3" });
    await expect(engines.ensureEnginePackages("darwin", ["x64"], { root, fetch: vi.fn(), log: quiet }))
      .rejects.toThrow(/must pin @ccdeck\/engine-darwin-x64 to an exact version/);
  });

  it("says nothing is to be done for an arch the root package.json does not list", async () => {
    const root = repoRoot({ "@ccdeck/engine-darwin-arm64": "1.2.3" });
    installEngine(root, "@ccdeck/engine-darwin-arm64", "1.2.3");
    const fetch = vi.fn();
    expect(await engines.ensureEnginePackages("darwin", ["x64", "arm64"], { root, fetch, log: quiet })).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(packageDir(root, X64_PACKAGE))).toBe(false);
  });

  it("answers 0, 1 and 2 on the command line, naming the package it refuses", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(quiet);
    vi.spyOn(console, "log").mockImplementation(quiet);
    const root = listed();
    writeLock(root, []);
    expect(await engines.main(["darwin", "x64", "arm64"], { root, fetch: vi.fn() })).toBe(1);
    expect(errors.mock.calls.flat().join("\n")).toContain("@ccdeck/engine-darwin-x64");
    expect(await engines.main(["darwin"], { root, fetch: vi.fn() })).toBe(2);
    expect(await engines.main(["macos", "x64"], { root, fetch: vi.fn() })).toBe(1);
    expect(await engines.main(["darwin", "universal"], { root, fetch: vi.fn() })).toBe(1);
    expect(await engines.main(["darwin", "x64"], { root: repoRoot(), fetch: vi.fn() })).toBe(0);
  });

  it("runs as a script from its place in the repository, with that repository's root", () => {
    // The file itself, as the workflow runs it, copied with its one neighbour
    // into a fixture repository: its root is two folders up from it.
    const run = (root: string) => {
      const scripts = join(root, "desktop", "scripts");
      mkdirSync(scripts, { recursive: true });
      for (const file of ["engine-packages.cjs", "deck-runtime.cjs"]) cpSync(join(desktop, "scripts", file), join(scripts, file));
      return spawnSync(process.execPath, [join(scripts, "engine-packages.cjs"), "darwin", "x64", "arm64"], { encoding: "utf8" });
    };
    const dormant = run(repoRoot());
    expect(dormant.status).toBe(0);
    expect(dormant.stdout.trim().split("\n")).toHaveLength(1);
    const unrecorded = repoRoot({ [X64_PACKAGE]: "1.2.3" });
    writeLock(unrecorded, []);
    const refused = run(unrecorded);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("@ccdeck/engine-darwin-x64");
  });
});

// The system tar, which the script unpacks with: GNU tar on Ubuntu, bsdtar on
// macOS and on Windows 10 and later. Registered in skip-gates.mjs as a probe
// that holds on no runner.
const hasTar = spawnSync("tar", ["--version"], { stdio: "ignore" }).status === 0;

/** An npm-shaped tarball of `files`, everything under `package/`. */
function tarball(files: Record<string, string>): Buffer {
  const dir = temp();
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, "package", file)), { recursive: true });
    writeFileSync(join(dir, "package", file), text);
  }
  // Relative names from its own folder: GNU tar reads `C:` in an archive's
  // name as a remote host.
  // COPYFILE_DISABLE keeps macOS's tar from adding ._ entries for extended
  // attributes, which no npm tarball has.
  execFileSync("tar", ["-czf", "package.tgz", "package"], { cwd: dir, env: { ...process.env, COPYFILE_DISABLE: "1" } });
  return readFileSync(join(dir, "package.tgz"));
}

describe.skipIf(!hasTar)("engine-packages.cjs, fetching the other Mac's package", () => {
  const X64_PACKAGE = "@ccdeck/engine-darwin-x64";
  const listed = () => repoRoot({ [X64_PACKAGE]: "1.2.3", "@ccdeck/engine-darwin-arm64": "1.2.3" });

  it("fetches a missing package from the lock's registry URL, checks it, and unpacks it whole where beforePack looks", async () => {
    const root = listed();
    installEngine(root, "@ccdeck/engine-darwin-arm64", "1.2.3");
    const files = engineFiles(X64_PACKAGE, "1.2.3");
    const bytes = tarball(files);
    writeLock(root, [[X64_PACKAGE, "1.2.3", bytes]]);
    const fetch = serving(bytes);
    expect(await engines.ensureEnginePackages("darwin", ["x64", "arm64"], { root, fetch, log: quiet })).toEqual([X64_PACKAGE]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("https://registry.npmjs.org/@ccdeck/engine-darwin-x64/-/engine-darwin-x64-1.2.3.tgz");
    for (const [file, text] of Object.entries(files)) {
      expect(readFileSync(join(packageDir(root, X64_PACKAGE), file), "utf8"), file).toBe(text);
    }
    // No staging folder left beside it.
    expect(readdirSync(join(root, "node_modules", "@ccdeck")).sort()).toEqual(["engine-darwin-arm64", "engine-darwin-x64"]);
    // And the build packs both Macs from it.
    expect(() => runtime.validateRuntime({ electronPlatformName: "darwin", arch: UNIVERSAL }, root)).not.toThrow();
    // A second run finds it in place.
    expect(await engines.ensureEnginePackages("darwin", ["x64", "arm64"], { root, fetch, log: quiet })).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("replaces a package installed at another version, whole", async () => {
    const root = listed();
    const stale = installEngine(root, X64_PACKAGE, "1.2.2");
    writeFileSync(join(stale, "only-in-1.2.2"), "x");
    const bytes = tarball(engineFiles(X64_PACKAGE, "1.2.3"));
    writeLock(root, [[X64_PACKAGE, "1.2.3", bytes]]);
    expect(await engines.ensureEnginePackages("darwin", ["x64"], { root, fetch: serving(bytes), log: quiet })).toEqual([X64_PACKAGE]);
    expect(JSON.parse(readFileSync(join(packageDir(root, X64_PACKAGE), "package.json"), "utf8")).version).toBe("1.2.3");
    expect(existsSync(join(packageDir(root, X64_PACKAGE), "only-in-1.2.2"))).toBe(false);
    expect(readdirSync(join(root, "node_modules", "@ccdeck"))).toEqual(["engine-darwin-x64"]);
  });

  it("refuses a tarball that holds another version than the pin, and leaves nothing behind", async () => {
    // The lock's integrity matches these bytes; what is inside them does not
    // match the version the lock and the root package.json name.
    const root = listed();
    const bytes = tarball(engineFiles(X64_PACKAGE, "1.2.4"));
    writeLock(root, [[X64_PACKAGE, "1.2.3", bytes]]);
    await expect(engines.ensureEnginePackages("darwin", ["x64"], { root, fetch: serving(bytes), log: quiet }))
      .rejects.toThrow(/@ccdeck\/engine-darwin-x64: the tarball holds @ccdeck\/engine-darwin-x64@1\.2\.4, not @ccdeck\/engine-darwin-x64@1\.2\.3/);
    expect(existsSync(packageDir(root, X64_PACKAGE))).toBe(false);
    expect(readdirSync(join(root, "node_modules", "@ccdeck"))).toEqual([]);
  });
});

// A throwaway self-signed certificate whose key was discarded, the same one
// desktop-release-pipeline.test.ts uses: requirementFor reads its hash, and
// nothing can be signed with it.
const FIXTURE_CERT = `-----BEGIN CERTIFICATE-----
MIIBbzCCASGgAwIBAgIUHAsBTnmAgk+S2CAgyohfL+EFFTMwBQYDK2VwMCwxKjAo
BgNVBAMMIWNjZGVjayB0ZXN0IGZpeHR1cmUgKG5vIGtleSBrZXB0KTAgFw0yNjA5
MjExNzU0MzZaGA8yMTI2MDgyODE3NTQzNlowLDEqMCgGA1UEAwwhY2NkZWNrIHRl
c3QgZml4dHVyZSAobm8ga2V5IGtlcHQpMCowBQYDK2VwAyEAF7TSBcoJwZq9g/xF
DcUxdzR4UO/ClYivMbzHHmu8JPqjUzBRMB0GA1UdDgQWBBR2Vf68XKNOldRmbnsA
2U6ijy552DAfBgNVHSMEGDAWgBR2Vf68XKNOldRmbnsA2U6ijy552DAPBgNVHRMB
Af8EBTADAQH/MAUGAytlcANBAGsJ0/aI6LbKmUYY/gYk51bnuKd18hRPCeSjyGQ3
tpm1OzbGHDJEpH/kKy0W9kDv99WTuxiCqvc92YopWLZm9wM=
-----END CERTIFICATE-----
`;

describe("the Mac signing, around the engine", () => {
  const ENGINE = "@ccdeck/engine-darwin-arm64";
  /** An app bundle carrying the engine package copied from `root`. */
  const appWithEngine = (root: string, appOutDir = temp()) => {
    const app = join(appOutDir, "ccdeck.app");
    cpSync(packageDir(root, ENGINE), join(app, "Contents", "Resources", "deck", "node_modules", ...ENGINE.split("/")), { recursive: true });
    return app;
  };
  /** A glob as rcodesign matches it: `**` any depth, `*` within one name. */
  const globRe = (glob: string) => new RegExp(`^${glob.split("**").map(part => part.split("*").map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*")}$`);

  it("tells rcodesign to leave the engine package alone, by the path the config copies it to", () => {
    expect(signMac.ENGINE_EXCLUDE).toBe("Contents/Resources/deck/node_modules/@ccdeck/engine-*/**");
    expect(signMac.rcodesignArgs({ certPath: "cert.pem", keyPath: "key.pem", requirements: "designated.csreq", app: "/out/ccdeck.app" })).toEqual([
      "sign",
      "--pem-file", "cert.pem",
      "--pem-file", "key.pem",
      "--code-requirements-file", "designated.csreq",
      "--exclude", "Contents/Resources/deck/node_modules/@ccdeck/engine-*/**",
      "/out/ccdeck.app",
    ]);
    // Every file of the package as the Mac section places it, for both arches.
    const [entry] = runtime.engineResources("darwin", repoRoot(allEngines())).extraResources;
    for (const arch of ["x64", "arm64"]) {
      for (const file of Object.keys(engineFiles("x", "1"))) {
        expect(`Contents/Resources/${entry.to.replace("${arch}", arch)}/${file}`).toMatch(globRe(signMac.ENGINE_EXCLUDE));
      }
    }
    // And nothing of the deck's own.
    expect("Contents/Resources/deck/node_modules/fs-native-extensions/package.json").not.toMatch(globRe(signMac.ENGINE_EXCLUDE));
  });

  it("accepts an app whose engine is byte for byte the installed package, and refuses one changed byte, a missing file and an added one", () => {
    const root = repoRoot({ [ENGINE]: "1.2.3" });
    installEngine(root, ENGINE, "1.2.3");
    mkdirSync(join(packageDir(root, ENGINE), "licenses"), { recursive: true });
    writeFileSync(join(packageDir(root, ENGINE), "licenses", "NOTICE"), "nested");
    const engineIn = (app: string, file: string) => join(app, "Contents", "Resources", "deck", "node_modules", ...ENGINE.split("/"), file);

    expect(signMac.verifyEngineCopies(appWithEngine(root), root)).toEqual(["engine-darwin-arm64"]);

    const changed = appWithEngine(root);
    const bytes = readFileSync(engineIn(changed, "engine"));
    bytes[0] ^= 1;
    writeFileSync(engineIn(changed, "engine"), bytes);
    expect(() => signMac.verifyEngineCopies(changed, root)).toThrow(/signing changed @ccdeck\/engine-darwin-arm64\/engine/);

    const missing = appWithEngine(root);
    rmTempDir(engineIn(missing, "licenses/NOTICE"));
    expect(() => signMac.verifyEngineCopies(missing, root)).toThrow(/@ccdeck\/engine-darwin-arm64\/licenses\/NOTICE is missing from the signed app/);

    const added = appWithEngine(root);
    writeFileSync(engineIn(added, "_CodeSignature"), "x");
    expect(() => signMac.verifyEngineCopies(added, root)).toThrow(/@ccdeck\/engine-darwin-arm64\/_CodeSignature is not in/);
  });

  it("has nothing to compare in an app without an engine", () => {
    const app = join(temp(), "ccdeck.app");
    mkdirSync(join(app, "Contents", "Resources", "deck", "node_modules", "fs-native-extensions"), { recursive: true });
    expect(signMac.verifyEngineCopies(app, repoRoot())).toEqual([]);
    expect(signMac.verifyEngineCopies(join(temp(), "ccdeck.app"), repoRoot())).toEqual([]);
  });

  describe("signing with a certificate", () => {
    const KEYS = ["CCDECK_SIGNING_CERT", "CCDECK_SIGNING_KEY", "RCODESIGN"] as const;
    const saved: Record<string, string | undefined> = {};
    afterEach(() => {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });
    const begin = () => {
      for (const k of KEYS) saved[k] = process.env[k];
      const keys = temp();
      writeFileSync(join(keys, "cert.pem"), FIXTURE_CERT);
      writeFileSync(join(keys, "key.pem"), "not a key: nothing reads it here");
      process.env.CCDECK_SIGNING_CERT = join(keys, "cert.pem");
      process.env.CCDECK_SIGNING_KEY = join(keys, "key.pem");
      process.env.RCODESIGN = "rcodesign-stand-in";
      const root = repoRoot({ [ENGINE]: "1.2.3" });
      installEngine(root, ENGINE, "1.2.3");
      const appOutDir = temp();
      const app = appWithEngine(root, appOutDir);
      const context = { electronPlatformName: "darwin", appOutDir, packager: { appInfo: { productFilename: "ccdeck", id: "dev.ccdeck.app" } } };
      return { root, app, context };
    };

    it("asks rcodesign to sign with the exclude, then finds the engine unchanged", async () => {
      const { root, app, context } = begin();
      const calls: [string, string[]][] = [];
      await signMac(context, { root, run: (file: string, args: string[]) => { calls.push([file, args]); } });
      expect(calls.map(([file]) => file)).toEqual(["csreq", "rcodesign-stand-in"]);
      const [, args] = calls[1];
      expect(args).toEqual(signMac.rcodesignArgs({
        certPath: process.env.CCDECK_SIGNING_CERT, keyPath: process.env.CCDECK_SIGNING_KEY, requirements: args[6], app,
      }));
      expect(args).toContain("--exclude");
    });

    it("fails the build when signing changed the engine anyway", async () => {
      // What a re-signed Mach-O looks like from here: the same file, other bytes.
      const { root, app, context } = begin();
      const run = (file: string) => {
        if (file === "rcodesign-stand-in") appendFileSync(join(app, "Contents", "Resources", "deck", "node_modules", ...ENGINE.split("/"), "engine"), "signature");
      };
      await expect(signMac(context, { root, run })).rejects.toThrow(/signing changed @ccdeck\/engine-darwin-arm64\/engine; the deck would refuse that engine/);
    });
  });
});

describe("the desktop build in publish.yml", () => {
  const publishYml = () => readFileSync(join(repo, ".github", "workflows", "publish.yml"), "utf8");
  /** The desktop job, from its key to the next job's. */
  const desktopJob = () => {
    const yml = publishYml();
    const at = yml.indexOf("\n  desktop:\n");
    expect(at, "publish.yml no longer has a `desktop:` job").toBeGreaterThan(-1);
    const rest = yml.slice(at + 1);
    const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
    return next === -1 ? rest : rest.slice(0, next + 1);
  };
  /** Its steps, sliced on the `- name:` lines. */
  const steps = () => {
    const text = desktopJob();
    const marker = "\n      - name: ";
    const found: { name: string; body: string }[] = [];
    for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + 1)) {
      const next = text.indexOf(marker, at + 1);
      const body = next === -1 ? text.slice(at) : text.slice(at, next);
      found.push({ name: body.slice(marker.length, body.indexOf("\n", marker.length)).trim(), body });
    }
    return found;
  };

  it("fetches the engine package of each Mac arch it packs, right after the root npm ci and before packaging", () => {
    const all = steps();
    const names = all.map(s => s.name);
    const engine = all.find(s => s.body.includes("node desktop/scripts/engine-packages.cjs"));
    expect(engine, "no desktop step runs engine-packages.cjs").toBeDefined();
    expect(engine!.body).toMatch(/\n {8}if: runner\.os == 'macOS'\n/);
    expect(engine!.body).not.toContain("working-directory");
    // The arches it fetches are the ones the macOS leg packs.
    const macBuild = desktopJob().match(/- os: macos-latest\n\s+build: (.*)\n/);
    expect(macBuild, "the matrix no longer has a macos-latest leg with a build line").not.toBeNull();
    const packed = [...macBuild![1].matchAll(/--(x64|arm64)\b/g)].map(m => m[1]).sort();
    const fetched = engine!.body.match(/node desktop\/scripts\/engine-packages\.cjs darwin ((?:\w+ ?)+)\n/);
    expect(fetched).not.toBeNull();
    expect(fetched![1].trim().split(" ").sort()).toEqual(packed);
    expect(packed).toEqual(["arm64", "x64"]);
    // After the install at the root, the one beforePack and the config read.
    const install = all.find(s => s.name === "Install dependencies");
    expect(install!.body).toMatch(/\n {8}run: npm ci\n/);
    expect(install!.body).not.toContain("working-directory");
    expect(names.indexOf(engine!.name)).toBe(names.indexOf("Install dependencies") + 1);
    expect(names.indexOf(engine!.name)).toBeLessThan(names.indexOf("Package"));
    expect(existsSync(join(desktop, "scripts", "engine-packages.cjs"))).toBe(true);
  });
});
