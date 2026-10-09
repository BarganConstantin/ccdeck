import { describe, expect, it } from "vitest";
import { titlebarColors, windowChrome } from "../../../desktop/window-chrome.mjs";

describe("desktop caption chrome", () => {
  it("keeps native controls on Linux and Windows", () => {
    for (const platform of ["linux", "win32"]) {
      expect(windowChrome(platform)).toMatchObject({ titleBarStyle: "hidden", titleBarOverlay: { height: 34 }, autoHideMenuBar: true });
    }
  });
  it("preserves macOS traffic lights", () => {
    expect(windowChrome("darwin")).toEqual({ titleBarStyle: "hidden", trafficLightPosition: { x: 12, y: 10 } });
  });
  it("accepts theme colours without allowing native options from a renderer", () => {
    expect(titlebarColors({ color: "#191a1c", symbolColor: "#D4D4D4", height: 200 })).toEqual({ color: "#191a1c", symbolColor: "#D4D4D4", height: 34 });
    for (const input of [null, {}, { color: "transparent", symbolColor: "#ffffff" }, { color: "#191a1c", symbolColor: "red" }]) expect(titlebarColors(input)).toBeNull();
  });
});

// Exercise the window lifecycle too: closing the old window must finish before
// creating its native replacement, or its closed handler clears the new window.
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { join } from "node:path";

it("keeps an older deck usable in a visible native window", async () => {
  const windows: FakeWindow[] = [];
  class FakeWindow extends EventEmitter {
    destroyed = false;
    visible = false;
    webContents = Object.assign(new EventEmitter(), {
      isLoading: () => false,
      executeJavaScript: async () => false,
      setWindowOpenHandler: () => {},
      getUserAgent: () => "test",
      setUserAgent: () => {},
    });
    constructor(public options: Record<string, any>) { super(); windows.push(this); }
    isDestroyed() { return this.destroyed; }
    setMenuBarVisibility() {}
    loadURL() {}
    show() { this.visible = true; }
    close() { this.destroyed = true; this.emit("closed"); }
  }
  const main = readFileSync(join(__dirname, "../../../desktop/main.mjs"), "utf8");
  const start = main.indexOf("function openWindow(");
  const body = main.slice(start, main.indexOf("\n}\n", start) + 2);
  const context = {
    win: null, windowOrigin: null, deck: { port: 4317 },
    BrowserWindow: FakeWindow, windowChrome, join, here: "/desktop",
    process: { platform: "linux" }, app: { getVersion: () => "test", focus: () => {} },
    deckOrigin: (port: number) => `http://127.0.0.1:${port}`,
    setRegular: () => {}, trace: () => {}, offerReadyUpdate: () => {},
  };
  runInNewContext(`${body}\nopenWindow(false);`, context);
  await windows[0].listeners("ready-to-show")[0]();
  expect(windows).toHaveLength(2);
  expect(windows[0].destroyed).toBe(true);
  expect(context.win).toBe(windows[1]);
  expect(windows[1].options.titleBarStyle).toBeUndefined();
  expect(windows[1].options.webPreferences.additionalArguments).toEqual(["--ccdeck-native-chrome"]);
  await windows[1].listeners("ready-to-show")[0]();
  expect(windows[1].visible).toBe(true);
});
