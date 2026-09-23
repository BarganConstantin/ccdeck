// createUpdater, the state machine the tray's update item reads (#1160, #1176).
//
// Both halves of the Windows/Linux signature check were tested — CI writes an
// `ed25519` into the yml, the app verifies one — and the gate that wires them
// together never ran. That gate is the whole of what stands between an
// electron-updater download and an install: electron-updater itself checks only
// a SHA-512 served from the same release as the file, so whoever can replace
// one can replace both. Initialise `autoInstallOnAppQuit` to true, move the
// assignment above the verify, and every Windows and Linux app installs
// whatever it downloads, with the suite green.
//
// electron-updater is not in the root install (it is desktop/'s dependency),
// so it is mocked: an EventEmitter with the calls updater.mjs makes. The update
// key is the one thing swapped in updater-mac.mjs for the Windows/Linux cases —
// a key generated here, so a signature can be made that the real
// verifyFileSignature accepts — and on macOS the network and the swap are
// replaced by spies, which is what lets the state machine run without a Mac.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sign } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain .mjs, no types
import { createUpdater, FEED } from "../../../desktop/updater.mjs";
// @ts-expect-error — plain .mjs, no types
import * as mac from "../../../desktop/updater-mac.mjs";

type Fake = {
  on: (event: string, fn: (...args: unknown[]) => unknown) => void;
  emit: (event: string, ...args: unknown[]) => boolean;
  checkForUpdates: ReturnType<typeof vi.fn>;
  quitAndInstall: ReturnType<typeof vi.fn>;
  setFeedURL: ReturnType<typeof vi.fn>;
  autoInstallOnAppQuit?: boolean;
  autoDownload?: boolean;
};

const h = await vi.hoisted(async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const ours = generateKeyPairSync("ed25519");
  const theirs = generateKeyPairSync("ed25519");
  const pem = (k: { export: (o: object) => string | Buffer }, type: string) => k.export({ type, format: "pem" }).toString();
  return {
    pub: pem(ours.publicKey, "spki"),
    priv: pem(ours.privateKey, "pkcs8"),
    foreignPriv: pem(theirs.privateKey, "pkcs8"),
    // A fresh autoUpdater per case, so no listener outlives the updater that
    // registered it.
    auto: null as unknown,
  };
});

// Shaped like the real one, a CommonJS module: its exports arrive as `default`.
vi.mock("electron-updater", () => {
  return { default: { get autoUpdater() { return h.auto; } } };
});

vi.mock("../../../desktop/updater-mac.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  UPDATE_PUBLIC_KEY: h.pub,
  checkForUpdate: vi.fn(),
  stageUpdate: vi.fn(),
  installOnExit: vi.fn(),
  discard: vi.fn(async () => {}),
}));

async function newFake(): Promise<Fake> {
  const { EventEmitter } = await import("node:events");
  const fake = new EventEmitter() as unknown as Fake;
  fake.checkForUpdates = vi.fn(async () => {});
  fake.quitAndInstall = vi.fn();
  fake.setFeedURL = vi.fn();
  return fake;
}

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const onPlatform = (p: string) => Object.defineProperty(process, "platform", { ...realPlatform, value: p });

const EXE = "/Applications/ccdeck.app/Contents/MacOS/ccdeck";
const appLike = (over: Record<string, unknown> = {}) => ({
  isPackaged: true,
  getVersion: () => "3.26.0",
  getPath: (name: string) => (name === "exe" ? EXE : `/nowhere/${name}`),
  quit: vi.fn(),
  ...over,
});

type State = { status: string; version?: string; error?: string };

let fake: Fake;
let dir = "";
let feedEnv: string | undefined;

beforeEach(async () => {
  fake = await newFake();
  h.auto = fake;
  dir = mkdtempSync(join(tmpdir(), "ccdeck-updater-state-"));
  feedEnv = process.env.CCDECK_UPDATE_FEED;
  delete process.env.CCDECK_UPDATE_FEED;
  vi.mocked(mac.checkForUpdate).mockReset();
  vi.mocked(mac.stageUpdate).mockReset();
  vi.mocked(mac.installOnExit).mockReset();
  vi.mocked(mac.discard).mockClear();
});

afterEach(() => {
  Object.defineProperty(process, "platform", realPlatform);
  if (feedEnv === undefined) delete process.env.CCDECK_UPDATE_FEED;
  else process.env.CCDECK_UPDATE_FEED = feedEnv;
  vi.unstubAllGlobals();
  rmTempDir(dir);
});

/** An updater whose every state change is recorded, and a wait for one. */
function updater(app = appLike()) {
  const seen: State[] = [];
  const u = createUpdater({ app, onChange: (s: State) => seen.push(s) });
  const until = async (status: string) => {
    for (let i = 0; i < 200; i++) {
      if (u.state.status === status) return;
      await new Promise(r => setTimeout(r, 5));
    }
    throw new Error(`the updater never reached ${status}; it is ${JSON.stringify(u.state)}`);
  };
  return { u, seen, until };
}

/** electron-updater's `update-downloaded`, for a file written here. */
function downloaded(bytes: Buffer, ed25519: string | undefined) {
  const file = join(dir, "ccdeck-win-x64.exe");
  writeFileSync(file, bytes);
  return { version: "3.27.0", downloadedFile: file, files: [{ url: basename(file), sha512: "x", ...(ed25519 ? { ed25519 } : {}) }] };
}
const signed = (bytes: Buffer, keyPem = h.priv) => sign(null, bytes, keyPem).toString("base64");

describe("the Windows and Linux install gate", () => {
  beforeEach(() => onPlatform("linux"));

  it("holds the install until ccdeck's own check has passed", async () => {
    const { u } = updater();
    await u.check();
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
    // Anything but false here and electron-updater installs its download on the
    // next quit, whatever the signature says.
    expect(fake.autoInstallOnAppQuit).toBe(false);
  });

  it("allows the install once the download carries ccdeck's signature", async () => {
    const { u, until } = updater();
    await u.check();
    const bytes = Buffer.from("the installer ccdeck built");
    fake.emit("update-downloaded", downloaded(bytes, signed(bytes)));
    await until("ready");
    expect(u.state).toEqual({ status: "ready", version: "3.27.0" });
    expect(fake.autoInstallOnAppQuit).toBe(true);
    u.restartNow();
    expect(fake.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it.each([
    ["signed by another key", (b: Buffer) => signed(b, h.foreignPriv)],
    ["signed over other bytes", () => signed(Buffer.from("what ccdeck actually built"))],
    ["not signed at all", () => undefined],
  ])("refuses a download %s, and keeps refusing it at Restart", async (_what, signatureOf) => {
    const { u, until } = updater();
    await u.check();
    const bytes = Buffer.from("an installer from somewhere else");
    fake.emit("update-downloaded", downloaded(bytes, signatureOf(bytes)));
    await until("error");
    expect(u.state.error).toContain("not signed by ccdeck");
    expect(fake.autoInstallOnAppQuit).toBe(false);
    // quitAndInstall installs whatever was downloaded, so the menu offering
    // Restart only while ready must not be the only guard in front of it.
    u.restartNow();
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
  });

  it("does not look again while an update is on its way or ready", async () => {
    const { u, until } = updater();
    await u.check();
    fake.emit("update-available", { version: "3.27.0" });
    expect(u.state).toEqual({ status: "downloading", version: "3.27.0" });
    await u.check();
    const bytes = Buffer.from("the installer ccdeck built");
    fake.emit("update-downloaded", downloaded(bytes, signed(bytes)));
    await until("ready");
    await u.check();
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
  });
});

describe("a development run", () => {
  it.each(["linux", "darwin"])("looks for nothing on %s", async (platform) => {
    // Unpackaged, with no test feed named: there is nothing to update into, and
    // a dev build asking GitHub every six hours would be noise at best.
    onPlatform(platform);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { u, seen } = updater(appLike({ isPackaged: false }));
    expect(await u.check()).toEqual({ status: "idle" });
    expect(fake.checkForUpdates).not.toHaveBeenCalled();
    expect(mac.checkForUpdate).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });
});

describe("the macOS update", () => {
  beforeEach(() => onPlatform("darwin"));

  const update = { version: "3.27.0", file: { arch: "arm64", url: "ccdeck-mac-arm64.zip" }, url: `${FEED}/ccdeck-mac-arm64.zip` };
  const staged = { staged: "/tmp/ccdeck-update-x/app/ccdeck.app", dir: "/tmp/ccdeck-update-x" };

  it("stages the update, then hands it to the swap script exactly once, on quit", async () => {
    vi.mocked(mac.checkForUpdate).mockResolvedValue(update);
    vi.mocked(mac.stageUpdate).mockResolvedValue(staged);
    const { u, seen } = updater();
    await u.check();

    expect(seen.map(s => s.status)).toEqual(["checking", "downloading", "ready"]);
    expect(u.state).toEqual({ status: "ready", version: "3.27.0" });
    expect(vi.mocked(mac.checkForUpdate).mock.calls[0][0]).toMatchObject({ manifestUrl: `${FEED}/latest-mac.json`, currentVersion: "3.26.0" });
    // Check 4 compares against the bundle that is RUNNING, found from the
    // executable, and the swap replaces that same bundle.
    expect(vi.mocked(mac.stageUpdate)).toHaveBeenCalledWith(update, { runningApp: "/Applications/ccdeck.app" });

    u.installOnQuit();
    u.installOnQuit();
    expect(mac.installOnExit).toHaveBeenCalledTimes(1);
    expect(mac.installOnExit).toHaveBeenCalledWith({ pid: process.pid, target: "/Applications/ccdeck.app", ...staged });
  });

  it("reports a refused update as an error, and installs nothing on quit", async () => {
    vi.mocked(mac.checkForUpdate).mockResolvedValue(update);
    vi.mocked(mac.stageUpdate).mockRejectedValue(new Error("the download failed its hash or signature check"));
    const app = appLike();
    const { u } = updater(app);
    await u.check();
    expect(u.state).toEqual({ status: "error", error: "the download failed its hash or signature check" });
    u.installOnQuit();
    expect(mac.installOnExit).not.toHaveBeenCalled();
    // "Restart to update" with nothing to update to is not a Quit either.
    u.restartNow();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it("throws away a staged update the app quit without", async () => {
    vi.mocked(mac.checkForUpdate).mockResolvedValue(update);
    vi.mocked(mac.stageUpdate).mockResolvedValue(staged);
    const { u } = updater();
    await u.check();
    await u.dispose();
    expect(mac.discard).toHaveBeenCalledWith(staged.dir);
  });
});
