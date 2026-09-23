// The desktop app's own macOS updater and the pieces around it (#1160).
//
// What is pinned is the chain of checks an update must pass before it replaces
// a running app, because each one is the only thing standing between a user
// and whatever a compromised download would install:
//
//   newer version → the manifest's size and SHA-256 → an Ed25519 signature by
//   ccdeck's update key → (on a Mac) the running app's designated requirement
//
// The last one needs codesign and a real bundle, and was exercised end to end
// on a Mac in the phase-0 spike: 3.25.3 updated itself to 3.25.4; a tampered
// signature and a foreign app signed with the right update key were both
// refused. What runs here is every check that can run anywhere.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain .mjs, no types
import { isNewer, pickFile, verifyZip, bundleOf, UPDATE_PUBLIC_KEY, checkForUpdate, SWAP_SCRIPT, stageUpdate, installOnExit, discard } from "../../../desktop/updater-mac.mjs";
// @ts-expect-error — plain .mjs, no types
import { signEntry } from "../../../desktop/scripts/sign-update.mjs";
// @ts-expect-error — plain .mjs, no types
import { inked, markPng, STATES } from "../../../desktop/scripts/icons.mjs";

const require = createRequire(import.meta.url);
const { requirementForLeaf } = require("../../../desktop/scripts/sign-mac.cjs");

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    pub: publicKey.export({ type: "spki", format: "pem" }).toString(),
    priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

describe("which version is newer", () => {
  it("orders releases by number", () => {
    expect(isNewer("3.25.4", "3.25.3")).toBe(true);
    expect(isNewer("3.26.0", "3.25.9")).toBe(true);
    expect(isNewer("3.25.3", "3.25.4")).toBe(false);
    expect(isNewer("3.25.4", "3.25.4")).toBe(false);
  });

  it("ranks a release above its own prerelease", () => {
    expect(isNewer("3.25.4", "3.25.4-beta.1")).toBe(true);
    expect(isNewer("3.25.4-beta.1", "3.25.4")).toBe(false);
    expect(isNewer("3.25.4-beta.10", "3.25.4-beta.9")).toBe(true);
  });

  it("never treats something unparseable as newer", () => {
    // A manifest that cannot be read must not be able to talk the app into an
    // install.
    expect(isNewer("latest", "3.25.3")).toBe(false);
    expect(isNewer(undefined, "3.25.3")).toBe(false);
  });
});

describe("the download", () => {
  const bytes = Buffer.from("pretend this is a zip");

  it("passes when the size, the hash and the signature all match", () => {
    const { pub, priv } = keys();
    const entry = signEntry(bytes, { name: "ccdeck-3.25.4-mac.zip", arch: "arm64", keyPem: priv });
    expect(entry.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(verifyZip(bytes, entry, pub)).toBe(true);
  });

  it("fails when one byte changed on the way", () => {
    const { pub, priv } = keys();
    const entry = signEntry(bytes, { name: "z", arch: "x64", keyPem: priv });
    const altered = Buffer.from(bytes);
    altered[0] ^= 1;
    expect(verifyZip(altered, { ...entry, size: altered.length, sha256: createHash("sha256").update(altered).digest("hex") }, pub)).toBe(false);
  });

  it("fails when signed by any key but ccdeck's", () => {
    // The hash and size can be recomputed by whoever serves the file; only the
    // signature cannot.
    const theirs = keys(), ours = keys();
    const entry = signEntry(bytes, { name: "z", arch: "x64", keyPem: theirs.priv });
    expect(verifyZip(bytes, entry, ours.pub)).toBe(false);
  });

  it("fails on a wrong size or a garbage signature, without throwing", () => {
    const { pub, priv } = keys();
    const entry = signEntry(bytes, { name: "z", arch: "x64", keyPem: priv });
    expect(verifyZip(bytes, { ...entry, size: entry.size + 1 }, pub)).toBe(false);
    expect(verifyZip(bytes, { ...entry, signature: "not base64 at all!" }, pub)).toBe(false);
  });

  it("refuses bytes the manifest does not describe, even when the signature over them is good", () => {
    // Check 2 on its own. The case above changes a byte and so fails the
    // signature too; here the bytes are exactly what the key signed and only
    // the manifest's hash disagrees — a manifest and a file that are not each
    // other's.
    const { pub, priv } = keys();
    const entry = signEntry(bytes, { name: "z", arch: "x64", keyPem: priv });
    expect(verifyZip(bytes, { ...entry, sha256: createHash("sha256").update("another zip").digest("hex") }, pub)).toBe(false);
    expect(verifyZip(bytes, { ...entry, sha256: undefined }, pub)).toBe(false);
  });

  it("refuses rather than throws when the key itself cannot be read", () => {
    // A refusal the caller can report, not an exception from inside the check.
    const { priv } = keys();
    const entry = signEntry(bytes, { name: "z", arch: "x64", keyPem: priv });
    expect(verifyZip(bytes, entry, "not a public key")).toBe(false);
  });

  it("ships a real Ed25519 public key", () => {
    expect(UPDATE_PUBLIC_KEY).toMatch(/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=]+\n-----END PUBLIC KEY-----\n$/);
  });
});

describe("finding the update", () => {
  const manifest = {
    version: "3.25.4",
    files: [
      { arch: "arm64", url: "ccdeck-3.25.4-arm64-mac.zip", size: 1, sha256: "a", signature: "s" },
      { arch: "x64", url: "ccdeck-3.25.4-mac.zip", size: 1, sha256: "b", signature: "s" },
    ],
  };
  const fetchImpl = async () => ({ ok: true, json: async () => manifest });

  it("picks the file for this CPU and resolves it against the manifest", async () => {
    const u = await checkForUpdate({
      manifestUrl: "https://github.com/o/r/releases/latest/download/latest-mac.json",
      currentVersion: "3.25.3", arch: "arm64", fetchImpl,
    });
    expect(u.version).toBe("3.25.4");
    expect(u.url).toBe("https://github.com/o/r/releases/latest/download/ccdeck-3.25.4-arm64-mac.zip");
  });

  it("finds nothing when this version is current, or no file fits this CPU", async () => {
    expect(await checkForUpdate({ manifestUrl: "https://x/m.json", currentVersion: "3.25.4", arch: "x64", fetchImpl })).toBeNull();
    expect(pickFile(manifest, "ia32")).toBeNull();
  });

  it("fails loudly on a manifest the release does not serve", async () => {
    // An error, not "up to date": the tray says which, and a Mac that cannot
    // read the manifest must not be told it has nothing to install.
    const failing = async () => ({ ok: false, status: 500 });
    await expect(checkForUpdate({ manifestUrl: "https://x/latest-mac.json", currentVersion: "3.25.3", arch: "arm64", fetchImpl: failing }))
      .rejects.toThrow("manifest 500");
  });

  it("finds nothing when a newer release has no file for this CPU", async () => {
    const x64Only = async () => ({ ok: true, json: async () => ({ version: "3.25.4", files: [manifest.files[1]] }) });
    expect(await checkForUpdate({ manifestUrl: "https://x/m.json", currentVersion: "3.25.3", arch: "arm64", fetchImpl: x64Only })).toBeNull();
  });

  it("finds the bundle from the executable's path", () => {
    expect(bundleOf("/Applications/ccdeck.app/Contents/MacOS/ccdeck")).toBe("/Applications/ccdeck.app");
  });

  it("swaps with every path as argv, never inside the script text", () => {
    // A bundle path with a space or a quote must be data to the shell.
    expect(SWAP_SCRIPT).not.toMatch(/\$\{|Applications/);
    expect(SWAP_SCRIPT).toContain('mv "$target" "$backup"');
  });
});

describe("the macOS signing requirement", () => {
  it("pins the app id and the certificate, not the build", () => {
    // An ad-hoc requirement is `cdhash H"…"`, a different app on every build;
    // this one is satisfied by every build signed with the same certificate.
    expect(requirementForLeaf("101d26314e1de3458ab863561d63937395792a34", "dev.ccdeck.app"))
      .toBe('identifier "dev.ccdeck.app" and certificate leaf = H"101d26314e1de3458ab863561d63937395792a34"');
  });
});

describe("the icons", () => {
  it("draws the favicon's four shapes", () => {
    expect(STATES).toEqual(["idle", "running", "waiting", "offline"]);
    // Centre: only running (dot) and waiting (disc) are inked.
    expect(inked("idle", 16, 16)).toBe(false);
    expect(inked("running", 16, 16)).toBe(true);
    expect(inked("waiting", 16, 16)).toBe(true);
    // On the ring at 3 o'clock every state but waiting's disc edge agrees.
    expect(inked("idle", 28, 16)).toBe(true);
    // Offline's gap is at the top.
    expect(inked("offline", 16, 4)).toBe(false);
    expect(inked("idle", 16, 4)).toBe(true);
  });

  it("writes a real PNG", () => {
    const png = markPng("idle", 16, [0, 0, 0]);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });
});

describe("staging a download", () => {
  // stageUpdate runs `ditto` and `codesign`, which only a Mac has, so they are
  // stood in for here: what is pinned is the order the checks run in, what is
  // written before each of them, and what is left behind when one refuses. The
  // real codesign check was exercised on a Mac in the phase-0 spike.
  const bytes = Buffer.from("pretend this is a zip");
  const RUNNING = "/Applications/ccdeck.app";
  const REQUIREMENT = 'identifier "dev.ccdeck.app" and certificate leaf = H"101d26314e1de3458ab863561d63937395792a34"';
  let tmp = "";
  const saved: Record<string, string | undefined> = {};

  // Every temp directory stageUpdate makes lands in a fresh one of this test's
  // own, so "nothing was left" can be read off it.
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ccdeck-stage-"));
    for (const k of ["TMPDIR", "TMP", "TEMP"]) { saved[k] = process.env[k]; process.env[k] = tmp; }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmTempDir(tmp);
  });

  const leftBehind = () => readdirSync(tmp).filter(n => n.startsWith("ccdeck-update-"));
  const served = (body: Buffer) => async () => ({ ok: true, arrayBuffer: async () => Uint8Array.from(body).buffer });

  /** ditto and codesign as a Mac would answer them: `unpack` fills the folder
   *  ditto was asked to unpack into, and `identity` answers the check. */
  function tools({ unpack = (_dir: string) => {}, identity = () => {} } = {}) {
    const calls: string[][] = [];
    const execFileImpl = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === "ditto") { mkdirSync(args[3], { recursive: true }); unpack(args[3]); return { stdout: "", stderr: "" }; }
      if (cmd === "codesign" && args[0] === "-d") return { stdout: `designated => ${REQUIREMENT}\n`, stderr: `Executable=${RUNNING}/Contents/MacOS/ccdeck\n` };
      if (cmd === "codesign" && args[0] === "--verify") { identity(); return { stdout: "", stderr: "" }; }
      throw new Error(`nothing here answers ${cmd}`);
    };
    return { calls, execFileImpl };
  }
  const signedUpdate = (priv: string) => ({
    version: "3.25.4",
    file: signEntry(bytes, { name: "ccdeck-mac-arm64.zip", arch: "arm64", keyPem: priv }),
    url: "https://github.com/o/r/releases/latest/download/ccdeck-mac-arm64.zip",
  });

  it("refuses a download that fails its hash before writing or unpacking any of it", async () => {
    const t = tools();
    const update = { url: "https://x/ccdeck-mac-arm64.zip", file: { size: 3, sha256: "x", signature: "s" } };
    await expect(stageUpdate(update, { runningApp: RUNNING, fetchImpl: served(Buffer.from("abc")), execFileImpl: t.execFileImpl }))
      .rejects.toThrow(/hash or signature/);
    expect(t.calls).toEqual([]);
    expect(leftBehind()).toEqual([]);
  });

  it("refuses a download that did not arrive", async () => {
    const t = tools();
    await expect(stageUpdate({ url: "https://x/z.zip", file: {} }, { runningApp: RUNNING, fetchImpl: async () => ({ ok: false, status: 404 }), execFileImpl: t.execFileImpl }))
      .rejects.toThrow("download 404");
    expect(t.calls).toEqual([]);
  });

  it("throws away a signed update with no app in it", async () => {
    const { pub, priv } = keys();
    const t = tools({ unpack: dir => writeFileSync(join(dir, "README"), "no bundle here") });
    await expect(stageUpdate(signedUpdate(priv), { runningApp: RUNNING, fetchImpl: served(bytes), execFileImpl: t.execFileImpl, publicKeyPem: pub }))
      .rejects.toThrow("the update holds no .app");
    // The zip and whatever it unpacked, gone with the refusal: nothing else
    // knows where they are.
    expect(leftBehind()).toEqual([]);
  });

  it("throws away an update the running app's identity refuses", async () => {
    // Check 4 — a different app, or a build signed with a different
    // certificate. A dev build is refused here every six hours, so what it
    // leaves behind adds up.
    const { pub, priv } = keys();
    const t = tools({
      unpack: dir => mkdirSync(join(dir, "ccdeck.app")),
      identity: () => { throw new Error("test-requirement: code failed to satisfy specified code requirement(s)"); },
    });
    await expect(stageUpdate(signedUpdate(priv), { runningApp: RUNNING, fetchImpl: served(bytes), execFileImpl: t.execFileImpl, publicKeyPem: pub }))
      .rejects.toThrow(/code requirement/);
    expect(leftBehind()).toEqual([]);
  });

  it("stages an update that passes, checked against the app that is running", async () => {
    const { pub, priv } = keys();
    const t = tools({ unpack: dir => mkdirSync(join(dir, "ccdeck.app")) });
    const { staged, dir } = await stageUpdate(signedUpdate(priv), { runningApp: RUNNING, fetchImpl: served(bytes), execFileImpl: t.execFileImpl, publicKeyPem: pub });
    expect(leftBehind()).toEqual([basename(dir)]);
    expect(staged).toBe(join(dir, "app", "ccdeck.app"));
    expect(readFileSync(join(dir, "update.zip"))).toEqual(bytes);
    expect(t.calls).toEqual([
      ["ditto", "-x", "-k", join(dir, "update.zip"), join(dir, "app")],
      // The requirement is read from the RUNNING app, and the new one has to
      // satisfy it — never the other way round.
      ["codesign", "-d", "-r-", RUNNING],
      ["codesign", "--verify", "--deep", "--strict", `-R=${REQUIREMENT}`, staged],
    ]);
    await discard(dir);
    expect(leftBehind()).toEqual([]);
  });
});

describe("the signing script, run the way CI runs it", () => {
  // CI calls sign-update.mjs once per Mac zip, arm64 and then x64, into the
  // same latest-mac.json. A script that rewrote the file each time would leave
  // only the last CPU in it, and every Mac of the other kind would be told
  // "Up to date" from then on.
  const script = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "desktop", "scripts", "sign-update.mjs");
  const FEED_URL = "https://github.com/o/r/releases/latest/download";
  let dir = "";
  let key = keys();
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccdeck-sign-update-"));
    key = keys();
  });
  afterEach(() => rmTempDir(dir));

  const manifestPath = () => join(dir, "latest-mac.json");
  const zip = (arch: string, content: string) => {
    const path = join(dir, `ccdeck-mac-${arch}.zip`);
    writeFileSync(path, content);
    return path;
  };
  const sign = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { env: { ...process.env, CCDECK_UPDATE_KEY: key.priv }, encoding: "utf8" });
  const manifest = () => JSON.parse(readFileSync(manifestPath(), "utf8"));

  it("writes both Macs into one manifest, one call per zip", () => {
    expect(sign(zip("arm64", "apple silicon build"), "3.27.0", "arm64", manifestPath()).status).toBe(0);
    expect(sign(zip("x64", "intel build"), "3.27.0", "x64", manifestPath()).status).toBe(0);
    const m = manifest();
    expect(m.version).toBe("3.27.0");
    expect(m.files.map((f: { arch: string }) => f.arch)).toEqual(["arm64", "x64"]);
    expect(m.files.map((f: { url: string }) => f.url)).toEqual(["ccdeck-mac-arm64.zip", "ccdeck-mac-x64.zip"]);
  });

  it("replaces a CPU's entry when it is signed again, and keeps the other", () => {
    sign(zip("arm64", "first arm64 build"), "3.27.0", "arm64", manifestPath());
    sign(zip("x64", "intel build"), "3.27.0", "x64", manifestPath());
    const intel = manifest().files[1];
    sign(zip("arm64", "second arm64 build"), "3.27.0", "arm64", manifestPath());
    const files = manifest().files as Array<{ arch: string; sha256: string }>;
    expect(files).toHaveLength(2);
    expect(files.find(f => f.arch === "arm64")!.sha256).toBe(createHash("sha256").update("second arm64 build").digest("hex"));
    expect(files.find(f => f.arch === "x64")).toEqual(intel);
  });

  it("refuses to run without all four arguments", () => {
    const r = sign(zip("arm64", "x"), "3.27.0", "arm64");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage:");
    expect(existsSync(manifestPath())).toBe(false);
  });

  it.each(["arm64", "x64"])("writes a manifest the %s app reads back and verifies", async (arch) => {
    const zips = { arm64: zip("arm64", "apple silicon build"), x64: zip("x64", "intel build") };
    sign(zips.arm64, "3.27.0", "arm64", manifestPath());
    sign(zips.x64, "3.27.0", "x64", manifestPath());
    const text = readFileSync(manifestPath(), "utf8");
    const update = await checkForUpdate({
      manifestUrl: `${FEED_URL}/latest-mac.json`, currentVersion: "3.26.0", arch,
      fetchImpl: async () => ({ ok: true, json: async () => JSON.parse(text) }),
    });
    expect(update.url).toBe(`${FEED_URL}/ccdeck-mac-${arch}.zip`);
    expect(verifyZip(readFileSync(zips[arch as "arm64" | "x64"]), update.file, key.pub)).toBe(true);
  });
});

// A probe, like sound-hook-park's: chmod 0555 stops a write into a directory
// on macOS and Linux for anyone but root, and on Windows stops nothing.
const readOnlyDirBlocksWrites = (() => {
  const probe = mkdtempSync(join(tmpdir(), "ccdeck-ro-probe-"));
  try {
    chmodSync(probe, 0o555);
    writeFileSync(join(probe, "x"), "x");
    return false;
  } catch {
    return true;
  } finally {
    chmodSync(probe, 0o755);
    rmTempDir(probe);
  }
})();

/** A pid that is certainly not running any more. */
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;

/**
 * A Mac's install in miniature: an installed bundle holding `file` = "old", a
 * staged one holding "new" inside the update's work folder, and a bin folder
 * that stands in for what the swap script calls — ditto as `cp -R` (or as
 * whatever `ditto` says), xattr as nothing, and open writing down what it was
 * asked to open. mv, rm, kill and sleep are the system's own.
 */
function swapBed({ folder = "Applications", ditto = 'cp -R "$1" "$2"' } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ccdeck-swap-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const tool = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  tool("ditto", ditto);
  tool("xattr", "exit 0");
  tool("open", 'printf "%s\\n" "$@" >> "$OPEN_LOG"');
  const target = join(root, folder, "ccdeck.app");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "file"), "old");
  const work = join(root, "ccdeck-update-x");
  const staged = join(work, "app", "ccdeck.app");
  mkdirSync(staged, { recursive: true });
  writeFileSync(join(staged, "file"), "new");
  const log = join(root, "opened.log");
  return {
    root, target, staged, work,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OPEN_LOG: log },
    installed: () => readFileSync(join(target, "file"), "utf8"),
    opened: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
  };
}

/** The script exactly as installOnExit hands it to /bin/sh, run to the end. */
const swap = (bed: ReturnType<typeof swapBed>, pid: number) =>
  spawnSync("/bin/sh", ["-c", SWAP_SCRIPT, "ccdeck-swap", String(pid), bed.target, bed.staged, bed.work], { env: bed.env, encoding: "utf8" });

describe.skipIf(process.platform === "win32")("the swap script, run", () => {
  // The step that deletes the installed app, pinned until now by one line of
  // its text. The script is macOS's, and nothing in it is: /bin/sh, mv, rm,
  // kill and sleep, with ditto, xattr and open stood in for — so it runs on
  // the Linux leg as well, and not on Windows, which has no /bin/sh.
  const beds: Array<ReturnType<typeof swapBed>> = [];
  const bedFor = (o?: Parameters<typeof swapBed>[0]) => { const b = swapBed(o); beds.push(b); return b; };
  const env: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const b of beds.splice(0)) rmTempDir(b.root);
  });

  it("puts the new app in place of the old, cleans up, and opens it", async () => {
    // Through installOnExit itself, so the order it hands the paths over in is
    // part of what is run.
    const bed = bedFor();
    for (const k of ["PATH", "OPEN_LOG"]) { env[k] = process.env[k]; process.env[k] = bed.env[k]; }
    installOnExit({ pid: deadPid(), target: bed.target, staged: bed.staged, dir: bed.work });
    for (let i = 0; i < 500 && bed.opened().length === 0; i++) await new Promise(r => setTimeout(r, 20));
    expect(bed.opened()).toEqual([bed.target]);
    expect(bed.installed()).toBe("new");
    expect(existsSync(`${bed.target}.ccdeck-old`)).toBe(false);
    expect(existsSync(bed.work)).toBe(false);
  });

  it("puts the old app back when the new one cannot be copied in, and still opens it", () => {
    // A ditto that gets halfway: the half-written bundle has to go before the
    // old one can move back, or the old one ends up INSIDE it.
    const bed = bedFor({ ditto: 'mkdir -p "$2"; echo partial > "$2/file"; exit 1' });
    swap(bed, deadPid());
    expect(bed.installed()).toBe("old");
    expect(existsSync(`${bed.target}.ccdeck-old`)).toBe(false);
    expect(readdirSync(bed.target)).toEqual(["file"]);
    expect(bed.opened()).toEqual([bed.target]);
  });

  it("touches nothing until the app it replaces has exited", async () => {
    const bed = bedFor();
    const app = spawn("sleep", ["1"]);
    const script = spawn("/bin/sh", ["-c", SWAP_SCRIPT, "ccdeck-swap", String(app.pid), bed.target, bed.staged, bed.work], { env: bed.env, stdio: "ignore" });
    const done = new Promise(r => script.on("exit", r));
    await new Promise(r => setTimeout(r, 300));
    expect(bed.installed()).toBe("old");
    expect(bed.opened()).toEqual([]);
    await done;
    expect(bed.installed()).toBe("new");
    expect(bed.opened()).toEqual([bed.target]);
  });

  it("keeps a path with a space and a quote in it as one path", () => {
    const bed = bedFor({ folder: "Apps of O'Neil" });
    expect(swap(bed, deadPid()).status).toBe(0);
    expect(bed.installed()).toBe("new");
    expect(bed.opened()).toEqual([bed.target]);
  });
});

describe("the swap script, when the old app cannot be moved", () => {
  // An /Applications the person cannot write to. The script must stop there:
  // carrying on would copy the new app INTO the old one, and open it.
  it.skipIf(!readOnlyDirBlocksWrites)("gives up and leaves the installed app as it was", () => {
    const bed = swapBed();
    chmodSync(dirname(bed.target), 0o555);
    try {
      const r = swap(bed, deadPid());
      expect(r.status).toBe(1);
      expect(bed.installed()).toBe("old");
      expect(readdirSync(bed.target)).toEqual(["file"]);
      expect(bed.opened()).toEqual([]);
    } finally {
      chmodSync(dirname(bed.target), 0o755);
      rmTempDir(bed.root);
    }
  });
});
