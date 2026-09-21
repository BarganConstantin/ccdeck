// The server's half of the macOS menu-bar icon (#1160): finding the app,
// starting it, and raising notifications through it.
//
// Most of what is pinned here is the deck stepping ASIDE. The app ships only
// in tarballs built on a Mac, so a checkout, a Linux-packed tarball or an older
// install has none — and each of those must behave exactly as the deck did
// before the app existed: no launch attempt, and osascript for notifications.
// The one place it must NOT step aside is a refusal: a person who said no to
// ccdeck's notifications is not rerouted through Script Editor.
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { launchMenuBar, menuBarApp, notifyViaMenuBar, OFF_ENV } from "../../server/menubar.mjs";
// @ts-expect-error — plain .mjs server module, no types
const { notify } = await import("../../server/browser-react.mjs");

const ROOT = "/pkg";
const APP = join(ROOT, "dist", "native", "macos", "ccdeck.app");
const BIN = join(APP, "Contents", "MacOS", "ccdeck");
const HERE = { platform: "darwin", env: {}, root: ROOT, exists: (p: string) => p === BIN };

function spy(ok = true) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  return {
    calls,
    exec: (cmd: string, args: string[]) => { calls.push({ cmd, args }); return Promise.resolve({ ok }); },
  };
}

describe("finding the app", () => {
  it("finds it where build.sh puts it", () => {
    expect(menuBarApp(HERE)).toEqual({ app: APP, bin: BIN });
  });

  it("has none off macOS", () => {
    expect(menuBarApp({ ...HERE, platform: "linux" })).toBeNull();
    expect(menuBarApp({ ...HERE, platform: "win32" })).toBeNull();
  });

  it("has none when this install was not built with it", () => {
    expect(menuBarApp({ ...HERE, exists: () => false })).toBeNull();
  });

  it("checks the executable, not the bundle directory", () => {
    // A half-copied bundle has the directory and no binary, and LaunchServices
    // answers that with a dialog about a damaged app.
    expect(menuBarApp({ ...HERE, exists: (p: string) => p === APP })).toBeNull();
  });

  it("has none when the machine said no", () => {
    expect(menuBarApp({ ...HERE, env: { [OFF_ENV]: "1" } })).toBeNull();
  });

  it("is switched off for this suite, so no test puts an icon in anybody's bar", () => {
    expect(process.env[OFF_ENV]).toBe("1");
  });
});

describe("starting it", () => {
  it("goes through LaunchServices, in the background", () => {
    // `open`, so a second launch reaches the running instance; `-g`, so a deck
    // starting at login does not take the keyboard.
    const s = spy();
    return launchMenuBar({ ...HERE, exec: s.exec }).then(did => {
      expect(did).toBe("launched");
      expect(s.calls).toEqual([{ cmd: "open", args: ["-g", APP] }]);
    });
  });

  it("does nothing at all where there is no app", async () => {
    const s = spy();
    expect(await launchMenuBar({ ...HERE, platform: "linux", exec: s.exec })).toBe("absent");
    expect(s.calls).toEqual([]);
  });

  it("says so when the launch fails", async () => {
    expect(await launchMenuBar({ ...HERE, exec: spy(false).exec })).toBe("failed");
  });
});

describe("notifying through it", () => {
  it("hands the app the title and the body by position", async () => {
    const s = spy();
    expect(await notifyViaMenuBar("-e vcrm-core — ccdeck", "body", { ...HERE, exec: s.exec })).toBe(true);
    expect(s.calls).toEqual([{ cmd: BIN, args: ["--notify", "-e vcrm-core — ccdeck", "body"] }]);
  });

  it("answers null when there is no app, so the caller keeps its old path", async () => {
    expect(await notifyViaMenuBar("t", "b", { ...HERE, exists: () => false, exec: spy().exec })).toBeNull();
  });

  it("uses the app instead of osascript on macOS", async () => {
    const s = spy();
    expect(await notify("t", "b", "darwin", { run: s.exec, env: {}, root: ROOT, exists: HERE.exists })).toBe(true);
    expect(s.calls.map(c => c.cmd)).toEqual([BIN]);
  });

  it("does not route a refusal round the person through Script Editor", async () => {
    const s = spy(false);
    expect(await notify("t", "b", "darwin", { run: s.exec, env: {}, root: ROOT, exists: HERE.exists })).toBe(false);
    expect(s.calls.map(c => c.cmd)).toEqual([BIN]);
  });

  it("falls back to osascript when this install has no app", async () => {
    const s = spy();
    await notify("t", "b", "darwin", { run: s.exec, env: {}, root: ROOT, exists: () => false });
    expect(s.calls.map(c => c.cmd)).toEqual(["osascript"]);
  });
});
