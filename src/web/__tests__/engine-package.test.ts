// The step that brings the Command Panel's engine from the npm package that
// carries it into the deck's own engine folder (engine-package.mjs), and the
// installer rules it leans on (pro-engine-install.mjs).
//
// The package is a folder made here under a temporary directory, with an
// executable that is only a header for this machine (it is never run) and a
// manifest signed by a throwaway Ed25519 key handed in as the deck's key: the
// deck's own release key signs none of them. Windows is exercised on Linux and
// macOS by handing the installer a mocked ACL reader and a Windows-shaped
// package, so the rules are covered, not Windows itself (NOT TESTED there).
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { promises as fileSystem } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
// @ts-expect-error plain server module
import * as pkg from "../../server/engine-package.mjs";
// @ts-expect-error plain server module
import * as install from "../../server/pro-engine-install.mjs";
// @ts-expect-error plain server module
import { commandPanelEngine, commandPanelSupported } from "../../server/command-panel-engine.mjs";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

type Arch = "x64" | "arm64";
const pem = (key: KeyObject) => key.export({ type: "spki", format: "pem" }) as string;

/** An executable's first bytes, for `platform` and `arch`, followed by `seed` so two differ. */
function header(platform: string, arch: string, seed = "a"): Buffer {
  const tail = Buffer.from(`${seed}`.repeat(64));
  if (platform === "linux") {
    const h = Buffer.alloc(64);
    h.writeUInt32BE(0x7f454c46, 0); h[4] = 2; h[5] = 1; h.writeUInt16LE(arch === "arm64" ? 183 : 62, 18);
    return Buffer.concat([h, tail]);
  }
  if (platform === "darwin") {
    const h = Buffer.alloc(32);
    h.writeUInt32LE(0xfeedfacf, 0); h.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4);
    return Buffer.concat([h, tail]);
  }
  const h = Buffer.alloc(0x100);
  h.writeUInt16BE(0x4d5a, 0); h.writeUInt32LE(0x80, 0x3c); h.writeUInt32BE(0x50450000, 0x80); h.writeUInt16LE(arch === "arm64" ? 0xaa64 : 0x8664, 0x84);
  return Buffer.concat([h, tail]);
}
const other = (arch: string): Arch => (arch === "arm64" ? "x64" : "arm64");

interface World {
  base: string; from: string; home: string; dest: string; source: string; engineFile: string;
  signer: { privateKey: KeyObject; publicKey: KeyObject }; keys: string[]; platform: string; arch: string;
  env: Record<string, string>;
}

/** A deck folder, a data folder and the engine's package for `platform`/`arch`. */
async function world(platform = process.platform, arch: string = process.arch): Promise<World> {
  const base = await mkdtemp(join(tmpdir(), "ccdeck-engine-package-")); roots.push(base); await chmod(base, 0o700);
  const from = join(base, "deck", "src", "server");
  const home = join(base, "home");
  await mkdir(from, { recursive: true }); await mkdir(home, { mode: 0o700 });
  const source = join(base, "deck", "node_modules", "@ccdeck", `engine-${platform}-${arch}`);
  await mkdir(source, { recursive: true });
  for (const dir of [join(base, "deck"), join(base, "deck", "src"), from, join(base, "deck", "node_modules"), join(base, "deck", "node_modules", "@ccdeck"), source]) await chmod(dir, 0o755);
  const signer = generateKeyPairSync("ed25519");
  const w: World = {
    base, from, home, dest: join(home, "engine"), source, signer, keys: [pem(signer.publicKey)], platform, arch,
    engineFile: platform === "win32" ? "ccdeck-pro-engine.exe" : "ccdeck-pro-engine",
    env: { CCDECK_HOME: home },
  };
  await publish(w);
  return w;
}

/** Writes (or rewrites) the package's two files. */
async function publish(w: World, { version = "1.0.0", seed = "a", bytes, signer = w.signer, platform = w.platform, arch = w.arch }: { version?: string; seed?: string; bytes?: Buffer; signer?: { privateKey: KeyObject }; platform?: string; arch?: string } = {}) {
  const exe = bytes ?? header(platform, arch, seed);
  const target = ({ linux: "unknown-linux-gnu", darwin: "apple-darwin", win32: "pc-windows-msvc" } as Record<string, string>)[w.platform];
  const entry = { file: w.engineFile, protocol: 1, target: `${w.arch === "arm64" ? "aarch64" : "x86_64"}-${target}`, sha256: createHash("sha256").update(exe).digest("hex"), size: exe.length, version };
  const payload = Buffer.from(JSON.stringify(entry));
  await rm(join(w.source, w.engineFile), { force: true });
  await writeFile(join(w.source, w.engineFile), exe, { mode: 0o755 });
  await writeFile(join(w.source, "manifest.json"), JSON.stringify({ payload: payload.toString("base64"), signature: sign(null, payload, signer.privateKey).toString("base64") }), { mode: 0o644 });
  await writeFile(join(w.source, "package.json"), JSON.stringify({ name: `@ccdeck/engine-${w.platform}-${w.arch}`, version }), { mode: 0o644 });
  return entry;
}

const run = (w: World, extra: Record<string, unknown> = {}) => pkg.importEngine({ platform: w.platform, arch: w.arch, env: w.env, keys: w.keys, from: w.from, ...extra });
const verified = (w: World) => install.verifyEngineInstallation({ directory: w.dest, publicKey: w.keys });
const inodeOf = async (path: string) => (await lstat(path)).ino;

describe("the engine's package names and header check", () => {
  it("keeps every package name in one constant, one per platform and arch", () => {
    expect(Object.keys(pkg.ENGINE_PACKAGE_NAMES).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]);
    expect(Object.isFrozen(pkg.ENGINE_PACKAGE_NAMES)).toBe(true);
    expect(pkg.enginePackageName("linux", "x64")).toBe("@ccdeck/engine-linux-x64");
    expect(pkg.enginePackageName("freebsd", "x64")).toBeNull();
    expect(pkg.enginePackageName("linux", "riscv64")).toBeNull();
  });

  it("accepts a header only for its own OS and arch, ELF, Mach-O and PE alike", () => {
    for (const platform of ["linux", "darwin", "win32"]) {
      for (const arch of ["x64", "arm64"]) {
        expect(install.executableMatchesMachine(header(platform, arch), platform, arch), `${platform} ${arch}`).toBe(true);
        expect(install.executableMatchesMachine(header(platform, arch), platform, other(arch)), `${platform} ${arch} as ${other(arch)}`).toBe(false);
      }
    }
    expect(install.executableMatchesMachine(header("linux", "x64"), "darwin", "x64")).toBe(false);
    expect(install.executableMatchesMachine(header("darwin", "x64"), "win32", "x64")).toBe(false);
    expect(install.executableMatchesMachine(Buffer.from("#!/bin/sh\necho hi\n"), "linux", "x64")).toBe(false);
    expect(install.executableMatchesMachine(Buffer.alloc(0), "linux", "x64")).toBe(false);
    // A universal (fat) Mach-O and a 32-bit ELF are not the thin 64-bit image this expects.
    const fat = header("darwin", "x64"); fat.writeUInt32BE(0xcafebabe, 0);
    expect(install.executableMatchesMachine(fat, "darwin", "x64")).toBe(false);
    const thirtyTwo = header("linux", "x64"); thirtyTwo[4] = 1;
    expect(install.executableMatchesMachine(thirtyTwo, "linux", "x64")).toBe(false);
    expect(install.executableMatchesMachine(header("linux", "x64"), "freebsd", "x64")).toBe(false);
  });

  it("orders versions as SemVer does, and refuses a text that is none", () => {
    const order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.10.0", "2.0.0"];
    for (let i = 0; i < order.length; i++) for (let j = 0; j < order.length; j++) expect(install.compareVersions(order[i], order[j]), `${order[i]} ${order[j]}`).toBe(Math.sign(i - j));
    expect(install.compareVersions("1.0.0+build.7", "1.0.0")).toBe(0);
    for (const bad of ["latest", "", "1.0", "v1.0.0", undefined]) expect(() => install.compareVersions("1.0.0", bad)).toThrow();
  });

  // CHANGED ON PURPOSE (V4 ships the panel on Windows through the engine): this
  // pinned "unsupported on Windows while ENGINE_ON_WINDOWS is false"; the engine
  // now ships there and the panel is offered like on Linux and macOS.
  it("is supported on Windows, as the one constant says", () => {
    expect(pkg.ENGINE_ON_WINDOWS).toBe(true);
    expect(commandPanelSupported("win32")).toBe(true);
    expect(commandPanelSupported("linux")).toBe(true);
  });
});

describe.skipIf(!['darwin', 'linux'].includes(process.platform))("bringing the engine in from its package", () => {
  it("finds the platform's package from the deck's own folder, and nowhere else", async () => {
    const w = await world();
    expect(await pkg.findEnginePackage(pkg.enginePackageName(w.platform, w.arch), w.from)).toBe(await (await import("node:fs/promises")).realpath(w.source));
    // Not by the working directory, PATH or NODE_PATH.
    const elsewhere = await mkdtemp(join(tmpdir(), "ccdeck-engine-elsewhere-")); roots.push(elsewhere);
    await mkdir(join(elsewhere, "node_modules", "@ccdeck"), { recursive: true });
    const name = pkg.enginePackageName(w.platform, w.arch);
    expect(await pkg.findEnginePackage(name, elsewhere)).toBeNull();
    vi.stubEnv("NODE_PATH", join(w.base, "deck", "node_modules")); vi.stubEnv("PATH", join(w.base, "deck", "node_modules"));
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(join(w.base, "deck"));
    expect(await pkg.findEnginePackage(name, elsewhere)).toBeNull();
    cwd.mockRestore(); vi.unstubAllEnvs();
  });

  it("answers absent, and creates nothing, when there is no package", async () => {
    const w = await world(); await rm(join(w.base, "deck", "node_modules"), { recursive: true });
    expect(await run(w)).toEqual({ status: "absent" });
    expect(await readdir(w.home)).toEqual([]);
  });

  it("answers absent for a platform with no package, and for no keys, without reading anything", async () => {
    const w = await world();
    expect(await run(w, { platform: "freebsd" })).toEqual({ status: "absent" });
    expect(await run(w, { keys: [] })).toEqual({ status: "absent" });
    expect(await readdir(w.home)).toEqual([]);
  });

  it("imports a signed engine whole, owner-only, and the installer then accepts it", async () => {
    const w = await world();
    const entry = await publish(w, { version: "1.2.3" });
    const result = await run(w);
    expect(result).toEqual({ status: "imported", minimumVersion: "1.2.3" });
    expect(await verified(w)).toMatchObject({ digest: entry.sha256, version: "1.2.3" });
    expect((await lstat(w.dest)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(w.dest, w.engineFile))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(w.dest, "manifest.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(w.dest, w.engineFile))).toEqual(header(w.platform, w.arch));
    expect((await readFile(join(w.home, pkg.MINIMUM_VERSION_FILE), "utf8")).trim()).toBe("1.2.3");
    // Nothing but the engine folder and the floor is left behind.
    expect((await readdir(w.home)).sort()).toEqual(["engine", pkg.MINIMUM_VERSION_FILE]);
  });

  it("does not copy a source that is already what is installed, and installs a newer one", async () => {
    const w = await world();
    await run(w);
    const before = await inodeOf(w.dest);
    expect(await run(w)).toEqual({ status: "current", minimumVersion: "1.0.0" });
    expect(await inodeOf(w.dest)).toBe(before);
    await publish(w, { version: "1.1.0", seed: "b" });
    expect(await run(w)).toEqual({ status: "imported", minimumVersion: "1.1.0" });
    expect(await inodeOf(w.dest)).not.toBe(before);
    expect(await verified(w)).toMatchObject({ version: "1.1.0" });
    expect((await readdir(w.home)).sort()).toEqual(["engine", pkg.MINIMUM_VERSION_FILE]);
  });

  it("repairs an installation that no longer verifies from the same package", async () => {
    const w = await world();
    await run(w);
    await writeFile(join(w.dest, w.engineFile), Buffer.from("changed"), { mode: 0o700 });
    expect(await run(w)).toMatchObject({ status: "imported" });
    expect(await verified(w)).toMatchObject({ version: "1.0.0" });
  });

  it("refuses a binary whose header is for another arch or another OS, and installs nothing", async () => {
    const w = await world();
    for (const bytes of [header(w.platform, other(w.arch)), header(w.platform === "linux" ? "darwin" : "linux", w.arch), Buffer.from("#!/bin/sh\nexit 0\n")]) {
      await publish(w, { bytes });
      expect(await run(w)).toEqual({ status: "refused", reason: "wrong-machine" });
      expect(await readdir(w.home)).toEqual([]);
    }
  });

  it("refuses a version below the installed one, and below the floor the deck kept", async () => {
    const w = await world();
    await publish(w, { version: "1.1.0" }); await run(w);
    const kept = await readFile(join(w.dest, w.engineFile));
    await publish(w, { version: "1.0.0", seed: "z" });
    expect(await run(w)).toEqual({ status: "refused", reason: "downgrade", minimumVersion: "1.1.0" });
    expect(await readFile(join(w.dest, w.engineFile))).toEqual(kept);
    expect(await verified(w)).toMatchObject({ version: "1.1.0" });
    // The folder removed, the floor stays: an older engine is still refused.
    await rm(w.dest, { recursive: true });
    expect(await run(w)).toMatchObject({ status: "refused", reason: "downgrade" });
    await expect(lstat(w.dest)).rejects.toMatchObject({ code: "ENOENT" });
    // A pre-release below the same release is lower too.
    await publish(w, { version: "1.1.0-rc.1" });
    expect(await run(w)).toMatchObject({ status: "refused", reason: "downgrade" });
  });

  it("holds an installed engine to the floor when the installer starts it", async () => {
    const w = await world();
    await publish(w, { version: "1.0.0" }); await run(w);
    await expect(install.verifyEngineInstallation({ directory: w.dest, publicKey: w.keys, minimumVersion: "1.0.0" })).resolves.toMatchObject({ version: "1.0.0" });
    await expect(install.verifyEngineInstallation({ directory: w.dest, publicKey: w.keys, minimumVersion: "1.0.1" })).rejects.toThrow("could not be verified");
    await expect(install.verifyEngineInstallation({ directory: w.dest, publicKey: w.keys, minimumVersion: "newest" })).rejects.toThrow("could not be verified");
    // A floor file that is not a version refuses every import and every start.
    await writeFile(join(w.home, pkg.MINIMUM_VERSION_FILE), "newest\n", { mode: 0o600 });
    expect(await run(w)).toEqual({ status: "refused", reason: "unverified" });
  });

  it("refuses a manifest signed by another key, one with a changed signature and one whose bytes changed", async () => {
    const w = await world();
    await publish(w, { signer: generateKeyPairSync("ed25519") });
    expect(await run(w)).toEqual({ status: "refused", reason: "unverified" });
    await publish(w);
    const manifest = JSON.parse(await readFile(join(w.source, "manifest.json"), "utf8"));
    const signature = Buffer.from(manifest.signature, "base64"); signature[0] ^= 1;
    await writeFile(join(w.source, "manifest.json"), JSON.stringify({ ...manifest, signature: signature.toString("base64") }));
    expect(await run(w)).toEqual({ status: "refused", reason: "unverified" });
    await publish(w);
    await writeFile(join(w.source, w.engineFile), Buffer.concat([header(w.platform, w.arch), Buffer.from("x")]), { mode: 0o755 });
    expect(await run(w)).toEqual({ status: "refused", reason: "unverified" });
    expect(await readdir(w.home)).toEqual([]);
  });

  it("refuses a link in the source, whether it is the executable, the manifest or the package.json", async () => {
    const w = await world();
    for (const file of [w.engineFile, "manifest.json"]) {
      await publish(w);
      const real = join(w.base, `real-${file}`);
      await writeFile(real, await readFile(join(w.source, file)), { mode: 0o644 });
      await rm(join(w.source, file)); await symlink(real, join(w.source, file));
      expect(await run(w), file).toEqual({ status: "refused", reason: "unverified" });
      expect(await readdir(w.home), file).toEqual([]);
    }
    await publish(w);
    const real = join(w.base, "real-package.json");
    await writeFile(real, await readFile(join(w.source, "package.json")));
    await rm(join(w.source, "package.json")); await symlink(real, join(w.source, "package.json"));
    expect(await run(w)).toEqual({ status: "absent" });
  });

  it("refuses a source that is not owned by this user or root, or that others can write", async () => {
    const w = await world();
    const me = process.getuid!();
    expect(await run(w, { uid: me + 1 })).toEqual({ status: "refused", reason: "unverified" });
    expect(await readdir(w.home)).toEqual([]);
    await chmod(join(w.source, w.engineFile), 0o757);
    expect(await run(w)).toEqual({ status: "refused", reason: "unverified" });
    await chmod(join(w.source, w.engineFile), 0o755); await chmod(w.source, 0o777);
    expect(await run(w)).toEqual({ status: "refused", reason: "unverified" });
    await chmod(w.source, 0o755); await chmod(join(w.source, "manifest.json"), 0o646);
    expect(await run(w)).toEqual({ status: "refused", reason: "unverified" });
    await chmod(join(w.source, "manifest.json"), 0o644);
    expect(await run(w)).toMatchObject({ status: "imported" });
  });

  it("imports a package npm wrote under umask 002 (files 664, folder 775), and installs it owner-only", async () => {
    const w = await world();
    await chmod(w.source, 0o775);
    await chmod(join(w.source, w.engineFile), 0o775);
    await chmod(join(w.source, "manifest.json"), 0o664);
    await chmod(join(w.source, "package.json"), 0o664);
    expect(await run(w)).toMatchObject({ status: "imported" });
    expect((await lstat(w.dest)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(w.dest, w.engineFile))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(w.dest, "manifest.json"))).mode & 0o777).toBe(0o600);
    await expect(verified(w)).resolves.toMatchObject({ version: "1.0.0" });
  });

  it("leaves the previous installation untouched when an import is refused", async () => {
    const w = await world();
    await run(w);
    const before = { ino: await inodeOf(w.dest), exe: await readFile(join(w.dest, w.engineFile)), manifest: await readFile(join(w.dest, "manifest.json")) };
    await publish(w, { version: "2.0.0", seed: "n" });
    await writeFile(join(w.source, w.engineFile), Buffer.concat([header(w.platform, w.arch, "n"), Buffer.from("!")]), { mode: 0o755 });
    expect(await run(w)).toEqual({ status: "refused", reason: "unverified" });
    expect(await inodeOf(w.dest)).toBe(before.ino);
    expect(await readFile(join(w.dest, w.engineFile))).toEqual(before.exe);
    expect(await readFile(join(w.dest, "manifest.json"))).toEqual(before.manifest);
    expect(await verified(w)).toMatchObject({ version: "1.0.0" });
    expect((await readdir(w.home)).sort()).toEqual(["engine", pkg.MINIMUM_VERSION_FILE]);
  });

  it("puts the previous installation back when the swap itself fails, and leaves no stage behind", async () => {
    const w = await world();
    await run(w);
    const before = await readFile(join(w.dest, w.engineFile));
    await publish(w, { version: "1.5.0", seed: "q" });
    const real = fileSystem.rename.bind(fileSystem);
    vi.spyOn(fileSystem, "rename").mockImplementation(async (from: any, to: any) => {
      if (String(to) === w.dest && String(from).includes("engine-import-")) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return real(from, to);
    });
    expect(await run(w)).toEqual({ status: "refused", reason: "unverified" });
    vi.restoreAllMocks();
    expect(await readFile(join(w.dest, w.engineFile))).toEqual(before);
    expect(await verified(w)).toMatchObject({ version: "1.0.0" });
    expect((await readdir(w.home)).sort()).toEqual(["engine", pkg.MINIMUM_VERSION_FILE]);
  });
});

describe.skipIf(!['darwin', 'linux'].includes(process.platform))("the Command Panel's engine and the package", () => {
  const key = pem(generateKeyPairSync("ed25519").publicKey);
  const fake = () => ({ enabled: true, running: false, capabilities: { terminal: { backend: "tmux" } }, start: async () => {}, request: async () => ({ status: 200, body: { ok: true } }), close: async () => {} });
  const spied = () => (["lstat", "open", "readFile", "readdir", "realpath", "mkdir", "mkdtemp", "rename", "rm", "stat", "writeFile", "chmod"] as const).map((name) => vi.spyOn(fileSystem, name as any));

  it("with the switch off never touches the package folder: no question, no look", async () => {
    const w = await world();
    const calls = spied();
    const e = commandPanelEngine({ platform: w.platform, env: w.env, keys: w.keys });
    e.switchedOff(); e.stop();
    expect(calls.flatMap((c) => c.mock.calls)).toEqual([]);
  });

  // CHANGED ON PURPOSE (V4 ships the panel on Windows through the engine): this
  // pinned "on Windows, answers unsupported without looking for a package"; a
  // Windows deck now asks for the import like the other platforms do, and with
  // no folder after it answers not-installed.
  it("on Windows, asks for the package like any platform and, with no folder, is not-installed", async () => {
    const importPackage = vi.fn(async () => ({ status: "absent" }));
    const enoent = async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
    const e = commandPanelEngine({ platform: "win32", env: { CCDECK_HOME: "/x" }, keys: [key], importPackage, lstat: enoent });
    expect((await e.route("status", null)).body.code).toBe("not-installed");
    expect(importPackage).toHaveBeenCalledTimes(1);
    expect(importPackage).toHaveBeenCalledWith({ platform: "win32", env: { CCDECK_HOME: "/x" }, keys: [key] });
  });

  it("with no key, never looks for a package, and says what it always said", async () => {
    const w = await world();
    const importPackage = vi.fn();
    const e = commandPanelEngine({ platform: w.platform, env: w.env, keys: [], importPackage });
    expect((await e.route("status", null)).body.code).toBe("not-installed");
    await mkdir(w.dest);
    expect((await e.route("status", null)).body.code).toBe("not-verified");
    expect(importPackage).not.toHaveBeenCalled();
  });

  it("asks for the import on a question, and starts the client under the floor it returns", async () => {
    const createClient = vi.fn(() => fake());
    const importPackage = vi.fn(async () => ({ status: "imported", minimumVersion: "1.2.3" }));
    const e = commandPanelEngine({ platform: "linux", env: { CCDECK_HOME: "/x/deck" }, keys: [key], lstat: async () => ({}), importPackage, createClient });
    expect(importPackage).not.toHaveBeenCalled();
    await e.route("status", null);
    await e.route("status", null);
    expect(importPackage).toHaveBeenCalledTimes(1);
    expect(importPackage).toHaveBeenCalledWith({ platform: "linux", env: { CCDECK_HOME: "/x/deck" }, keys: [key] });
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ directory: "/x/deck/engine", minimumVersion: "1.2.3" }));
    e.stop();
  });

  it("answers not-verified for a refused import with nothing installed, and not-installed with no package", async () => {
    const missing = async () => { throw Object.assign(new Error("none"), { code: "ENOENT" }); };
    const refused = commandPanelEngine({ platform: "linux", env: {}, keys: [key], lstat: missing, importPackage: async () => ({ status: "refused", reason: "downgrade" }) });
    expect((await refused.route("status", null)).body.code).toBe("not-verified");
    const absent = commandPanelEngine({ platform: "linux", env: {}, keys: [key], lstat: missing, importPackage: async () => ({ status: "absent" }) });
    expect((await absent.route("status", null)).body.code).toBe("not-installed");
  });

  it("goes on with the installed engine when an import was refused", async () => {
    const createClient = vi.fn(() => fake());
    const e = commandPanelEngine({ platform: "linux", env: {}, keys: [key], lstat: async () => ({}), importPackage: async () => ({ status: "refused", reason: "downgrade", minimumVersion: "1.1.0" }), createClient });
    expect((await e.route("status", null)).status).toBe(200);
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ minimumVersion: "1.1.0" }));
    e.stop();
  });
});

describe.skipIf(!['darwin', 'linux'].includes(process.platform))("the Windows rules, against a mocked ACL reader", () => {
  const good = { owner: "me", writers: ["me", "NT AUTHORITY\\SYSTEM"], reparsePoint: false, links: 1 };
  const reader = (over: Record<string, unknown> = {}, identity: Record<string, unknown> = {}) => ({
    identity: async () => ({ user: "me", elevated: false, ...identity }),
    inspect: async () => ({ ...good, ...over }),
  });
  const win = async () => world("win32", "x64");
  const importing = (w: World, windowsAcl?: unknown) => run(w, { dataFolder: w.home, windowsAcl });

  it("imports and verifies when the reader finds an owner-only, link-free, unelevated install", async () => {
    const w = await win();
    expect(await importing(w, reader())).toEqual({ status: "imported", minimumVersion: "1.0.0" });
    await expect(install.verifyEngineInstallation({ directory: w.dest, publicKey: w.keys, windowsAcl: reader(), platform: "win32", arch: "x64" })).resolves.toMatchObject({ version: "1.0.0", target: "x86_64-pc-windows-msvc" });
  });

  it("refuses without a reader, as the installer always did on Windows", async () => {
    const w = await win();
    expect(await importing(w)).toEqual({ status: "refused", reason: "unverified" });
    await expect(install.verifyEngineInstallation({ directory: w.home, publicKey: w.keys, platform: "win32", arch: "x64" })).rejects.toThrow("could not be verified");
    expect(await readdir(w.home)).toEqual([]);
  });

  it("refuses when Users, Everyone or Authenticated Users can write", async () => {
    for (const writer of ["Everyone", "BUILTIN\\Users", "Users", "NT AUTHORITY\\Authenticated Users", "S-1-1-0", "S-1-5-11", "S-1-5-32-545"]) {
      const w = await win();
      expect(await importing(w, reader({ writers: ["me", writer] })), writer).toEqual({ status: "refused", reason: "unverified" });
      expect(await readdir(w.home), writer).toEqual([]);
    }
  });

  it("refuses reparse points, hard links, a foreign owner and an elevated process", async () => {
    for (const acl of [reader({ reparsePoint: true }), reader({ links: 2 }), reader({ owner: "someone-else" }), reader({}, { elevated: true }), reader({}, { user: "" })]) {
      const w = await win();
      expect(await importing(w, acl)).toEqual({ status: "refused", reason: "unverified" });
      expect(await readdir(w.home)).toEqual([]);
    }
  });

  it("refuses a Windows package whose executable is not a PE image of this arch", async () => {
    const w = await win();
    await publish(w, { bytes: header("win32", "arm64") });
    expect(await importing(w, reader())).toEqual({ status: "refused", reason: "wrong-machine" });
    await publish(w, { bytes: header("linux", "x64") });
    expect(await importing(w, reader())).toEqual({ status: "refused", reason: "wrong-machine" });
  });
});
