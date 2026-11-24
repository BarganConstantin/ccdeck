// The desktop window forgot how it was (#2466). Reported from 3.51.0 on
// Windows: "if it's fullscreen and I close it (gets minimized to tray) then I
// open it opens as windowed."
//
// Closing the window closes it; the tray builds a new one. That one was
// 1440×900 in the middle of the main display every time. Now the window's
// size, place, maximized and full screen are kept in desktop-state.json as it
// closes (desktop/window-place.mjs), and the next one opens the same way.
//
// Then reported from 4.3.6 on a Mac with two monitors: after an automatic
// update restarted the app, the window came back on the main display, though
// it had been on the other one. The restart is not what lost it — every way
// the app ends closes the window first, and the place is kept then. What is
// kept was wrong: on macOS Electron's getNormalBounds of a zoomed or
// full-screen window is the frame Electron itself last gave it, and neither
// the person dragging the window to another monitor nor the green button
// changes that. A window opened on the main display, dragged to the other one
// and put full screen there was kept on the main display. Now a maximized or
// full-screen window's size is kept on the display the window is on.
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
import { placeText, WINDOW_MIN, WINDOW_SIZE, windowPlaceToKeep, windowPlaceToOpen } from "../../../desktop/window-place.mjs";
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

describe("the display a maximized or full-screen window is kept on", () => {
  /** Where Electron's macOS getNormalBounds still puts a window that was
   *  opened centred on the main display, whatever the person did since. */
  const OPENED = { x: 240, y: 66, width: 1440, height: 900 };
  /** The whole side display, as a full-screen window's frame covers it. */
  const SIDE_SCREEN = { x: 1920, y: 0, width: 2560, height: 1440 };

  it("keeps the normal size on the display the window is on, when Electron's normal bounds are on another — the report's case", () => {
    // Dragged to the side display and put full screen there with the green button.
    expect(windowPlaceToKeep({ normal: OPENED, bounds: SIDE_SCREEN, maximized: false, fullScreen: true }, [MAIN, SIDE]))
      .toEqual({ x: 2480, y: 270, width: 1440, height: 900, maximized: false, fullScreen: true });
    // Or zoomed there: its frame is the side display's work area.
    expect(windowPlaceToKeep({ normal: OPENED, bounds: SIDE, maximized: true, fullScreen: false }, [MAIN, SIDE]))
      .toEqual({ x: 2480, y: 270, width: 1440, height: 900, maximized: true, fullScreen: false });
  });

  it("opens on that display again, maximized or full screen as it was", () => {
    const kept = windowPlaceToKeep({ normal: OPENED, bounds: SIDE_SCREEN, maximized: false, fullScreen: true }, [MAIN, SIDE]);
    expect(windowPlaceToOpen(kept, [MAIN, SIDE]))
      .toEqual({ bounds: { x: 2480, y: 270, width: 1440, height: 900 }, maximized: false, fullScreen: true });
  });

  it("leaves normal bounds that are on the display the window is on as they are", () => {
    const normal = { x: 2100, y: 150, width: 1300, height: 800 };
    expect(windowPlaceToKeep({ normal, bounds: SIDE, maximized: true, fullScreen: false }, [MAIN, SIDE]))
      .toEqual({ ...normal, maximized: true, fullScreen: false });
    // Windows draws a maximized window's border 8 px past its display on every side.
    expect(windowPlaceToKeep({ normal, bounds: { x: 1912, y: -8, width: 2576, height: 1456 }, maximized: true, fullScreen: false }, [MAIN, SIDE]))
      .toEqual({ ...normal, maximized: true, fullScreen: false });
  });

  it("trusts the normal bounds of a window that is neither maximized nor full screen", () => {
    // Its normal bounds are its frame everywhere; nothing here second-guesses them.
    expect(windowPlaceToKeep({ normal: OPENED, bounds: SIDE, maximized: false, fullScreen: false }, [MAIN, SIDE]))
      .toEqual({ ...OPENED, maximized: false, fullScreen: false });
  });

  it("keeps the normal bounds as they are when where the window is cannot be told", () => {
    const kept = { ...OPENED, maximized: false, fullScreen: true };
    expect(windowPlaceToKeep({ normal: OPENED, bounds: SIDE_SCREEN, maximized: false, fullScreen: true })).toEqual(kept);
    expect(windowPlaceToKeep({ normal: OPENED, bounds: SIDE_SCREEN, maximized: false, fullScreen: true }, [])).toEqual(kept);
    expect(windowPlaceToKeep({ normal: OPENED, maximized: false, fullScreen: true }, [MAIN, SIDE])).toEqual(kept);
    // A frame on no display at all, such as a minimized window's on Windows.
    expect(windowPlaceToKeep({ normal: OPENED, bounds: { x: -32000, y: -32000, width: 160, height: 28 }, maximized: false, fullScreen: true }, [MAIN, SIDE]))
      .toEqual(kept);
  });

  it("brings normal bounds that are on no display onto the one the window is on", () => {
    expect(windowPlaceToKeep({ normal: { x: 9000, y: 9000, width: 1200, height: 800 }, bounds: SIDE, maximized: true, fullScreen: false }, [MAIN, SIDE]))
      .toEqual({ x: 2600, y: 320, width: 1200, height: 800, maximized: true, fullScreen: false });
  });

  it("shrinks a normal size larger than the display the window is on to fit it", () => {
    expect(windowPlaceToKeep({ normal: { x: 1920, y: 0, width: 2400, height: 1300 }, bounds: MAIN, maximized: true, fullScreen: false }, [MAIN, SIDE]))
      .toEqual({ x: 0, y: 0, width: 1920, height: 1032, maximized: true, fullScreen: false });
  });
});

describe("how a place reads in the desktop log", () => {
  it("writes the size and the corner, and only numbers", () => {
    expect(placeText({ x: 1920, y: -8, width: 2560, height: 1440 })).toBe("2560x1440 at 1920,-8");
    expect(placeText({ width: 1440, height: 900 })).toBe("1440x900 centred");
    expect(placeText({ x: 10.4, y: 20.6, width: 1300.2, height: 800 })).toBe("1300x800 at 10,21");
    expect(placeText({ x: 0, y: 0, width: 1300, height: 800, maximized: true, fullScreen: false })).toBe("1300x800 at 0,0, maximized");
    expect(placeText({ x: 0, y: 0, width: 1300, height: 800, maximized: false, fullScreen: true })).toBe("1300x800 at 0,0, full screen");
  });

  it("writes none for anything that is not a place, whatever desktop-state.json holds", () => {
    for (const value of [undefined, null, "big", 7, [], {}, { width: "1440", height: 900 }]) {
      expect(placeText(value)).toBe("none");
    }
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
    /** Where the window is drawn now, when that is not its normal bounds. */
    frame: { x: number, y: number, width: number, height: number } | null = null;
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
    getBounds() { return { ...(this.frame ?? this.normal) }; }
    isMaximized() { return this.maximized; }
    isFullScreen() { return this.fullScreen; }
    close() { this.emit("close"); this.destroyed = true; this.emit("closed"); }
  }

  function app(platform = "win32") {
    FakeWindow.made = [];
    const desktopState = createDesktopState(() => join(dir, "desktop-state.json"));
    const traces: string[] = [];
    const context: Record<string, any> = {
      win: null, windowOrigin: null, deck: { port: 4317 },
      BrowserWindow: FakeWindow, windowChrome, join, here: "/desktop",
      process: { platform }, app: { getVersion: () => "test", focus: () => {} },
      deckOrigin: (port: number) => `http://127.0.0.1:${port}`,
      setRegular: () => {}, trace: (line: string) => { traces.push(line); }, offerReadyUpdate: () => {},
      desktopState, screen: { getAllDisplays: () => [{ workArea: MAIN }, { workArea: SIDE }] },
      windowPlaceToOpen, windowPlaceToKeep, placeText, WINDOW_MIN,
    };
    runInNewContext(`${fn("openWindow")}\n${fn("keepWindowPlace")}\nthis.openWindow = openWindow;`, context);
    const open = async (steal = true) => {
      context.openWindow(steal);
      const made = FakeWindow.made.at(-1)!;
      await made.listeners("ready-to-show")[0]();
      return made;
    };
    return { open, desktopState, context, traces };
  }

  it("opens on the other monitor after a Mac restarts itself, when the window was dragged there and put full screen — the report's case", async () => {
    const first = await app("darwin").open();
    // Opened centred on the main display. The person drags it to the side
    // display and clicks the green button: AppKit moves and grows it, and
    // Electron's normal bounds stay where the window opened.
    expect(first.options.x).toBeUndefined();
    first.frame = { x: 1920, y: 0, width: 2560, height: 1440 };
    first.fullScreen = true;
    first.close();

    // The quiet update's restart opens it with nobody having asked (#1214):
    // not full screen on a Mac, but on the display it was on.
    const second = await app("darwin").open(false);
    expect(second.options).toMatchObject({ x: 2480, y: 270, width: 1440, height: 900 });
    expect(second.calls).toEqual(["show"]);
  });

  it("writes what was kept, the displays it saw and where the window is to the desktop log", async () => {
    const { open, traces } = app();
    const first = await open();
    first.frame = { x: 1920, y: 0, width: 2560, height: 1440 };
    first.maximized = true;
    first.close();
    await open();
    expect(traces).toEqual([
      "open: kept none; displays 1920x1032 at 0,0 | 2560x1440 at 1920,0; asking 1440x900 centred",
      "open: shown at 1440x900 at 240,66",
      "close: keeping 1440x900 at 2480,270, maximized (window at 2560x1440 at 1920,0)",
      "open: kept 1440x900 at 2480,270, maximized; displays 1920x1032 at 0,0 | 2560x1440 at 1920,0; asking 1440x900 at 2480,270",
      "open: shown at 1440x900 at 2480,270, maximized",
    ]);
  });

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
