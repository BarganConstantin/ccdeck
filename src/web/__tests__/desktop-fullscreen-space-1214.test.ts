// Opened from the menu bar while another app was full screen, the deck's
// window came up over that app and then stayed in front of it: clicking the
// full-screen browser gave the browser the keyboard and left ccdeck drawn over
// it (#1214). With no app full screen the same window stepped back as it
// should.
//
// A full-screen Space admits the windows of an agent app — ccdeck is one while
// it has no window, an accessory app — and has nothing behind its full-screen
// window for an admitted one to step back to. Opening there is wanted: the
// window comes up over the app the person is in. Staying there after they
// click that app is the bug, so the window closes instead, and the menu bar
// opens it again over whatever they are in then.
//
// Checked on a real Mac with Electron 42.11.6, against the window list macOS
// itself reports; the fixtures below are those lists.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { overFullScreen } from "../../../desktop/fullscreen-space.mjs";

const desktop = (file: string) => readFileSync(join(__dirname, "..", "..", "..", "desktop", file), "utf8");
const main = desktop("main.mjs");

const OURS = 4242;
const MAIN = { x: 0, y: 0, width: 2560, height: 1440 };
const SIDE = { x: 2560, y: 0, width: 1920, height: 1080 };
const at = (pid: number, x: number, y: number, width: number, height: number) => ({ pid, x, y, width, height });

/** The window list while ccdeck stands over a full-screen terminal on the
 *  main display, and the side display has a full-screen one of its own. */
const overTerminal = [
  at(OURS, 830, 440, 900, 560),
  at(498, 0, 0, 2560, 32),
  at(498, 0, 0, 2560, 1440),
  at(498, 2560, 0, 1920, 32),
  at(498, 2560, 0, 1920, 1080),
];

/** The same, with ccdeck on the main display's desktop behind a Finder window. */
const onDesktop = [
  at(612, 400, 300, 920, 436),
  at(OURS, 830, 440, 900, 560),
  at(498, 2560, 0, 1920, 32),
  at(498, 2560, 0, 1920, 1080),
];

describe("whether the window stands over another app's full-screen Space", () => {
  it("does over a full-screen app on its own display", () => {
    expect(overFullScreen(overTerminal, OURS, MAIN)).toBe(true);
  });

  it("does not on a desktop, where it steps back behind the app clicked like any window", () => {
    expect(overFullScreen(onDesktop, OURS, MAIN)).toBe(false);
  });

  it("does not for another display's full-screen app", () => {
    expect(overFullScreen(onDesktop, OURS, MAIN)).toBe(false);
    expect(overFullScreen(overTerminal.filter(w => !(w.x === 0 && w.height === 1440)), OURS, MAIN)).toBe(false);
  });

  it("does not when the window is not on screen at all — the person went to another Space", () => {
    expect(overFullScreen(overTerminal.filter(w => w.pid !== OURS), OURS, MAIN)).toBe(false);
  });

  it("does not count its own window, which fills the display when ccdeck itself is full screen", () => {
    expect(overFullScreen([at(OURS, 0, 0, 2560, 1440)], OURS, MAIN)).toBe(false);
  });

  it("does not when macOS gave no list", () => {
    expect(overFullScreen([], OURS, MAIN)).toBe(false);
    expect(overFullScreen([], OURS, SIDE)).toBe(false);
  });
});

describe("the window a person opens from the menu bar", () => {
  /** The body of openWindow, up to the function after it. */
  function openWindowBody(): string {
    const at = main.search(/function openWindow\(/);
    expect(at).toBeGreaterThan(-1);
    return main.slice(at, main.indexOf("\n}\n", at));
  }

  it("is built before the app turns regular, so it can open over a full-screen app", () => {
    const body = openWindowBody();
    expect(body.indexOf("new BrowserWindow(")).toBeLessThan(body.indexOf("setRegular(true);"));
  });

  it("closes when another app takes the keyboard while it stands over that app's full screen", () => {
    expect(main).toMatch(/app\.on\("did-resign-active", \(\) => \{ stepAsideFromFullScreen\(\); \}\);/);
    const at = main.indexOf("async function stepAsideFromFullScreen() {");
    expect(at).toBeGreaterThan(-1);
    const body = main.slice(at, main.indexOf("\n}\n", at));
    // Only on a Mac, only once the app has really let go, never with a sheet
    // up — a question closed with its window is a question nobody answered.
    expect(body).toMatch(/process\.platform !== "darwin"/);
    expect(body).toMatch(/\.isFocused\(\)/);
    expect(body).toMatch(/updateNoticePrompting/);
    expect(body).toMatch(/asking/);
    expect(body.indexOf("overFullScreen(")).toBeGreaterThan(-1);
    expect(body.indexOf("overFullScreen(")).toBeLessThan(body.indexOf(".close()"));
  });

  it("ships the module that tells, inside the app", () => {
    expect(desktop("electron-builder.config.cjs")).toContain('"fullscreen-space.mjs"');
  });
});
