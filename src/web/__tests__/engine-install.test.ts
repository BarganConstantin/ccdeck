// The page's engine install (engine-install.mjs, engine-download.mjs and the
// routes in terminal-routes.mjs): the pinned package from a registry, a
// package file, cancel, the lock, putting right an install cut short, remove.
//
// Nothing here reaches the network or the deck's own data folder. The
// registry is a fetch stand-in serving a tarball built in the test; the
// package's executable is only a header for this machine (it is never run)
// and its manifest is signed by a throwaway Ed25519 key handed in as the
// deck's key: the deck's own key list is empty and stays so. Every folder is
// a temporary one.
import { afterEach, describe, expect, it } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { gzipSync } from "node:zlib";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
// @ts-expect-error plain server module
import * as installMod from "../../server/engine-install.mjs";
// @ts-expect-error plain server module
import * as download from "../../server/engine-download.mjs";
// @ts-expect-error plain server module
import { handleEngineAction, handleEngineStatus } from "../../server/terminal-routes.mjs";
// @ts-expect-error plain server module
import { GUARDED_READS } from "../../server/request-gates.mjs";
// @ts-expect-error plain server module
import { ENGINE_PUBLIC_KEYS } from "../../server/command-panel-engine.mjs";

const PLATFORM = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
const ARCH = process.arch === "arm64" ? "arm64" : "x64";
const NAME = `@ccdeck/engine-${PLATFORM}-${ARCH}`;
const FILE = PLATFORM === "win32" ? "ccdeck-pro-engine.exe" : "ccdeck-pro-engine";
const REG = "https://registry.test/";
const META = `${REG}@ccdeck%2fengine-${PLATFORM}-${ARCH}/1.0.0`;
const TARBALL = `${REG}@ccdeck/engine/-/engine-1.0.0.tgz`;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

const pem = (key: KeyObject) => key.export({ type: "spki", format: "pem" }) as string;

/** An executable's first bytes for this machine, then `seed`, so two differ. */
function header(seed = "a"): Buffer {
  const tail = Buffer.from(seed.repeat(64));
  if (PLATFORM === "linux") {
    const h = Buffer.alloc(64);
    h.writeUInt32BE(0x7f454c46, 0); h[4] = 2; h[5] = 1; h.writeUInt16LE(ARCH === "arm64" ? 183 : 62, 18);
    return Buffer.concat([h, tail]);
  }
  if (PLATFORM === "darwin") {
    const h = Buffer.alloc(32);
    h.writeUInt32LE(0xfeedfacf, 0); h.writeUInt32LE(ARCH === "arm64" ? 0x0100000c : 0x01000007, 4);
    return Buffer.concat([h, tail]);
  }
  const h = Buffer.alloc(0x100);
  h.writeUInt16BE(0x4d5a, 0); h.writeUInt32LE(0x80, 0x3c); h.writeUInt32BE(0x50450000, 0x80); h.writeUInt16LE(ARCH === "arm64" ? 0xaa64 : 0x8664, 0x84);
  return Buffer.concat([h, tail]);
}

/** One ustar entry. */
function tarEntry(name: string, data: Buffer, type = "0", linkname = ""): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  if (linkname) h.write(linkname, 157, 100, "utf8");
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
const tgzOf = (entries: Buffer[]) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));

interface World {
  base: string; data: string; root: string; home: string;
  signer: { privateKey: KeyObject; publicKey: KeyObject }; keys: string[];
}

async function world(): Promise<World> {
  const base = await mkdtemp(join(tmpdir(), "ccdeck-engine-install-")); roots.push(base); await chmod(base, 0o700);
  const home = join(base, "home");
  const data = join(home, ".local", "share", "ccdeck");
  const root = join(base, "deck");
  await mkdir(data, { recursive: true, mode: 0o700 });
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "ccdeck", version: "9.9.9", optionalDependencies: { [NAME]: "1.0.0" } }));
  const signer = generateKeyPairSync("ed25519");
  return { base, data, root, home, signer, keys: [pem(signer.publicKey)] };
}

/** The platform package's three files, as npm packs them. */
function packageFiles(w: World, { version = "1.0.0", name = NAME, seed = "a", signer = w.signer }: { version?: string; name?: string; seed?: string; signer?: { privateKey: KeyObject } } = {}) {
  const exe = header(seed);
  const target = ({ linux: "unknown-linux-gnu", darwin: "apple-darwin", win32: "pc-windows-msvc" } as Record<string, string>)[PLATFORM];
  const entry = { file: FILE, protocol: 1, target: `${ARCH === "arm64" ? "aarch64" : "x86_64"}-${target}`, sha256: createHash("sha256").update(exe).digest("hex"), size: exe.length, version };
  const payload = Buffer.from(JSON.stringify(entry));
  const manifest = Buffer.from(JSON.stringify({ payload: payload.toString("base64"), signature: sign(null, payload, signer.privateKey).toString("base64") }));
  return [
    tarEntry("package/package.json", Buffer.from(JSON.stringify({ name, version }))),
    tarEntry("package/manifest.json", manifest),
    tarEntry(`package/${FILE}`, exe),
  ];
}

const sri = (bytes: Buffer) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

type Fetch = (url: URL | string, init?: RequestInit) => Promise<Response>;

/** The registry: the pinned version's metadata, then its tarball. */
function registry(tgz: Buffer, { integrity, metaStatus = 200, hold = false }: { integrity?: string; metaStatus?: number; hold?: boolean } = {}): Fetch {
  return async (url, init) => {
    const u = String(url);
    if (u === META) {
      if (metaStatus !== 200) return new Response("{}", { status: metaStatus });
      return Response.json({ name: NAME, version: "1.0.0", dist: { tarball: TARBALL, integrity: integrity ?? sri(tgz) } });
    }
    if (u === TARBALL) {
      // `hold`: the first half, then nothing until the request is cancelled.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (!hold) { controller.enqueue(new Uint8Array(tgz)); controller.close(); return; }
          controller.enqueue(new Uint8Array(tgz.subarray(0, tgz.length >> 1)));
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      });
      return new Response(body, { headers: { "content-length": String(tgz.length) } });
    }
    throw new TypeError(`unexpected ${u}`);
  };
}

const offline: Fetch = async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND registry.test"), { code: "ENOTFOUND" }) }); };

function installer(w: World, extra: Record<string, unknown> = {}) {
  return installMod.createEngineInstaller({
    platform: PLATFORM, arch: ARCH, env: {}, keys: w.keys, dataFolder: w.data, root: w.root, registry: REG,
    home: () => w.home, ...extra,
  });
}

/** The status once nothing installs. */
async function settled(i: { status(): Promise<{ job: unknown }> }) {
  for (let n = 0; n < 400; n++) {
    const s = await i.status();
    if (!s.job) return s as Record<string, any>;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("the install never finished");
}

const leftovers = async (w: World) => (await readdir(w.data)).filter((n) => /^engine-(download|import|previous)-/.test(n) || n === "engine.lock");

describe("the engine install's status", () => {
  it("offers nothing without keys, which is today: the deck's own key list is empty", async () => {
    expect(ENGINE_PUBLIC_KEYS).toEqual([]);
    const w = await world();
    const s = await installer(w, { keys: [] }).status();
    expect(s.blocked).toBe("no-keys");
    expect(s.canInstallFile).toBe(false);
    expect(await installer(w, { keys: [] }).install()).toEqual({ ok: false, code: "no-keys" });
  });

  it("names the pinned version, the platform and a ~ path, and reads no network", async () => {
    const w = await world();
    let asked = 0;
    const s = await installer(w, { fetchImpl: async () => { asked += 1; throw new Error("no"); } }).status();
    expect(asked).toBe(0);
    expect(s).toMatchObject({ platform: `${PLATFORM}-${ARCH}`, supported: true, blocked: null, pinned: "1.0.0", installed: null, present: false, job: null });
    expect(s.fixPath).toBe(PLATFORM === "win32" ? null : "~/.local/share/ccdeck");
  });

  it("never sends a path outside the home folder", async () => {
    const w = await world();
    const s = await installer(w, { home: () => join(w.base, "elsewhere") }).status();
    expect(s.fixPath).toBeNull();
  });

  it("says not-published without a pin, unsupported on another platform, download-disabled when downloads are off", async () => {
    const w = await world();
    await writeFile(join(w.root, "package.json"), JSON.stringify({ name: "ccdeck" }));
    expect((await installer(w).status()).blocked).toBe("not-published");
    const freebsd = installMod.createEngineInstaller({ platform: "freebsd", arch: "x64", env: {}, keys: w.keys, dataFolder: w.data, root: w.root });
    expect((await freebsd.status()).blocked).toBe("unsupported");
    const w2 = await world();
    const off = installer(w2, { env: { AGENTS_DECK_NO_DOWNLOAD: "1" } });
    expect((await off.status()).blocked).toBe("download-disabled");
    expect(await off.install()).toEqual({ ok: false, code: "download-disabled" });
    expect((await off.status()).canInstallFile).toBe(true);
  });
});

describe("installing from the registry", () => {
  it("downloads, checks and installs the pinned package, with progress, and leaves nothing behind", async () => {
    const w = await world();
    const tgz = tgzOf(packageFiles(w));
    const seen: number[] = [];
    const i = installer(w, { fetchImpl: registry(tgz) });
    const started = await i.install();
    expect(started.ok).toBe(true);
    // A second press joins the install that runs.
    expect(await i.install()).toEqual(started);
    const s = await settled({ status: async () => { const x = await i.status(); if (x.job) seen.push(x.job.received); return x; } });
    expect(s.last).toMatchObject({ id: started.id, outcome: "done", version: "1.0.0" });
    expect(s.installed?.version).toBe("1.0.0");
    expect(s.installed?.bytes).toBeGreaterThan(0);
    expect((await lstat(join(w.data, "engine", FILE))).isFile()).toBe(true);
    expect(await leftovers(w)).toEqual([]);
  });

  it("refuses a tarball whose sha512 is not the registry's, and installs nothing", async () => {
    const w = await world();
    const tgz = tgzOf(packageFiles(w));
    const i = installer(w, { fetchImpl: registry(tgz, { integrity: sri(Buffer.from("something else")) }) });
    await i.install();
    const s = await settled(i);
    expect(s.last).toMatchObject({ outcome: "failed", code: "check-failed", step: "verify" });
    expect(s.installed).toBeNull();
    await expect(lstat(join(w.data, "engine"))).rejects.toThrow();
    expect(await leftovers(w)).toEqual([]);
  });

  it("refuses a package signed by another key: the check is the manifest's, not the registry's", async () => {
    const w = await world();
    const tgz = tgzOf(packageFiles(w, { signer: generateKeyPairSync("ed25519") }));
    const i = installer(w, { fetchImpl: registry(tgz) });
    await i.install();
    const s = await settled(i);
    expect(s.last).toMatchObject({ outcome: "failed", code: "check-failed" });
    expect(s.installed).toBeNull();
  });

  it("says offline when the registry cannot be reached, and not-published for a 404", async () => {
    const w = await world();
    const i = installer(w, { fetchImpl: offline });
    await i.install();
    expect((await settled(i)).last).toMatchObject({ outcome: "failed", code: "offline", step: "download" });
    const j = installer(w, { fetchImpl: registry(Buffer.alloc(0), { metaStatus: 404 }) });
    await j.install();
    expect((await settled(j)).last).toMatchObject({ outcome: "failed", code: "not-published" });
  });

  it("cancels a download under way, and keeps nothing of it", async () => {
    const w = await world();
    const tgz = tgzOf(packageFiles(w, { seed: "b".repeat(1) }));
    const i = installer(w, { fetchImpl: registry(tgz, { hold: true }) });
    await i.install();
    for (let n = 0; n < 200 && !((await i.status()).job?.received > 0); n++) await new Promise((r) => setTimeout(r, 5));
    expect(i.cancel()).toEqual({ ok: true });
    const s = await settled(i);
    expect(s.last).toMatchObject({ outcome: "cancelled" });
    expect(s.installed).toBeNull();
    expect(await leftovers(w)).toEqual([]);
    expect(i.cancel()).toEqual({ ok: false, code: "nothing-to-cancel" });
  });
});

describe("the package file is read strictly", () => {
  const cases: Array<[string, (w: World) => Buffer[]]> = [
    ["a path that climbs out", (w) => [...packageFiles(w), tarEntry("package/../evil", Buffer.from("x"))]],
    ["a file outside package/", (w) => [...packageFiles(w), tarEntry("other/file", Buffer.from("x"))]],
    ["a symbolic link", (w) => [...packageFiles(w), tarEntry("package/link", Buffer.alloc(0), "2", "/etc/passwd")]],
    ["a file named twice", (w) => [...packageFiles(w), tarEntry("package/manifest.json", Buffer.from("{}"))]],
    ["no manifest", (w) => packageFiles(w).filter((_, n) => n !== 1)],
  ];
  for (const [what, entries] of cases) {
    it(`refuses ${what}`, async () => {
      const w = await world();
      expect(() => download.readPackageTarball(tgzOf(entries(w)))).toThrow();
      const i = installer(w);
      expect((await i.installFile(tgzOf(entries(w)))).ok).toBe(true);
      const s = await settled(i);
      expect(s.last).toMatchObject({ outcome: "failed", code: "check-failed" });
      expect(s.installed).toBeNull();
      expect(await leftovers(w)).toEqual([]);
    });
  }

  it("refuses something that is not a gzip at all", async () => {
    expect(() => download.readPackageTarball(Buffer.from("not a tarball"))).toThrow();
  });
});

describe("installing from a file", () => {
  it("installs the package the person picked, with the same checks", async () => {
    const w = await world();
    const i = installer(w, { env: { AGENTS_DECK_NO_DOWNLOAD: "1" } });
    expect((await i.installFile(tgzOf(packageFiles(w)))).ok).toBe(true);
    const s = await settled(i);
    expect(s.last).toMatchObject({ outcome: "done" });
    expect(s.installed?.version).toBe("1.0.0");
  });

  // Found in the browser pass: under a 0002 umask the deck's own writers leave
  // the data folder 0775, and the engine is verified only where no parent is
  // writable by anyone else, so every install there failed its check.
  it.skipIf(process.platform === "win32")("takes group and other write off ccdeck's own data folder, then installs", async () => {
    const w = await world();
    await chmod(w.data, 0o775);
    const i = installer(w, { env: { AGENTS_DECK_NO_DOWNLOAD: "1" } });
    expect((await i.installFile(tgzOf(packageFiles(w)))).ok).toBe(true);
    const s = await settled(i);
    expect(s.last).toMatchObject({ outcome: "done" });
    expect((await lstat(w.data)).mode & 0o777).toBe(0o755);
  });

  it.skipIf(process.platform === "win32")("leaves a folder above the data folder as it is, and the install says the check failed", async () => {
    const w = await world();
    const above = join(w.home, ".local", "share");
    await chmod(above, 0o775);
    const i = installer(w, { env: { AGENTS_DECK_NO_DOWNLOAD: "1" } });
    await i.installFile(tgzOf(packageFiles(w)));
    expect((await settled(i)).last).toMatchObject({ outcome: "failed", code: "check-failed" });
    expect((await lstat(above)).mode & 0o777).toBe(0o775);
  });

  it("says wrong-machine for another platform's package", async () => {
    const w = await world();
    const otherName = NAME.endsWith("x64") ? NAME.replace("x64", "arm64") : NAME.replace("arm64", "x64");
    const i = installer(w);
    await i.installFile(tgzOf(packageFiles(w, { name: otherName })));
    expect((await settled(i)).last).toMatchObject({ outcome: "failed", code: "wrong-machine" });
  });

  it("never goes below an engine already installed", async () => {
    const w = await world();
    const i = installer(w);
    await i.installFile(tgzOf(packageFiles(w, { version: "2.0.0", seed: "c" })));
    expect((await settled(i)).installed?.version).toBe("2.0.0");
    await i.installFile(tgzOf(packageFiles(w, { version: "1.0.0" })));
    const s = await settled(i);
    expect(s.last).toMatchObject({ outcome: "failed", code: "downgrade" });
    expect(s.installed?.version).toBe("2.0.0");
  });
});

describe("one install at a time", () => {
  it("leaves the folder alone while another live deck holds the lock, and takes over a stale one", async () => {
    const w = await world();
    const tgz = tgzOf(packageFiles(w));
    await writeFile(join(w.data, installMod.LOCK_FILE), JSON.stringify({ pid: process.ppid, at: Date.now() }));
    const i = installer(w, { fetchImpl: registry(tgz) });
    expect((await i.status()).elsewhere).toBe(true);
    await i.install();
    const s = await settled(i);
    expect(s.last).toMatchObject({ outcome: "failed", code: "elsewhere" });
    expect(s.installed).toBeNull();
    // Gone (no such pid) or old: taken over.
    await writeFile(join(w.data, installMod.LOCK_FILE), JSON.stringify({ pid: process.ppid, at: Date.now() - installMod.LOCK_STALE_MS - 1 }));
    await i.install();
    expect((await settled(i)).installed?.version).toBe("1.0.0");
    expect(await leftovers(w)).toEqual([]);
  });

  it("stops the running engine before it changes the folder", async () => {
    const w = await world();
    const calls: string[] = [];
    const i = installer(w, { fetchImpl: registry(tgzOf(packageFiles(w))), beforeChange: async () => { calls.push("stop"); } });
    await i.install();
    await settled(i);
    expect(calls).toEqual(["stop"]);
    expect(await i.remove()).toEqual({ ok: true });
    expect(calls).toEqual(["stop", "stop"]);
  });
});

describe("an install cut short", () => {
  it("removes its folders and puts the previous engine back where none stands", async () => {
    const w = await world();
    const i = installer(w);
    await i.installFile(tgzOf(packageFiles(w)));
    expect((await settled(i)).installed?.version).toBe("1.0.0");
    // What a deck that stopped mid-swap leaves: the engine set aside, a download and an import folder.
    const { rename } = await import("node:fs/promises");
    await rename(join(w.data, "engine"), join(w.data, "engine-previous-abc"));
    await mkdir(join(w.data, "engine-download-xyz"));
    await mkdir(join(w.data, "engine-import-xyz"));
    const fresh = installer(w);
    const s = await fresh.status();
    expect(s.recovered).toBe(true);
    expect(s.installed?.version).toBe("1.0.0");
    expect(await leftovers(w)).toEqual([]);
  });
});

describe("removing the engine", () => {
  it("removes the folder and keeps the floor, so a removed engine never comes back older", async () => {
    const w = await world();
    const i = installer(w);
    await i.installFile(tgzOf(packageFiles(w, { version: "2.0.0", seed: "d" })));
    await settled(i);
    const floorBefore = await readFile(join(w.data, "engine-minimum-version"), "utf8");
    expect(await i.remove()).toEqual({ ok: true });
    const s = await i.status();
    expect(s.installed).toBeNull();
    expect(s.present).toBe(false);
    expect(await readFile(join(w.data, "engine-minimum-version"), "utf8")).toBe(floorBefore);
    await i.installFile(tgzOf(packageFiles(w, { version: "1.0.0" })));
    expect((await settled(i)).last).toMatchObject({ outcome: "failed", code: "downgrade" });
  });
});

/** A response that records what was sent. */
function fakeRes() {
  const res = {
    headersSent: false, status: 0, body: "" as string,
    writeHead(status: number) { res.status = status; res.headersSent = true; return res; },
    end(body?: string) { res.body = body ?? ""; },
  };
  return res;
}
const fakeReq = (body = "") => { const req = new PassThrough(); req.end(body); return req; };

describe("the routes", () => {
  it("are not there with the switch off, exactly as an unknown /api path", async () => {
    const off = { enabled: () => false };
    const a = fakeRes();
    await handleEngineStatus(fakeReq(), a, off);
    expect([a.status, JSON.parse(a.body)]).toEqual([404, { error: "not found" }]);
    const b = fakeRes();
    await handleEngineAction(fakeReq("{}"), b, "install", off);
    expect([b.status, JSON.parse(b.body)]).toEqual([404, { error: "not found" }]);
  });

  it("answer the installer's status, its refusals as 409, an unknown action as 404, and no installer as null", async () => {
    const w = await world();
    const i = installer(w, { keys: [] });
    const on = { enabled: () => true, engine: { enabled: true, installer: i } };
    const a = fakeRes();
    await handleEngineStatus(fakeReq(), a, on);
    expect(a.status).toBe(200);
    expect(JSON.parse(a.body).engine.blocked).toBe("no-keys");
    const b = fakeRes();
    await handleEngineAction(fakeReq("{}"), b, "install", on);
    expect([b.status, JSON.parse(b.body)]).toEqual([409, { ok: false, code: "no-keys" }]);
    const c = fakeRes();
    await handleEngineAction(fakeReq("{}"), c, "format-disk", on);
    expect(c.status).toBe(404);
    const d = fakeRes();
    await handleEngineStatus(fakeReq(), d, { enabled: () => true, engine: { enabled: true } });
    expect(JSON.parse(d.body)).toEqual({ ok: true, engine: null });
  });

  it("installs a file sent as the body", async () => {
    const w = await world();
    const i = installer(w);
    const on = { enabled: () => true, engine: { enabled: true, installer: i } };
    const res = fakeRes();
    const req = new PassThrough();
    req.end(tgzOf(packageFiles(w)));
    await handleEngineAction(req, res, "install-file", on);
    expect(res.status).toBe(200);
    expect((await settled(i)).installed?.version).toBe("1.0.0");
  });

  it("keep the status a guarded read", () => {
    expect(GUARDED_READS.has("/api/terminal/engine")).toBe(true);
  });
});
