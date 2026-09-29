// macOS: Quit with an update staged installs it and leaves ccdeck closed (#1758).
//
// Every will-quit handed the staged bundle to the swap script, and the script
// always ended by opening the new app. "Restart to update" on macOS is only a
// quit, so the script could not tell a restart from the person closing the
// app, and a plain Quit brought ccdeck back by itself a moment later. The
// updater now says which it was, and the script opens the app only for a
// restart. The script itself is run in desktop-updater.test.ts ("the swap
// script, run").
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const staged = { staged: "/tmp/ccdeck-update-x/app/ccdeck.app", dir: "/tmp/ccdeck-update-x" };
let feedEnv: string | undefined;

beforeEach(() => {
  Object.defineProperty(process, "platform", { ...realPlatform, value: "darwin" });
  feedEnv = process.env.CCDECK_UPDATE_FEED;
  delete process.env.CCDECK_UPDATE_FEED;
  vi.mocked(mac.checkForUpdate).mockReset().mockResolvedValue({ version: "3.27.0", file: { arch: "arm64", url: "ccdeck-mac-arm64.zip" }, url: "https://x/ccdeck-mac-arm64.zip" });
  vi.mocked(mac.stageUpdate).mockReset().mockResolvedValue(staged);
  vi.mocked(mac.installOnExit).mockReset();
});

afterEach(() => {
  Object.defineProperty(process, "platform", realPlatform);
  if (feedEnv === undefined) delete process.env.CCDECK_UPDATE_FEED;
  else process.env.CCDECK_UPDATE_FEED = feedEnv;
});

async function staging() {
  const app = {
    isPackaged: true,
    getVersion: () => "3.26.0",
    getPath: () => "/Applications/ccdeck.app/Contents/MacOS/ccdeck",
    quit: vi.fn(),
  };
  const u = createUpdater({ app, onChange: () => {} });
  await u.check();
  expect(u.state).toEqual({ status: "ready", version: "3.27.0" });
  return { u, app };
}

describe("the staged macOS update at quit", () => {
  it("installs on a plain Quit and does not open the app again", async () => {
    const { u } = await staging();
    u.installOnQuit();
    expect(mac.installOnExit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mac.installOnExit).mock.calls[0][0]).toMatchObject({ target: "/Applications/ccdeck.app", ...staged, relaunch: false });
  });

  it("opens the new version after Restart to update, the quiet install included", async () => {
    // The quiet install (#1187) and a deck restart that takes the update both
    // go through restartNow, so both are restarts.
    const { u, app } = await staging();
    u.restartNow();
    expect(app.quit).toHaveBeenCalledTimes(1);
    u.installOnQuit();
    expect(vi.mocked(mac.installOnExit).mock.calls[0][0]).toMatchObject({ relaunch: true });
  });
});
