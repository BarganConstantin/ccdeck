// macOS: an app that cannot replace its own bundle never quits for an update.
//
// The swap script moves the installed bundle aside before copying the new one
// in, and gave up when that move failed — before the line that opens the app
// again. Nothing ahead of it asked whether the move could work. So a copy run
// from its disk image, a translocated one, or one in an /Applications a
// standard account cannot write to staged every release, the quiet install
// quit into the swap a minute later, and ccdeck was gone from the menu bar
// until somebody opened it, which started the same thing again. A swap that
// failed further on, with the old app put back, came back and retried the
// same release every couple of minutes.
//
// Now an app that cannot be replaced where it is stages nothing, and a release
// the swap could not put in place is not staged again. What the swap script
// itself does when it fails — open the version that was running, throw the
// download away, write the release down — is run in desktop-updater.test.ts
// ("the swap script, run").
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain .mjs, no types
import { createUpdater } from "../../../desktop/updater.mjs";
// @ts-expect-error — plain .mjs, no types
import * as mac from "../../../desktop/updater-mac.mjs";

vi.mock("../../../desktop/updater-mac.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkForUpdate: vi.fn(),
  stageUpdate: vi.fn(),
  installOnExit: vi.fn(),
  discard: vi.fn(async () => {}),
}));
vi.mock("../../../desktop/relaunch-linux.mjs", () => ({ relaunchOnExit: vi.fn() }));

// The same probe desktop-updater.test.ts makes: chmod 0555 stops a write into
// a directory on macOS and Linux for anyone but root, and on Windows nothing.
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

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const update = (version = "3.27.0") => ({ version, file: { arch: "arm64", url: "ccdeck-mac-arm64.zip" }, url: "https://x/ccdeck-mac-arm64.zip" });
const staged = { staged: "/tmp/ccdeck-update-x/app/ccdeck.app", dir: "/tmp/ccdeck-update-x" };

let root = "";
let feedEnv: string | undefined;

beforeEach(() => {
  Object.defineProperty(process, "platform", { ...realPlatform, value: "darwin" });
  feedEnv = process.env.CCDECK_UPDATE_FEED;
  delete process.env.CCDECK_UPDATE_FEED;
  root = mkdtempSync(join(tmpdir(), "ccdeck-unreplaceable-"));
  vi.mocked(mac.checkForUpdate).mockReset().mockResolvedValue(update());
  vi.mocked(mac.stageUpdate).mockReset().mockResolvedValue(staged);
  vi.mocked(mac.installOnExit).mockReset();
});

afterEach(() => {
  Object.defineProperty(process, "platform", realPlatform);
  if (feedEnv === undefined) delete process.env.CCDECK_UPDATE_FEED;
  else process.env.CCDECK_UPDATE_FEED = feedEnv;
  rmTempDir(root);
});

/** A packaged ccdeck.app in `folder`, and the app object the updater reads
 *  it through. */
function installedIn(folder: string) {
  const bundle = join(root, folder, "ccdeck.app");
  const exe = join(bundle, "Contents", "MacOS", "ccdeck");
  mkdirSync(dirname(exe), { recursive: true });
  mkdirSync(join(root, "userData"), { recursive: true });
  const app = {
    isPackaged: true,
    getVersion: () => "3.26.0",
    getPath: (name: string) => (name === "exe" ? exe : join(root, name)),
    quit: vi.fn(),
  };
  return { bundle, app };
}

describe("an app that cannot be replaced where it is", () => {
  it.skipIf(!readOnlyDirBlocksWrites)("stages nothing, says why, and does not quit for it", async () => {
    // A disk image's mount, a translocated copy, or a standard account's
    // /Applications: a folder the app cannot move itself out of.
    const { app } = installedIn("Volumes/ccdeck");
    chmodSync(join(root, "Volumes", "ccdeck"), 0o555);
    try {
      const u = createUpdater({ app, onChange: () => {} });
      await u.check();
      expect(u.state.status).toBe("error");
      expect(u.state.error).toMatch(/cannot update itself/);
      expect(mac.stageUpdate).not.toHaveBeenCalled();
      // The quiet install and the tray row both come here.
      u.restartNow();
      expect(app.quit).not.toHaveBeenCalled();
      u.installOnQuit();
      expect(mac.installOnExit).not.toHaveBeenCalled();
    } finally {
      chmodSync(join(root, "Volumes", "ccdeck"), 0o755);
    }
  });

  it("stages the update for an app in a folder it can write to", async () => {
    const { app, bundle } = installedIn("Applications");
    const u = createUpdater({ app, onChange: () => {} });
    await u.check();
    expect(u.state).toEqual({ status: "ready", version: "3.27.0" });
    expect(mac.stageUpdate).toHaveBeenCalledWith(update(), { runningApp: bundle });
  });
});

describe("a release the swap could not put in place", () => {
  it("is not staged again, and the next release is", async () => {
    // A ditto that ran out of disk: the old app went back and opened again.
    // The swap script writes the release down where the updater told it to.
    const { app } = installedIn("Applications");
    const first = createUpdater({ app, onChange: () => {} });
    await first.check();
    first.restartNow();
    first.installOnQuit();
    const asked = vi.mocked(mac.installOnExit).mock.calls[0][0];
    expect(asked).toMatchObject({ relaunch: true });
    if (asked.failed) writeFileSync(asked.failed, `${asked.version}\n`);

    vi.mocked(mac.stageUpdate).mockClear();
    const again = createUpdater({ app, onChange: () => {} });
    await again.check();
    expect(again.state.status).toBe("error");
    expect(mac.stageUpdate).not.toHaveBeenCalled();
    again.restartNow();
    expect(app.quit).toHaveBeenCalledTimes(1);

    vi.mocked(mac.checkForUpdate).mockResolvedValue(update("3.27.1"));
    const next = createUpdater({ app, onChange: () => {} });
    await next.check();
    expect(next.state).toEqual({ status: "ready", version: "3.27.1" });
  });
});
