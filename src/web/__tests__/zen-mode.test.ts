// Zen Mode (zen-mode.ts): Workspace's panes over the whole window, and the
// browser's full screen only where Esc can stay the terminal's. Run against
// stand-in document and navigator objects, as tab-keys.test.ts runs ⤢; the
// layout half (the same tree laid out again, no pane remounted) is the
// sheet's, pinned at the end, and measured in a browser.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async () => (await import("./fake-react")).react);

import { flush, mount } from "./fake-react";
import { cascade, el, selects, type El } from "./sheet-cascade";
import { sourceOf } from "./client-source";
import { canZenFullScreen, useZenMode, type ZenMode } from "../zen-mode";
import { arrange, cornerPane, insertPane, singleSplit, withFocusedTarget, type SplitState } from "../workspace-split";

/** Chrome on Linux: full screen and the Keyboard Lock API. */
function stubPage(over: { lock?: boolean; fullscreen?: boolean; refuse?: boolean; late?: boolean } = {}) {
  const doc = new EventTarget() as EventTarget & Record<string, unknown>;
  const lock = vi.fn(async (_codes?: string[]) => {});
  const unlock = vi.fn();
  let answer: (() => void) | null = null;
  const requestFullscreen = vi.fn(() => {
    if (over.refuse) return Promise.reject(new TypeError("Permissions check failed"));
    const grant = () => {
      doc.fullscreenElement = doc.documentElement;
      doc.dispatchEvent(new Event("fullscreenchange"));
    };
    if (!over.late) { grant(); return Promise.resolve(); }
    return new Promise<void>(res => { answer = () => { grant(); res(); }; });
  });
  const exitFullscreen = vi.fn(async () => {
    doc.fullscreenElement = null;
    doc.dispatchEvent(new Event("fullscreenchange"));
  });
  const body = { isConnected: true, closest: () => null };
  const focused = vi.fn();
  /** A place in a pane that takes the focus. */
  const place = (name: string) => {
    const it = { name, isConnected: true, closest: (sel: string) => (sel === ".stage-dock" ? {} : null), focus: () => { focused(name); doc.activeElement = it; } };
    return it;
  };
  const terminal = place("terminal");
  /** What the document holds, by selector: a split whose focused pane shows
   *  its terminal, unless a test says otherwise. */
  const places = new Map<string, unknown>([
    [".stage-dock .wsp-pane[data-focused]", {}],
    [".stage-dock .wsp-pane[data-focused] .xterm-helper-textarea", terminal],
  ]);
  Object.assign(doc, {
    fullscreenEnabled: over.fullscreen ?? true,
    fullscreenElement: null,
    documentElement: { requestFullscreen },
    exitFullscreen,
    body,
    activeElement: body,
    querySelector: (sel: string) => places.get(sel) ?? null,
  });
  vi.stubGlobal("document", doc);
  vi.stubGlobal("navigator", { userAgent: "Chrome", platform: "Linux x86_64", ...(over.lock === false ? {} : { keyboard: { lock, unlock } }) });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 1; });
  return {
    doc, lock, unlock, requestFullscreen, exitFullscreen, body, terminal, focused, place, places,
    /** The browser's answer to a `late` request. */
    answer: () => answer?.(),
    /** Esc held, or the browser's own control: full screen ends without the page asking. */
    platformLeaves: () => { doc.fullscreenElement = null; doc.dispatchEvent(new Event("fullscreenchange")); },
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

function zen(available = true, canFull?: boolean) {
  let latest: ZenMode | null = null;
  const Probe = (p: { available: boolean }) => { latest = useZenMode(p.available, canFull); return null; };
  const m = mount(Probe, { available });
  return { m, get z() { return latest!; }, set available(v: boolean) { m.rerender({ available: v }); } };
}

describe("where Zen asks for the browser's full screen", () => {
  it("only where full screen exists and the Keyboard Lock API can keep Esc for the terminal", () => {
    const lock = () => Promise.resolve();
    expect(canZenFullScreen({ fullscreenEnabled: true }, { keyboard: { lock } })).toBe(true);
    // Firefox and Safari: full screen, no lock: Esc would end it on every press.
    expect(canZenFullScreen({ fullscreenEnabled: true }, {})).toBe(false);
    expect(canZenFullScreen({ fullscreenEnabled: true }, { keyboard: {} })).toBe(false);
    // Full screen refused by the page's embedder, or no document at all.
    expect(canZenFullScreen({ fullscreenEnabled: false }, { keyboard: { lock } })).toBe(false);
    expect(canZenFullScreen(undefined, { keyboard: { lock } })).toBe(false);
  });
});

describe("Zen Mode with the Keyboard Lock API (Chromium, the desktop app)", () => {
  it("asks for full screen on the page's root inside the press, locks Esc, and leaves both on the way out", async () => {
    const page = stubPage();
    const s = zen();
    s.z.enter();
    expect(s.z.on, "on at once, before the browser answers").toBe(true);
    expect(page.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(page.requestFullscreen).toHaveBeenCalledWith({ navigationUI: "hide" });
    await flush();
    expect(s.z.full).toBe(true);
    expect(page.lock).toHaveBeenCalledWith(["Escape"]);
    s.z.exit();
    expect(s.z.on).toBe(false);
    expect(s.z.full).toBe(false);
    expect(page.unlock).toHaveBeenCalled();
    expect(page.exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it("ends when full screen ends the platform's way (Esc held, the browser's control), and lets go of Esc", async () => {
    const page = stubPage();
    const s = zen();
    s.z.enter();
    await flush();
    page.platformLeaves();
    expect(s.z.on).toBe(false);
    expect(page.unlock).toHaveBeenCalled();
    expect(page.exitFullscreen, "already out: nothing to leave").not.toHaveBeenCalled();
  });

  it("fills the window when the browser refuses, and has no full screen to leave", async () => {
    const page = stubPage({ refuse: true });
    const s = zen();
    s.z.enter();
    await flush();
    expect(s.z.on).toBe(true);
    expect(s.z.full).toBe(false);
    expect(page.lock).not.toHaveBeenCalled();
    s.z.exit();
    expect(s.z.on).toBe(false);
    expect(page.exitFullscreen).not.toHaveBeenCalled();
  });

  it("leaves a full screen that arrives after Zen was already left", async () => {
    const page = stubPage({ late: true });
    const s = zen();
    s.z.enter();
    s.z.exit(); // before the browser's answer
    page.answer();
    await flush();
    expect(s.z.on).toBe(false);
    expect(s.z.full).toBe(false);
    expect(page.exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it("never asks for, nor leaves, a full screen it did not ask for (⤢'s, F11's)", async () => {
    const page = stubPage();
    page.doc.fullscreenElement = page.doc.documentElement;
    const s = zen();
    s.z.enter();
    await flush();
    expect(s.z.on).toBe(true);
    expect(s.z.full, "the page is in full screen, but not Zen's").toBe(false);
    expect(page.requestFullscreen).not.toHaveBeenCalled();
    page.platformLeaves();
    expect(s.z.on, "someone else's full screen ending is not Zen's way out").toBe(true);
    s.z.exit();
    expect(page.exitFullscreen).not.toHaveBeenCalled();
  });

  it("leaves its full screen when the deck goes away", async () => {
    const page = stubPage();
    const s = zen();
    s.z.enter();
    await flush();
    s.m.unmount();
    expect(page.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(page.unlock).toHaveBeenCalled();
  });
});

describe("Zen Mode without the lock (Firefox, Safari)", () => {
  it("fills the window and never asks for full screen", async () => {
    const page = stubPage({ lock: false });
    const s = zen();
    s.z.enter();
    await flush();
    expect(s.z.on).toBe(true);
    expect(s.z.full).toBe(false);
    expect(page.requestFullscreen).not.toHaveBeenCalled();
    s.z.exit();
    expect(page.exitFullscreen).not.toHaveBeenCalled();
  });

  it("follows the caller's answer over the page's", async () => {
    const page = stubPage();
    const s = zen(true, false);
    s.z.enter();
    await flush();
    expect(page.requestFullscreen).not.toHaveBeenCalled();
  });
});

describe("Zen Mode's state", () => {
  it("toggles both ways, and a second enter or exit is nothing", async () => {
    const page = stubPage({ lock: false });
    const s = zen();
    s.z.toggle();
    expect(s.z.on).toBe(true);
    s.z.enter();
    expect(s.z.on).toBe(true);
    s.z.toggle();
    expect(s.z.on).toBe(false);
    s.z.exit();
    expect(s.z.on).toBe(false);
    expect(page.requestFullscreen).not.toHaveBeenCalled();
  });

  it("is offered only while Workspace has its panes, and ends the moment it does not", async () => {
    const page = stubPage();
    const s = zen(false);
    s.z.enter();
    expect(s.z.on, "the Board, or no pane: nothing to enter").toBe(false);
    expect(page.requestFullscreen).not.toHaveBeenCalled();
    s.available = true;
    s.z.enter();
    await flush();
    expect(s.z.full).toBe(true);
    s.available = false; // the Board, a phone-sized window, the pane closed
    expect(s.z.on).toBe(false);
    expect(page.exitFullscreen).toHaveBeenCalledTimes(1);
    s.available = true;
    expect(s.z.on, "not remembered: back in Workspace, Zen is off").toBe(false);
  });

  it("starts off on every load: nothing is read or written to storage", () => {
    const src = sourceOf("zen-mode.ts");
    expect(src).not.toMatch(/localStorage|sessionStorage|readStored|writeStored/);
    expect(src).toMatch(/useState\(false\)/);
  });
});

describe("the keys in Zen", () => {
  it("go into the pane that had them when Zen comes in from outside the panes", () => {
    const page = stubPage({ lock: false });
    const s = zen();
    s.z.enter();
    expect(page.focused).toHaveBeenCalledTimes(1);
    expect(page.doc.activeElement).toBe(page.terminal);
  });

  it("go to Chat's composer when the pane that had them shows Chat, and never to another pane's terminal", () => {
    const page = stubPage({ lock: false });
    const composer = page.place("composer");
    page.places.delete(".stage-dock .wsp-pane[data-focused] .xterm-helper-textarea");
    page.places.set(".stage-dock .wsp-pane[data-focused] .chat-composer-draft", composer);
    page.places.set(".stage-dock .xterm-helper-textarea", page.place("another pane's terminal"));
    const s = zen();
    s.z.enter();
    expect(page.focused.mock.calls).toEqual([["composer"]]);
  });

  it("go to the one pane's terminal when there is no split", () => {
    const page = stubPage({ lock: false });
    page.places.clear();
    page.places.set(".stage-dock .xterm-helper-textarea", page.terminal);
    const s = zen();
    s.z.enter();
    expect(page.doc.activeElement).toBe(page.terminal);
  });

  it("stay where they are when they are already in a pane", () => {
    const page = stubPage({ lock: false });
    page.doc.activeElement = { isConnected: true, closest: (sel: string) => (sel === ".stage-dock" ? {} : null) };
    const s = zen();
    s.z.enter();
    expect(page.focused).not.toHaveBeenCalled();
  });

  it("on the way out, go to the pane only where they were left on nothing", () => {
    const page = stubPage({ lock: false });
    const s = zen();
    s.z.enter();
    page.focused.mockClear();
    s.z.exit(); // the terminal still has them
    expect(page.focused).not.toHaveBeenCalled();
    s.z.enter();
    page.doc.activeElement = page.body; // Exit Zen Mode pressed, and gone with Zen
    page.focused.mockClear();
    s.z.exit();
    expect(page.focused).toHaveBeenCalledTimes(1);
  });
});

describe("Exit Zen Mode's corner (cornerPane)", () => {
  const S = (id: string) => ({ kind: "session" as const, id });
  const MIN = { w: 354, h: 224 };
  const BOX = { w: 1440, h: 860 };
  const three = (): SplitState => {
    let s = withFocusedTarget(singleSplit(), S("s1"));
    s = insertPane(s, "p0", "right", S("s2"))!.state;
    return insertPane(s, "p1", "bottom", S("s3"))!.state;
  };

  it("is the pane along the top that ends furthest right", () => {
    expect(cornerPane(arrange(three(), BOX, MIN))).toBe("p1");
    let grid = three();
    grid = insertPane(grid, "p0", "bottom", S("s4"))!.state;
    expect(cornerPane(arrange(grid, BOX, MIN))).toBe("p1");
    // One wide pane over two: the top one reaches the corner.
    let top = withFocusedTarget(singleSplit(), S("s1"));
    top = insertPane(top, "p0", "bottom", S("s2"))!.state;
    top = insertPane(top, "p1", "right", S("s3"))!.state;
    expect(cornerPane(arrange(top, BOX, MIN))).toBe("p0");
  });

  it("is none under the strip, which has the corner itself", () => {
    expect(cornerPane(arrange(three(), { w: 600, h: 860 }, MIN))).toBeNull();
  });

  it("is the one pane when there is one", () => {
    expect(cornerPane(arrange(withFocusedTarget(singleSplit(), S("s1")), BOX, MIN))).toBe("p0");
  });
});

describe("the same tree, laid out again (zen-mode.css)", () => {
  const app = el("div", ["app"], { attrs: { "data-view": "workspace", "data-zen": "" } });
  const chain = (...rest: El[]) => [el("html"), el("body"), app, ...rest];
  // The stage's own `.app:has(.stage-dock…)` rules cannot be read here (no
  // `:has()` in the matcher); the one that reaches these elements hides Usage
  // and This machine too, so it is left out and changes no answer below.
  const read = (c: El[], prop: string) => cascade(sel => (sel.includes(":has(") ? null : selects(sel, c)), prop, 1440);

  it("hides the chrome where it stands, with visibility, so nothing is unmounted or reflowed", () => {
    for (const part of ["topbar", "edge-rail", "left-column", "statusbar", "banner-strip"]) {
      expect(read(chain(el("div", [part])), "visibility"), part).toBe("hidden");
      expect(read(chain(el("div", [part])), "display"), `${part} keeps its box`).not.toBe("none");
    }
    for (const panel of ["detail", "ws-side", "usage-panel", "sysdetail"]) {
      expect(read(chain(el("main", ["main"]), el("aside", [panel])), "visibility"), panel).toBe("hidden");
    }
  });

  it("lifts the pane's cell and the stage over the whole window, the cell measured as before", () => {
    for (const part of ["ws-cell", "stage-dock"]) {
      const c = chain(el("main", ["main"]), el("div", [part]));
      expect(read(c, "position"), part).toBe("fixed");
      expect(read(c, "inset"), part).toBe("0");
    }
    expect(sourceOf("use-stage.ts")).toContain(".ws-cell");
  });

  it("is one attribute on the app root: App keeps drawing the same stage, and Zen keys nothing", () => {
    const appSrc = sourceOf("App.tsx");
    expect(appSrc).toContain('data-zen={zen.on ? (zen.full ? "full" : "") : undefined}');
    expect(appSrc).not.toMatch(/zen\.on\s*&&\s*<StageDockSlot|zen\.on\s*\?\s*<StageDockSlot|key=\{[^}]*zen/);
    const shell = sourceOf("components/terminal/StageShell.tsx");
    expect(shell).not.toMatch(/key=\{[^}]*zen/);
  });
});
