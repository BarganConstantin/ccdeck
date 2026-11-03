// The desktop window forgot how it was (#2466). Reported from 3.51.0 on
// Windows: "if it's fullscreen and I close it (gets minimized to tray) then I
// open it opens as windowed."
//
// Closing the window closes it; the tray builds a new one. That one was
// 1440×900 in the middle of the main display every time. Now the window's
// size, place, maximized and full screen are kept in desktop-state.json as it
// closes (desktop/window-place.mjs), and the next one opens the same way.
//
// The first blocks run window-place.mjs; the last runs main.mjs's own
// openWindow and keepWindowPlace against a stand-in window, the way
// desktop-window-chrome.test.ts does, since main.mjs imports electron.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { WINDOW_MIN, WINDOW_SIZE, windowPlaceToKeep, windowPlaceToOpen } from "../../../desktop/window-place.mjs";
import { createDesktopState } from "../../../desktop/desktop-state.mjs";
import { windowChrome } from "../../../desktop/window-chrome.mjs";
import { rmTempDir } from "./rm-temp-dir";

/** A 1920×1080 main display with a 48 px taskbar, and a 2560×1440 one to its right. */
const MAIN = { x: 0, y: 0, width: 1920, height: 1032 };
const SIDE = { x: 1920, y: 0, width: 2560, height: 1440 };

describe("what is kept as the window closes", () => {
  it("keeps the size and place it has out of maximized and full screen, and whether it was either", () => {
    expect(windowPlaceToKeep({ normal: { x: 100, y: 80, width: 1200, height: 800 }, maximized: true, fullScreen: false }))
      .toEqual({ x: 100, y: 80, width: 1200, height: 800, maximized: true, fullScreen: false });
    expect(windowPlaceToKeep({ normal: { x: 100, y: 80, width: 1200, height: 800 }, maximized: false, fullScreen: true }))
      .toEqual({ x: 100, y: 80, width: 1200, height: 800, maximized: false, fullScreen: true });
  });

  it("keeps nothing for bounds that are not a window's", () => {
    expect(windowPlaceToKeep({ normal: { x: 0, y: 0, width: 0, height: 900 }, maximized: false, fullScreen: false })).toBeNull();
    expect(windowPlaceToKeep({ normal: { x: NaN, y: 0, width: 1440, height: 900 }, maximized: false, fullScreen: false })).toBeNull();
    expect(windowPlaceToKeep({ normal: null as never, maximized: false, fullScreen: false })).toBeNull();
  });
});

describe("where the window opens", () => {
  it("opens the way it always did when nothing was kept, or the file holds something else", () => {
    for (const saved of [undefined, null, "big", 7, [], {}]) {
      expect(windowPlaceToOpen(saved, [MAIN])).toEqual({ bounds: { ...WINDOW_SIZE }, maximized: false, fullScreen: false });
    }
  });

  it("opens where it closed, at the size it had", () => {
    expect(windowPlaceToOpen({ x: 200, y: 100, width: 1280, height: 760, maximized: false, fullScreen: false }, [MAIN, SIDE]))
      .toEqual({ bounds: { x: 200, y: 100, width: 1280, height: 760 }, maximized: false, fullScreen: false });
  });

  it("opens maximized or full screen again — the report's case", () => {
    expect(windowPlaceToOpen({ x: 200, y: 100, width: 1280, height: 760, maximized: false, fullScreen: true }, [MAIN]).fullScreen).toBe(true);
    expect(windowPlaceToOpen({ x: 200, y: 100, width: 1280, height: 760, maximized: true, fullScreen: false }, [MAIN]).maximized).toBe(true);
  });

  it("opens on the other monitor when that is where it was", () => {
    const place = windowPlaceToOpen({ x: 2400, y: 200, width: 1600, height: 1000, maximized: true, fullScreen: false }, [MAIN, SIDE]);
    expect(place.bounds).toEqual({ x: 2400, y: 200, width: 1600, height: 1000 });
    expect(place.maximized).toBe(true);
  });

  it("opens centred at the usual size when its monitor is gone, still maximized if it was", () => {
    expect(windowPlaceToOpen({ x: 2400, y: 200, width: 1600, height: 1000, maximized: true, fullScreen: false }, [MAIN]))
      .toEqual({ bounds: { ...WINDOW_SIZE }, maximized: true, fullScreen: false });
  });

  it("moves a window partly off its display back inside it, onto the display it was mostly on", () => {
    // Mostly on the main display, its top above it and its right side running
    // onto the side display: drawn wholly on the main one.
    expect(windowPlaceToOpen({ x: 1000, y: -40, width: 1200, height: 800 }, [MAIN, SIDE]).bounds)
      .toEqual({ x: 720, y: 0, width: 1200, height: 800 });
    // Mostly on the side display, hanging off its bottom.
    expect(windowPlaceToOpen({ x: 3000, y: 1000, width: 1200, height: 800 }, [MAIN, SIDE]).bounds)
      .toEqual({ x: 3000, y: 640, width: 1200, height: 800 });
  });

  it("shrinks a window larger than its display to fit, and never below the smallest the deck allows", () => {
    expect(windowPlaceToOpen({ x: 0, y: 0, width: 2560, height: 1440 }, [MAIN]).bounds)
      .toEqual({ x: 0, y: 0, width: 1920, height: 1032 });
    expect(windowPlaceToOpen({ x: 10, y: 10, width: 300, height: 200 }, [MAIN]).bounds)
      .toEqual({ x: 10, y: 10, width: WINDOW_MIN.width, height: WINDOW_MIN.height });
  });
});

describe("main.mjs, from closing the window to opening it again", () => {
  let dir = "";
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ccdeck-window-place-")); });
  afterEach(() => { rmTempDir(dir); });

  const main = readFileSync(join(__dirname, "../../../desktop/main.mjs"), "utf8");
  const fn = (name: string) => {
    const start = main.indexOf(`function ${name}(`);
    expect(start, `${name} is gone or renamed`).toBeGreaterThan(-1);
    return main.slice(start, main.indexOf("\n}\n", start) + 2);
  };

  /** A window that does what Electron's does with the calls openWindow makes. */
  class FakeWindow extends EventEmitter {
    static made: FakeWindow[] = [];
    calls: string[] = [];
    destroyed = false;
    maximized = false;
    fullScreen = false;
    normal: { x: number, y: number, width: number, height: number };
    webContents = Object.assign(new EventEmitter(), {
      isLoading: () => false,
      executeJavaScript: async () => true,
      setWindowOpenHandler: () => {},
      getUserAgent: () => "test",
      setUserAgent: () => {},
    });
    constructor(public options: Record<string, any>) {
      super();
      this.normal = { x: options.x ?? 240, y: options.y ?? 66, width: options.width, height: options.height };
      FakeWindow.made.push(this);
    }
    isDestroyed() { return this.destroyed; }
    setMenuBarVisibility() {}
    loadURL() {}
    maximize() { this.calls.push("maximize"); this.maximized = true; }
    show() { this.calls.push("show"); }
    setFullScreen(on: boolean) { this.calls.push(`setFullScreen(${on})`); this.fullScreen = on; }
    getNormalBounds() { return { ...this.normal }; }
    isMaximized() { return this.maximized; }
    isFullScreen() { return this.fullScreen; }
    close() { this.emit("close"); this.destroyed = true; this.emit("closed"); }
  }

  function app(platform = "win32") {
    FakeWindow.made = [];
    const desktopState = createDesktopState(() => join(dir, "desktop-state.json"));
    const context: Record<string, any> = {
      win: null, windowOrigin: null, deck: { port: 4317 },
      BrowserWindow: FakeWindow, windowChrome, join, here: "/desktop",
      process: { platform }, app: { getVersion: () => "test", focus: () => {} },
      deckOrigin: (port: number) => `http://127.0.0.1:${port}`,
      setRegular: () => {}, trace: () => {}, offerReadyUpdate: () => {},
      desktopState, screen: { getAllDisplays: () => [{ workArea: MAIN }, { workArea: SIDE }] },
      windowPlaceToOpen, windowPlaceToKeep, WINDOW_MIN,
    };
    runInNewContext(`${fn("openWindow")}\n${fn("keepWindowPlace")}\nthis.openWindow = openWindow;`, context);
    const open = async (steal = true) => {
      context.openWindow(steal);
      const made = FakeWindow.made.at(-1)!;
      await made.listeners("ready-to-show")[0]();
      return made;
    };
    return { open, desktopState, context };
  }

  it("opens full screen again after a full-screen window was closed to the tray", async () => {
    const { open, desktopState } = app();
    const first = await open();
    expect(first.options).toMatchObject({ width: 1440, height: 900 });
    expect(first.options.x).toBeUndefined();
    first.normal = { x: 300, y: 120, width: 1300, height: 820 };
    first.fullScreen = true;
    first.close();
    expect(desktopState.read().window).toEqual({ x: 300, y: 120, width: 1300, height: 820, maximized: false, fullScreen: true });

    const second = await open();
    expect(second.options).toMatchObject({ x: 300, y: 120, width: 1300, height: 820, minWidth: 720, minHeight: 480 });
    expect(second.calls).toEqual(["show", "setFullScreen(true)"]);
  });

  it("opens maximized again, sized by maximize() before it shows rather than after", async () => {
    const { open } = app();
    const first = await open();
    first.maximized = true;
    first.close();
    const second = await open();
    expect(second.calls).toEqual(["maximize", "show"]);
    // Out of maximized it goes back to the size it had before.
    expect(second.options).toMatchObject({ width: 1440, height: 900 });
  });

  it("keeps the other keys desktop-state.json holds", async () => {
    const { open, desktopState } = app();
    desktopState.merge({ firstRunAsked: true });
    (await open()).close();
    expect(desktopState.read().firstRunAsked).toBe(true);
    expect(desktopState.read().window).toMatchObject({ width: 1440, height: 900 });
  });

  it("does not take a macOS person into a full-screen Space nobody opened the window for", async () => {
    const first = await app("darwin").open();
    first.fullScreen = true;
    first.close();
    // The app started again after a quiet auto-update, or at login, opens its
    // window with nobody having asked (openWindow's own `steal`, #1214).
    expect((await app("darwin").open(false)).calls).toEqual(["show"]);
    // Started again and opened from the menu bar or the Dock: the person asked.
    expect((await app("darwin").open(true)).calls).toEqual(["show", "setFullScreen(true)"]);
    // Elsewhere full screen is a window over the screen, and comes back either way.
    expect((await app("win32").open(false)).calls).toEqual(["show", "setFullScreen(true)"]);
  });

  it("does not keep the window closed before it was shown, for an older deck's page", async () => {
    const { desktopState, context } = app();
    desktopState.merge({ window: { x: 300, y: 120, width: 1300, height: 820, maximized: true, fullScreen: false } });
    context.openWindow(true);
    const old = FakeWindow.made[0];
    old.webContents.executeJavaScript = async () => false;
    await old.listeners("ready-to-show")[0]();
    expect(old.destroyed).toBe(true);
    expect(desktopState.read().window).toEqual({ x: 300, y: 120, width: 1300, height: 820, maximized: true, fullScreen: false });
    // And the native-chrome window that replaces it opens the kept way.
    const native = FakeWindow.made[1];
    expect(native.options).toMatchObject({ x: 300, y: 120, width: 1300, height: 820 });
  });
});
