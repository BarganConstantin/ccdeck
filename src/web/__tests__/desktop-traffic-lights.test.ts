// The macOS desktop app's title bar keeps the traffic lights clear at every
// page zoom, at every width, and gives their room back in full screen.
//
// The traffic lights stand in window points: trafficLightPosition puts the red
// one 12 in (desktop/window-chrome.mjs), and the three 14pt buttons stand 20
// apart, so the green one ends at 66. Page zoom (Cmd+- and Cmd+=) scales the
// page's CSS px and not them, so the bar's 80 is divided by the zoom the app
// reports. Before, it was a fixed 80px: at 76% (Cmd+- three times) that was 61
// points, and the wordmark sat under the green button.
//
// Read from the sheet the way a browser cascades it (sheet-cascade.ts), with
// the page's half run against stand-in bridges, and the app's half — the
// preload's zoom and main.mjs's full-screen mark — against stand-in Electron
// objects.
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { join } from "node:path";
import { cascade, el, selects, type El } from "./sheet-cascade";
import { installDesktopChrome, zoomFactor } from "../desktop-chrome";
import type { DesktopWindow } from "../components/DesktopTitlebar";
import { windowChrome } from "../../../desktop/window-chrome.mjs";
import { placeText, WINDOW_MIN, windowPlaceToOpen } from "../../../desktop/window-place.mjs";

const desktopFile = (name: string) => fileURLToPath(new URL(`../../../desktop/${name}`, import.meta.url));

// ── the geometry ────────────────────────────────────────────────────────────
const BUTTON_PT = 14;
const PITCH_PT = 20;
const { x: FIRST_X } = windowChrome("darwin").trafficLightPosition;
/** Where the green button ends, in window points. */
const GREEN_END_PT = FIRST_X + 2 * PITCH_PT + BUTTON_PT;

const root = (attrs: Record<string, string>) => el("html", [], { states: ["root"], attrs });
const bar = (attrs: Record<string, string>): El[] => [root(attrs), el("body"), el("div", ["app"]), el("header", ["topbar"])];
const mac = { "data-desktop-chrome": "true", "data-desktop-platform": "darwin" };
const of = (chain: El[]) => (prop: string, width: number) => cascade(s => selects(s, chain), prop, width);

/** The bar's start inset in CSS px, as the browser resolves the sheet's value
 *  at this zoom: the two shapes the darwin rules write. */
function insetPx(value: string | null, reserve: string | null, zoom: number): number {
  if (value === "12px") return 12;
  expect(value).toBe("var(--traffic-lights-w)");
  const m = /^calc\((\d+(?:\.\d+)?)px \/ var\(--desktop-zoom, 1\)\)$/.exec(reserve ?? "");
  expect(m, `a reserve divided by the zoom, not ${reserve}`).not.toBeNull();
  return Number(m![1]) / zoomFactor(zoom);
}

/** Window widths in points, at the zooms the menu steps to: the page's CSS
 *  width is the window's divided by the zoom, so 760 at 150% is a 507px page,
 *  under the sheet's phone breakpoint. */
const WINDOWS_PT = [1440, 1024, 760, WINDOW_MIN.width];
const ZOOMS = [0.5, 0.67, 0.76, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

describe("the bar on macOS", () => {
  it("keeps the wordmark 80 points in, past the green button, at every zoom and width", () => {
    expect(GREEN_END_PT).toBe(66);
    const at = of(bar(mac));
    for (const zoom of ZOOMS) {
      for (const windowPt of WINDOWS_PT) {
        const page = Math.floor(windowPt / zoom);
        const css = insetPx(at("padding-left", page), at("--traffic-lights-w", page), zoom);
        const points = css * zoom;
        expect(points, `${windowPt}pt window at ${zoom * 100}%`).toBeCloseTo(80, 1);
        expect(points - GREEN_END_PT, `${windowPt}pt window at ${zoom * 100}%`).toBeGreaterThanOrEqual(12);
      }
    }
  });

  it("would not have: a fixed 80px slid under the green button once zoomed out", () => {
    // The old rule, at Cmd+- three and four times (76% and 69%).
    for (const zoom of [0.76, 0.69]) expect(80 * zoom).toBeLessThan(GREEN_END_PT);
  });

  it("holds the inset at every breakpoint the bar has, the phone's included", () => {
    const at = of(bar(mac));
    for (const width of [2000, 1679, 1440, 1100, 1023, 1024, 760, 680, 679, 641, 640, 507, 480, 389, 339]) {
      expect(at("padding-left", width), `${width}px`).toBe("var(--traffic-lights-w)");
      expect(at("--traffic-lights-w", width), `${width}px`).toBe("calc(80px / var(--desktop-zoom, 1))");
    }
  });

  it("stays 40 points tall when zoomed out, so the traffic lights never hang below it", () => {
    const at = of([root(mac)]);
    const tall = (zoom: number, width: number) => {
      const v = at("--topbar-h", width);
      expect(v).toBe("max(40px, calc(40px / var(--desktop-zoom, 1)))");
      return Math.max(40, 40 / zoomFactor(zoom));
    };
    // The lowest button's frame ends 28 points down.
    const LIGHTS_BOTTOM_PT = 12 + 16;
    for (const zoom of [0.25, 0.5, 0.58, 0.63, 0.69, 0.76, 0.9]) {
      for (const windowPt of WINDOWS_PT) {
        const points = tall(zoom, Math.floor(windowPt / zoom)) * zoom;
        expect(points, `${windowPt}pt window at ${zoom * 100}%`).toBeCloseTo(40, 5);
        expect(points).toBeGreaterThan(LIGHTS_BOTTOM_PT);
      }
    }
    // Zoomed in it is the 40px it was drawn at.
    for (const zoom of [1, 1.25, 1.5, 2]) expect(tall(zoom, 1440)).toBe(40);
  });

  it("leaves the phone's bar height to the phone, as on Windows and Linux", () => {
    const winRoot = of([root({ "data-desktop-chrome": "true", "data-desktop-platform": "win32" })]);
    const macRoot = of([root(mac)]);
    for (const width of [640, 507, 390]) expect(macRoot("--topbar-h", width)).toBe(winRoot("--topbar-h", width));
  });

  it("gives the room back in full screen, where macOS hides the traffic lights", () => {
    const at = of(bar({ ...mac, "data-desktop-full-screen": "true" }));
    for (const width of [1440, 1024, 760, 507]) expect(at("padding-left", width)).toBe("12px");
  });

  it("keeps the bar a drag region and its controls pressable", () => {
    const at = of(bar(mac));
    expect(at("-webkit-app-region", 1440)).toBe("drag");
    const sheet = readFileSync(fileURLToPath(new URL("../styles/desktop-titlebar.css", import.meta.url)), "utf8");
    expect(sheet).toMatch(/\.topbar :is\(\.readout, \.tb-end, \.actions, button, a, input, select, \[role="button"\], \[tabindex\]\) \{\s*-webkit-app-region: no-drag;/);
  });

  it("leaves Windows and Linux as they were", () => {
    const at = of(bar({ "data-desktop-chrome": "true", "data-desktop-platform": "win32" }));
    expect(at("padding-left", 1440)).toBe("8px");
  });
});

// ── the page's half ─────────────────────────────────────────────────────────
function stage() {
  const style = new Map<string, string>();
  const rootEl = {
    dataset: {} as Record<string, string | undefined>,
    style: { setProperty: (k: string, v: string) => { style.set(k, v); } },
  };
  let mq: EventEmitter & { addEventListener: (t: string, f: () => void, o?: unknown) => void } | null = null;
  const queries: string[] = [];
  const view = {
    devicePixelRatio: 2,
    matchMedia: (q: string) => {
      queries.push(q);
      const e = new EventEmitter();
      mq = Object.assign(e, { addEventListener: (t: string, f: () => void) => { e.once(t, f); } });
      return mq;
    },
  };
  return {
    rootEl, style, view, queries,
    /** The device pixel ratio moves, as it does when the zoom does. */
    rescale(dpr: number) { view.devicePixelRatio = dpr; mq!.emit("change"); },
  };
}
const bridge = (more: Partial<DesktopWindow> = {}): DesktopWindow =>
  ({ platform: "darwin", colors: async () => {}, menu: async () => {}, ...more });

describe("the page", () => {
  it("reads only page zooms, to four decimals", () => {
    expect(zoomFactor(1)).toBe(1);
    expect(zoomFactor(1.2 ** -2)).toBe(0.6944);
    expect(zoomFactor(1.25)).toBe(1.25);
    for (const bad of [0, -1, 0.1, 9, NaN, Infinity, "1.5", null, undefined, {}]) expect(zoomFactor(bad)).toBe(1);
  });

  it("marks the window, tells the bar the zoom, and asks again when the zoom changes", () => {
    const s = stage();
    let zoom = 1;
    installDesktopChrome(bridge({ zoom: () => zoom }), s.rootEl as unknown as HTMLElement, s.view as unknown as Window);
    expect(s.rootEl.dataset).toMatchObject({ desktopChrome: "true", desktopPlatform: "darwin" });
    expect(s.style.get("--desktop-zoom")).toBe("1");
    expect(s.queries.at(-1)).toBe("(resolution: 2dppx)");
    for (const [z, dpr] of [[1.25, 2.5], [1.2 ** -1.5, 1.5214], [2, 4], [1, 2]] as const) {
      zoom = z;
      s.rescale(dpr);
      expect(s.style.get("--desktop-zoom")).toBe(String(zoomFactor(z)));
      expect(s.queries.at(-1)).toBe(`(resolution: ${dpr}dppx)`);
    }
  });

  it("keeps the unzoomed 80 in an app older than the call, or when the zoom cannot be read", () => {
    const old = stage();
    installDesktopChrome(bridge(), old.rootEl as unknown as HTMLElement, old.view as unknown as Window);
    expect(old.rootEl.dataset.desktopPlatform).toBe("darwin");
    expect(old.style.has("--desktop-zoom")).toBe(false);
    const broken = stage();
    installDesktopChrome(bridge({ zoom: () => { throw new Error("gone"); } }), broken.rootEl as unknown as HTMLElement, broken.view as unknown as Window);
    expect(broken.style.get("--desktop-zoom")).toBe("1");
  });

  it("asks nothing of Windows and Linux", () => {
    const s = stage();
    const zoom = vi.fn(() => 1.5);
    installDesktopChrome(bridge({ platform: "win32", zoom }), s.rootEl as unknown as HTMLElement, s.view as unknown as Window);
    expect(s.rootEl.dataset).toMatchObject({ desktopChrome: "true", desktopPlatform: "win32" });
    expect(zoom).not.toHaveBeenCalled();
    expect(s.style.size).toBe(0);
  });
});

// ── the app's half ──────────────────────────────────────────────────────────
describe("the preload", () => {
  function load(argv: string[] = []) {
    const exposed: Record<string, any> = {};
    const getZoomFactor = vi.fn(() => 0.6944);
    const electron = {
      contextBridge: { exposeInMainWorld: (name: string, api: unknown) => { exposed[name] = api; } },
      ipcRenderer: { invoke: vi.fn(async () => undefined) },
      webFrame: { getZoomFactor },
      webUtils: { getPathForFile: () => "" },
    };
    runInNewContext(readFileSync(desktopFile("preload.cjs"), "utf8"), {
      require: (m: string) => { if (m !== "electron") throw new Error(m); return electron; },
      process: { argv, platform: "darwin" },
    });
    return { win: exposed.ccdeckWindow, getZoomFactor };
  }

  it("answers the page's zoom with the frame's own factor, and takes nothing from the page", () => {
    const { win, getZoomFactor } = load();
    expect(win.zoom("anything")).toBe(0.6944);
    expect(getZoomFactor).toHaveBeenCalledTimes(1);
    expect(getZoomFactor.mock.calls[0]).toEqual([]);
    expect(Object.keys(win)).toEqual(["platform", "colors", "menu", "zoom"]);
  });

  it("exposes no window bridge to a page in the native frame", () => {
    expect(load(["--ccdeck-native-chrome"]).win).toBeUndefined();
  });
});

describe("main.mjs", () => {
  function open(platform: string) {
    const windows: FakeWindow[] = [];
    class FakeWindow extends EventEmitter {
      fullScreen = false;
      ran: string[] = [];
      webContents = Object.assign(new EventEmitter(), {
        isLoading: () => false,
        executeJavaScript: async (code: string) => { this.ran.push(code); return true; },
        setWindowOpenHandler: () => {},
        getUserAgent: () => "test",
        setUserAgent: () => {},
      });
      constructor(public options: Record<string, any>) { super(); windows.push(this); }
      isDestroyed() { return false; }
      isFullScreen() { return this.fullScreen; }
      setMenuBarVisibility() {}
      loadURL() {}
    }
    const main = readFileSync(desktopFile("main.mjs"), "utf8");
    const start = main.indexOf("function openWindow(");
    const body = main.slice(start, main.indexOf("\n}\n", start) + 2);
    runInNewContext(`${body}\nopenWindow(false);`, {
      win: null, windowOrigin: null, deck: { port: 4999 },
      BrowserWindow: FakeWindow, windowChrome, join, here: "/desktop",
      process: { platform }, app: { getVersion: () => "test", focus: () => {} },
      deckOrigin: (port: number) => `http://127.0.0.1:${port}`,
      setRegular: () => {}, trace: () => {}, offerReadyUpdate: () => {},
      desktopState: { read: () => ({}) }, screen: { getAllDisplays: () => [] }, windowPlaceToOpen, placeText, WINDOW_MIN,
    });
    return windows[0];
  }

  const mark = (on: boolean) => `document.documentElement.dataset.desktopFullScreen = "${on}"`;

  it("marks the page when the macOS window enters and leaves full screen, and after each load", () => {
    const w = open("darwin");
    w.webContents.emit("did-finish-load");
    w.fullScreen = true;
    w.emit("enter-full-screen");
    w.fullScreen = false;
    w.emit("leave-full-screen");
    expect(w.ran).toEqual([mark(false), mark(true), mark(false)]);
  });

  it("marks nothing on Windows and Linux, whose caption buttons do not hide in the bar", () => {
    const w = open("linux");
    w.webContents.emit("did-finish-load");
    w.emit("enter-full-screen");
    expect(w.ran).toEqual([]);
  });
});
