// createUpdater, the state machine the tray's update item reads (#1160, #1176).
//
// Both halves of the Windows/Linux signature check were tested — CI writes an
// `ed25519` into the yml, the app verifies one — and the gate that wires them
// together never ran. That gate is the whole of what stands between an
// electron-updater download and an install: electron-updater itself checks only
// a SHA-512 served from the same release as the file, so whoever can replace
// one can replace both. Initialise `autoInstallOnAppQuit` to true, or set it
// anywhere, and electron-updater's own quit hook installs whatever it
// downloaded on every Windows and Linux app, with the suite green; the app's
// own install on Quit, which only takes what is ready, is pinned in
// desktop-quit-install-1757.test.ts.
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
// @ts-expect-error — plain .mjs, no types
import * as relaunch from "../../../desktop/relaunch-linux.mjs";

type Fake = {
  on: (event: string, fn: (...args: unknown[]) => unknown) => void;
  emit: (event: string, ...args: unknown[]) => boolean;
  checkForUpdates: ReturnType<typeof vi.fn>;
  quitAndInstall: ReturnType<typeof vi.fn>;
  install: ReturnType<typeof vi.fn>;
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
// And again by the path updater.mjs reaches it at once desktop/ has been
// installed (#1293). A mock is keyed on what the specifier resolves to, and
// from this file "electron-updater" resolves to nothing — the root install does
// not have it — while from desktop/updater.mjs it resolves to the real package
// the moment `npm install` has run in desktop/. The two ids stopped matching,
// the real electron-updater loaded, reached for Electron's `app`, and six cases
// failed on exactly the machines that build the desktop app. Where desktop/ is
// not installed this path resolves to nothing either, and the line is inert.
vi.mock("../../../desktop/node_modules/electron-updater", () => {
  return { default: { get autoUpdater() { return h.auto; } } };
});

vi.mock("../../../desktop/updater-mac.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  UPDATE_PUBLIC_KEY: h.pub,
  checkForUpdate: vi.fn(),
  stageUpdate: vi.fn(),
  installOnExit: vi.fn(),
  discard: vi.fn(async () => {}),
  // The apps here are at paths that are not on this disk; one that cannot be
  // replaced is desktop-update-unreplaceable-app.test.ts's.
  canReplace: vi.fn(async () => true),
}));

vi.mock("../../../desktop/relaunch-linux.mjs", () => ({ relaunchOnExit: vi.fn() }));

async function newFake(): Promise<Fake> {
  const { EventEmitter } = await import("node:events");
  const fake = new EventEmitter() as unknown as Fake;
  fake.checkForUpdates = vi.fn(async () => {});
  fake.quitAndInstall = vi.fn();
  fake.install = vi.fn(() => true);
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
let appImageEnv: string | undefined;

beforeEach(async () => {
  fake = await newFake();
  h.auto = fake;
  dir = mkdtempSync(join(tmpdir(), "ccdeck-updater-state-"));
  feedEnv = process.env.CCDECK_UPDATE_FEED;
  delete process.env.CCDECK_UPDATE_FEED;
  // The runner is no AppImage; the cases that are one say so themselves.
  appImageEnv = process.env.APPIMAGE;
  delete process.env.APPIMAGE;
  vi.mocked(relaunch.relaunchOnExit).mockReset();
  vi.mocked(mac.checkForUpdate).mockReset();
  vi.mocked(mac.stageUpdate).mockReset();
  vi.mocked(mac.installOnExit).mockReset();
  vi.mocked(mac.discard).mockClear();
});

afterEach(() => {
  Object.defineProperty(process, "platform", realPlatform);
  if (feedEnv === undefined) delete process.env.CCDECK_UPDATE_FEED;
  else process.env.CCDECK_UPDATE_FEED = feedEnv;
  if (appImageEnv === undefined) delete process.env.APPIMAGE;
  else process.env.APPIMAGE = appImageEnv;
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

/** electron-updater's `update-downloaded`, for a file written here, offered
 *  as `version`, with whatever signatures the yml carried for it. */
function downloaded(bytes: Buffer, signatures: Signatures | undefined, version = "3.27.0") {
  const file = join(dir, "ccdeck-win-x64.exe");
  writeFileSync(file, bytes);
  return { version, downloadedFile: file, files: [{ url: basename(file), sha512: "x", ...(signatures ?? {}) }] };
}
type Signatures = { ed25519?: string; ed25519Release?: string };
/** Both signatures CI writes into the yml (sign-yml.mjs): over the bytes, and
 *  over the bytes, the name and the version they were released as. */
const signed = (bytes: Buffer, keyPem = h.priv, version = "3.27.0"): Signatures => ({
  ed25519: sign(null, bytes, keyPem).toString("base64"),
  ed25519Release: sign(null, mac.releaseMessage(version, "ccdeck-win-x64.exe", bytes), keyPem).toString("base64"),
});

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
    // Still false: the install on Quit is the app's own call, made only for
    // what is ready (#1757, desktop-quit-install-1757.test.ts).
    expect(fake.autoInstallOnAppQuit).toBe(false);
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
    process.env.APPIMAGE = "/home/u/Applications/ccdeck-linux-x86_64.AppImage";
    u.restartNow();
    u.installOnQuit();
    expect(fake.install).not.toHaveBeenCalled();
  });

  it("does not look again while an update is on its way, but does past one that is ready", async () => {
    const { u, until } = updater();
    await u.check();
    fake.emit("update-available", { version: "3.27.0" });
    expect(u.state).toEqual({ status: "downloading", version: "3.27.0" });
    await u.check();
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
    const bytes = Buffer.from("the installer ccdeck built");
    fake.emit("update-downloaded", downloaded(bytes, signed(bytes)));
    await until("ready");
    // Ready is no longer the end of looking: an update can wait a day for the
    // agents, and a release that came out in that day is the one to install.
    await u.check();
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(2);
  });
});

describe("looking past a ready update, on Windows and Linux", () => {
  beforeEach(() => onPlatform("linux"));

  const installer = Buffer.from("the installer ccdeck built");
  const newer = Buffer.from("the next installer ccdeck built");

  /** An updater with 3.27.0 downloaded, verified and ready. */
  async function ready() {
    const made = updater();
    await made.u.check();
    fake.emit("update-available", { version: "3.27.0" });
    fake.emit("update-downloaded", downloaded(installer, signed(installer)));
    await made.until("ready");
    return made;
  }

  it("keeps the ready update, and says nothing, when there is nothing newer", async () => {
    const { u, seen } = await ready();
    const said = seen.length;
    // What electron-updater does when the newest release is the one it already
    // has: it checks, offers it again, and finds it in its own cache.
    fake.checkForUpdates.mockImplementation(async () => {
      fake.emit("checking-for-update");
      fake.emit("update-available", { version: "3.27.0" });
      fake.emit("update-downloaded", downloaded(installer, signed(installer)));
    });
    await u.check();
    await new Promise(r => setTimeout(r, 20));
    expect(u.state).toEqual({ status: "ready", version: "3.27.0" });
    // Not one word: a tray flickering to "Checking…" every half hour, and the
    // window's Restart to update vanishing for it, is what this must not do.
    expect(seen.length).toBe(said);
    expect(u.looking).toBe(false);
  });

  it("downloads a newer release over the ready one, and installs that one", async () => {
    const { u, until } = await ready();
    fake.checkForUpdates.mockImplementation(async () => {
      fake.emit("checking-for-update");
      fake.emit("update-available", { version: "3.28.0" });
    });
    await u.check();
    expect(u.state).toEqual({ status: "downloading", version: "3.28.0" });
    // Still looking until the newer one has landed: the quiet install must not
    // take the overtaken one in the meantime.
    expect(u.looking).toBe(true);
    fake.emit("update-downloaded", downloaded(newer, signed(newer, h.priv, "3.28.0"), "3.28.0"));
    await until("ready");
    expect(u.state).toEqual({ status: "ready", version: "3.28.0" });
    expect(u.looking).toBe(false);
    u.restartNow();
    expect(fake.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("keeps the ready update when the feed cannot be reached", async () => {
    const { u, seen } = await ready();
    const said = seen.length;
    fake.checkForUpdates.mockImplementation(async () => {
      const err = new Error("net::ERR_INTERNET_DISCONNECTED");
      fake.emit("error", err);
      throw err;
    });
    await u.check();
    // Nothing newer started downloading, so electron-updater still has the
    // ready one; an error here would take away an update that is fine.
    expect(u.state).toEqual({ status: "ready", version: "3.27.0" });
    expect(seen.length).toBe(said);
  });

  it("reports the error when the newer download fails, because the older one is gone with it", async () => {
    const { u } = await ready();
    fake.checkForUpdates.mockImplementation(async () => {
      fake.emit("update-available", { version: "3.28.0" });
    });
    await u.check();
    // electron-updater clears its cache before it downloads a different
    // version, so there is no ready one to go back to.
    fake.emit("error", new Error("download 503"));
    expect(u.state).toEqual({ status: "error", error: "download 503" });
  });
});

describe("the AppImage restart (#1630)", () => {
  // quitAndInstall(…, true) started the new AppImage from inside this process
  // while it still ran, and the new app inherited this one's open files. The
  // AppImage now only swaps its file in, and a detached script starts it once
  // this process has gone (relaunch-linux.mjs, run for real in
  // desktop-appimage-relaunch-1630.test.ts).
  const APPIMAGE = "/home/u/Applications/ccdeck-linux-x86_64.AppImage";

  beforeEach(() => {
    onPlatform("linux");
    process.env.APPIMAGE = APPIMAGE;
  });

  async function ready(app = appLike()) {
    const { u, until } = updater(app);
    await u.check();
    const bytes = Buffer.from("the AppImage ccdeck built");
    fake.emit("update-downloaded", downloaded(bytes, signed(bytes)));
    await until("ready");
    return u;
  }

  it("swaps the file in without starting it, then quits into a relaunch", async () => {
    const order: string[] = [];
    fake.install.mockImplementation(() => { order.push("install"); return true; });
    vi.mocked(relaunch.relaunchOnExit).mockImplementation(() => { order.push("relaunch"); });
    const app = appLike({ quit: vi.fn(() => { order.push("quit"); }) });
    const u = await ready(app);

    u.restartNow();

    // install(…, false): electron-updater runs the new AppImage with
    // APPIMAGE_EXIT_AFTER_INSTALL, so its AppRun swaps and returns.
    expect(fake.install).toHaveBeenCalledWith(true, false);
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
    expect(relaunch.relaunchOnExit).toHaveBeenCalledWith({ pid: process.pid, appImage: APPIMAGE });
    expect(order).toEqual(["install", "relaunch", "quit"]);
  });

  it("relaunches the file electron-updater renamed", async () => {
    const renamed = "/home/u/Applications/ccdeck-3.29.5-x86_64.AppImage";
    fake.install.mockImplementation(() => { fake.emit("appimage-filename-updated", renamed); return true; });
    const u = await ready();
    u.restartNow();
    expect(relaunch.relaunchOnExit).toHaveBeenCalledWith({ pid: process.pid, appImage: renamed });
    // And stops listening: a later rename is not this restart's.
    expect((fake as unknown as { listenerCount: (e: string) => number }).listenerCount("appimage-filename-updated")).toBe(0);
  });

  it("neither relaunches nor quits when the install did not happen", async () => {
    fake.install.mockReturnValue(false);
    const app = appLike();
    const u = await ready(app);
    u.restartNow();
    expect(relaunch.relaunchOnExit).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
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
    // A plain Quit: the swap leaves the app closed (#1758).
    expect(mac.installOnExit).toHaveBeenCalledWith({ pid: process.pid, target: "/Applications/ccdeck.app", ...staged, relaunch: false, failed: join("/nowhere/userData", "update-swap-failed"), version: "3.27.0" });
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

  describe("looking past a ready update", () => {
    const newer = { version: "3.28.0", file: { arch: "arm64", url: "ccdeck-mac-arm64.zip" }, url: `${FEED}/ccdeck-mac-arm64.zip` };
    const newerStaged = { staged: "/tmp/ccdeck-update-y/app/ccdeck.app", dir: "/tmp/ccdeck-update-y" };

    /** An updater with 3.27.0 staged and ready. */
    async function ready() {
      vi.mocked(mac.checkForUpdate).mockResolvedValueOnce(update);
      vi.mocked(mac.stageUpdate).mockResolvedValueOnce(staged);
      const made = updater();
      await made.u.check();
      expect(made.u.state).toEqual({ status: "ready", version: "3.27.0" });
      return made;
    }

    it("asks for one newer than the READY version, and changes nothing when there is none", async () => {
      const { u, seen } = await ready();
      const said = seen.length;
      vi.mocked(mac.checkForUpdate).mockResolvedValueOnce(null);
      await u.check();
      // Against the running 3.26.0, the 3.27.0 already staged would come back
      // as "newer" every time and be downloaded again.
      expect(vi.mocked(mac.checkForUpdate).mock.calls[1][0]).toMatchObject({ currentVersion: "3.27.0" });
      expect(u.state).toEqual({ status: "ready", version: "3.27.0" });
      expect(seen.length).toBe(said);
      expect(mac.stageUpdate).toHaveBeenCalledTimes(1);
    });

    it("stages the newer one, and throws the overtaken one away only after", async () => {
      const { u, seen } = await ready();
      vi.mocked(mac.checkForUpdate).mockResolvedValueOnce(newer);
      vi.mocked(mac.stageUpdate).mockResolvedValueOnce(newerStaged);
      await u.check();
      expect(seen.slice(-2)).toEqual([{ status: "downloading", version: "3.28.0" }, { status: "ready", version: "3.28.0" }]);
      // Until its successor staged, the old bundle was the one a Quit would
      // install, so it could not go first.
      expect(mac.discard).toHaveBeenCalledWith(staged.dir);
      expect(vi.mocked(mac.discard).mock.invocationCallOrder[0])
        .toBeGreaterThan(vi.mocked(mac.stageUpdate).mock.invocationCallOrder[1]);
      u.installOnQuit();
      expect(mac.installOnExit).toHaveBeenCalledTimes(1);
      expect(mac.installOnExit).toHaveBeenCalledWith(expect.objectContaining({ ...newerStaged, version: "3.28.0" }));
    });

    it("keeps the ready one when the newer one is refused", async () => {
      const { u } = await ready();
      vi.mocked(mac.checkForUpdate).mockResolvedValueOnce(newer);
      vi.mocked(mac.stageUpdate).mockRejectedValueOnce(new Error("the download failed its hash or signature check"));
      await u.check();
      // A bad download of 3.28.0 says nothing against 3.27.0, which was
      // verified and is still on disk: going to error would throw away an
      // update that is fine for one that is not.
      expect(u.state).toEqual({ status: "ready", version: "3.27.0" });
      expect(mac.discard).not.toHaveBeenCalledWith(staged.dir);
      u.installOnQuit();
      expect(mac.installOnExit).toHaveBeenCalledWith(expect.objectContaining({ ...staged, version: "3.27.0" }));
    });

    it("keeps the ready one when the manifest cannot be read", async () => {
      const { u, seen } = await ready();
      const said = seen.length;
      vi.mocked(mac.checkForUpdate).mockRejectedValueOnce(new Error("manifest 503"));
      await u.check();
      expect(u.state).toEqual({ status: "ready", version: "3.27.0" });
      expect(seen.length).toBe(said);
    });

    it("says when it last looked, and that it is looking while the newer one stages", async () => {
      const { u } = await ready();
      const first = u.lookedAt;
      expect(typeof first).toBe("number");
      let land: (v: unknown) => void = () => {};
      vi.mocked(mac.checkForUpdate).mockResolvedValueOnce(newer);
      vi.mocked(mac.stageUpdate).mockReturnValueOnce(new Promise(r => { land = r; }) as never);
      await new Promise(r => setTimeout(r, 2));
      const before = Date.now();
      const looking = u.check();
      // Stamped as the look starts, not as it ends: the install's freshness is
      // measured from when the feed was asked.
      expect(u.lookedAt).toBeGreaterThanOrEqual(before);
      expect(u.looking).toBe(true);
      // A second check while this one is out starts nothing.
      await u.check();
      expect(mac.checkForUpdate).toHaveBeenCalledTimes(2);
      land(newerStaged);
      await looking;
      expect(u.looking).toBe(false);
      expect(u.state).toEqual({ status: "ready", version: "3.28.0" });
    });
  });
});
