// Windows and Linux: a background download that fails is an update error, and
// nothing more.
//
// With autoDownload on, electron-updater's checkForUpdates resolves as soon as
// it knows of an update and hands back the download as a promise of its own,
// which rejects when the download fails — after the 'error' event the updater
// already turns into its error state. Nobody held that promise, so a dropped
// network or a 5xx from GitHub mid-download was an unhandled rejection in the
// main process, which Electron answers with a modal "A JavaScript error
// occurred in the main process" box.
//
// electron-updater is mocked the way desktop-updater-state.test.ts does it:
// an EventEmitter shaped like AppUpdater's check and download.
import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
// @ts-expect-error — plain .mjs, no types
import { createUpdater } from "../../../desktop/updater.mjs";

const h = vi.hoisted(() => ({ auto: null as unknown }));
// Both specifiers, for the reason desktop-updater-state.test.ts gives (#1293).
vi.mock("electron-updater", () => ({ default: { get autoUpdater() { return h.auto; } } }));
vi.mock("../../../desktop/node_modules/electron-updater", () => ({ default: { get autoUpdater() { return h.auto; } } }));
vi.mock("../../../desktop/relaunch-linux.mjs", () => ({ relaunchOnExit: vi.fn() }));

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

afterEach(() => { Object.defineProperty(process, "platform", realPlatform); });

describe.each(["linux", "win32"])("a background download that fails on %s", (platform) => {
  it("leaves the updater in its error state, with no rejection left unhandled", async () => {
    Object.defineProperty(process, "platform", { ...realPlatform, value: platform });
    const fake = new EventEmitter() as EventEmitter & Record<string, unknown>;
    fake.setFeedURL = vi.fn();
    // AppUpdater.checkForUpdates with autoDownload: the download is started
    // and handed back, and its failure is dispatched as 'error' and rethrown.
    fake.checkForUpdates = vi.fn(async () => {
      fake.emit("update-available", { version: "3.27.0" });
      const downloadPromise = sleep(5)
        .then(() => { throw new Error("net::ERR_NETWORK_CHANGED"); })
        .catch(err => { fake.emit("error", err); throw err; });
      return { isUpdateAvailable: true, downloadPromise };
    });
    h.auto = fake;

    // The runner's own listener stands aside while this case counts.
    const unhandled: unknown[] = [];
    const count = (reason: unknown) => { unhandled.push(reason); };
    const runners = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    process.on("unhandledRejection", count);
    try {
      const u = createUpdater({ app: { isPackaged: true, getVersion: () => "3.26.0", getPath: () => "/nowhere", quit: vi.fn() }, onChange: () => {}, feed: "http://127.0.0.1:9/feed" });
      await u.check();
      expect(u.state).toEqual({ status: "downloading", version: "3.27.0" });
      for (let i = 0; i < 40 && u.state.status !== "error"; i++) await sleep(5);
      await sleep(30);
      expect(u.state).toEqual({ status: "error", error: "net::ERR_NETWORK_CHANGED" });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", count);
      for (const l of runners) process.on("unhandledRejection", l as (...a: unknown[]) => void);
    }
  });
});
