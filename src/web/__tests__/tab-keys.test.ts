// What a browser tab keeps from the pane, and the two answers to it: a "Leave
// site?" while the pane has the keys (leave-guard.ts), and ⤢ as full screen
// with Esc locked where full screen is what hands the pane Ctrl+W
// (tab-keys.ts, use-full-stage.ts). Run against stand-in window, document and
// navigator objects; the real browser's half — Chromium passing reserved
// shortcuts to a full-screen page — is measured with trusted input, not here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("react", async () => (await import("./fake-react")).react);

import { flush, mount } from "./fake-react";
import { withoutComments } from "./tsx-scan";
import { useFullStage } from "../components/terminal/use-full-stage";

const CHROME_LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const DESKTOP_APP = `${CHROME_LINUX} Electron/42.0.0 ccdeck-desktop/3.41.3`;

/** A page with full screen and keyboard lock, as Chrome on Linux has them. */
function stubPage(over: { platform?: string; ua?: string; lock?: boolean; fullscreen?: boolean; refuse?: boolean } = {}) {
  const win = new EventTarget();
  const doc = new EventTarget() as EventTarget & Record<string, unknown>;
  const lock = vi.fn(async (_codes?: string[]) => {});
  const unlock = vi.fn();
  const requestFullscreen = vi.fn(async () => {
    if (over.refuse) throw new TypeError("Permissions check failed");
    doc.fullscreenElement = doc.documentElement;
    doc.dispatchEvent(new Event("fullscreenchange"));
  });
  const exitFullscreen = vi.fn(async () => {
    doc.fullscreenElement = null;
    doc.dispatchEvent(new Event("fullscreenchange"));
  });
  Object.assign(doc, {
    hasFocus: vi.fn(() => true),
    fullscreenEnabled: over.fullscreen ?? true,
    fullscreenElement: null,
    documentElement: { requestFullscreen },
    exitFullscreen,
  });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("navigator", {
    userAgent: over.ua ?? CHROME_LINUX,
    platform: over.platform ?? "Linux x86_64",
    ...(over.lock === false ? {} : { keyboard: { lock, unlock } }),
  });
  /** What the user leaving does: the event the browser fires, and whether
   *  the page asked to stay. */
  const leave = () => {
    const e = new Event("beforeunload", { cancelable: true }) as Event & { returnValue?: unknown };
    win.dispatchEvent(e);
    return e.defaultPrevented;
  };
  /** Esc held, or F11: full screen ends without the page asking. */
  const userLeavesFullScreen = () => {
    doc.fullscreenElement = null;
    doc.dispatchEvent(new Event("fullscreenchange"));
  };
  return { doc, lock, unlock, requestFullscreen, exitFullscreen, leave, userLeavesFullScreen };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("the leave guard", () => {
  // Fresh each time: a deliberate leave is for good, as the page is going.
  beforeEach(() => { vi.resetModules(); });

  it("asks before the page goes, until it is taken away", async () => {
    const page = stubPage();
    const { guardLeaving } = await import("../leave-guard");
    const stop = guardLeaving();
    expect(page.leave(), "a guarded page asks").toBe(true);
    stop();
    expect(page.leave(), "and an unguarded one does not").toBe(false);
  });

  it("says when the reader called the leave off, and only then", async () => {
    vi.useFakeTimers();
    const page = stubPage();
    const { guardLeaving } = await import("../leave-guard");
    const stayed = vi.fn();
    guardLeaving(stayed);
    page.leave();
    // Neither browser runs the page's timers under its dialog, but Firefox
    // draws its prompt a beat late: the look comes after that beat, and a
    // page that left never takes it.
    vi.advanceTimersByTime(399);
    expect(stayed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stayed).toHaveBeenCalledTimes(1);
  });

  it("waits for the page to have the focus again where the browser keeps it running under its prompt", async () => {
    vi.useFakeTimers();
    const page = stubPage();
    (page.doc.hasFocus as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const { guardLeaving } = await import("../leave-guard");
    const stayed = vi.fn();
    const stop = guardLeaving(stayed);
    page.leave();
    vi.runAllTimers();
    expect(stayed, "still under the prompt").not.toHaveBeenCalled();
    (window as unknown as EventTarget).dispatchEvent(new Event("focus"));
    expect(stayed).toHaveBeenCalledTimes(1);
    (window as unknown as EventTarget).dispatchEvent(new Event("keydown"));
    expect(stayed, "once per leave called off").toHaveBeenCalledTimes(1);
    // The dialog takes the focus, so the keys and the guard go while it asks:
    // the answer is still heard.
    page.leave();
    stop();
    (window as unknown as EventTarget).dispatchEvent(new Event("focus"));
    expect(stayed).toHaveBeenCalledTimes(2);
    expect(page.leave(), "and nothing asks once it is gone").toBe(false);
  });

  it("never holds the deck's own reload at the dialog", async () => {
    const page = stubPage();
    const { guardLeaving, leaveDeliberately } = await import("../leave-guard");
    guardLeaving();
    leaveDeliberately();
    expect(page.leave()).toBe(false);
  });

  it("does nothing inside the desktop app, where an objecting page silently keeps its window open", async () => {
    const page = stubPage({ ua: DESKTOP_APP });
    const { guardLeaving } = await import("../leave-guard");
    guardLeaving(undefined, DESKTOP_APP);
    expect(page.leave()).toBe(false);
  });

  it("is said deliberate by the auto-restart reload, right before it reloads", () => {
    const src = withoutComments(readFileSync(fileURLToPath(new URL("../use-auto-restart.ts", import.meta.url)), "utf8"));
    expect(src).toMatch(/leaveDeliberately\(\);\s*window\.location\.reload\(\);/);
  });

  it("is installed by the stage only while the pane has the keys", () => {
    const stage = withoutComments(readFileSync(fileURLToPath(new URL("../components/terminal/TerminalStage.tsx", import.meta.url)), "utf8"));
    expect(stage).toMatch(/if \(session\.keysOwner !== "pane"\) return;\s*return guardLeaving\(/);
  });
});

describe("where ⤢ means full screen", () => {
  it("is Chromium on Windows and Linux, in a tab", async () => {
    stubPage();
    const { canFullStage } = await import("../tab-keys");
    expect(canFullStage("Linux x86_64", CHROME_LINUX)).toBe(true);
    expect(canFullStage("Win32", CHROME_LINUX)).toBe(true);
  });

  it("is not a Mac, the desktop app, a browser without keyboard lock, or a page refused full screen", async () => {
    const { canFullStage } = await import("../tab-keys");
    stubPage();
    expect(canFullStage("MacIntel", CHROME_LINUX), "Ctrl shortcuts reach the page on a Mac already").toBe(false);
    expect(canFullStage("Linux x86_64", DESKTOP_APP)).toBe(false);
    stubPage({ lock: false });
    expect(canFullStage("Linux x86_64", CHROME_LINUX), "Firefox: Esc would end full screen on every press").toBe(false);
    stubPage({ fullscreen: false });
    expect(canFullStage("Linux x86_64", CHROME_LINUX)).toBe(false);
    stubPage();
    expect(canFullStage("Android", "Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/141.0.0.0 Mobile Safari/537.36"), "no reserved shortcuts to win back on a phone").toBe(false);
    expect(canFullStage("Linux armv81", "Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/141.0.0.0 Mobile Safari/537.36")).toBe(false);
  });

  it("says after a called-off leave how to give the session those keys — nothing on a Mac or already in full screen", async () => {
    const page = stubPage();
    const { KEPT_KEYS_APP, KEPT_KEYS_FULL, keptKeysNotice } = await import("../tab-keys");
    expect(keptKeysNotice(true, "Linux x86_64")).toBe(KEPT_KEYS_FULL);
    expect(KEPT_KEYS_FULL).toMatch(/Ctrl\+W.*⤢ full screen/);
    expect(keptKeysNotice(false, "Win32")).toBe(KEPT_KEYS_APP);
    expect(KEPT_KEYS_APP).toMatch(/desktop app/);
    expect(keptKeysNotice(true, "MacIntel")).toBeNull();
    page.doc.fullscreenElement = {};
    expect(keptKeysNotice(true, "Linux x86_64")).toBeNull();
  });
});

describe("entering and leaving full screen", () => {
  it("puts the whole deck in full screen and keeps Esc for the pane", async () => {
    const page = stubPage();
    const { enterFullStage } = await import("../tab-keys");
    expect(await enterFullStage()).toBe(true);
    expect(page.requestFullscreen).toHaveBeenCalledWith({ navigationUI: "hide" });
    expect(page.lock).toHaveBeenCalledWith(["Escape"]);
  });

  it("never waits on the lock: behind a permission prompt its answer may never come", async () => {
    const page = stubPage();
    page.lock.mockImplementation(() => new Promise<void>(() => {}));
    const { enterFullStage } = await import("../tab-keys");
    expect(await enterFullStage()).toBe(true);
    page.lock.mockImplementation(() => Promise.reject(new DOMException("refused", "NotAllowedError")));
    expect(await enterFullStage(), "a refused lock is still full screen").toBe(true);
  });

  it("answers false when the browser says no, and locks nothing", async () => {
    const page = stubPage({ refuse: true });
    const { enterFullStage } = await import("../tab-keys");
    expect(await enterFullStage()).toBe(false);
    expect(page.lock).not.toHaveBeenCalled();
  });

  it("unlocks and leaves, and leaves nothing it is not in", async () => {
    const page = stubPage();
    const { leaveFullStage } = await import("../tab-keys");
    leaveFullStage();
    expect(page.unlock).toHaveBeenCalled();
    expect(page.exitFullscreen, "not in full screen: nothing to leave").not.toHaveBeenCalled();
    page.doc.fullscreenElement = {};
    leaveFullStage();
    expect(page.exitFullscreen).toHaveBeenCalledTimes(1);
  });
});

describe("⤢ and ⤡ (useFullStage)", () => {
  async function stage(can: boolean, page = stubPage()) {
    let expanded = false;
    const toggleExpand = vi.fn(() => { expanded = !expanded; m.rerender({ expanded }); });
    let latest: ReturnType<typeof useFullStage> | null = null;
    const Probe = (p: { expanded: boolean }) => { latest = useFullStage(p.expanded, toggleExpand, can); return null; };
    const m = mount(Probe, { expanded });
    return { page, m, toggleExpand, get fs() { return latest!; }, get expanded() { return expanded; } };
  }

  it("is the width and full screen together, and ⤡ leaves both", async () => {
    const s = await stage(true);
    s.fs.toggle();
    await flush();
    expect(s.expanded).toBe(true);
    expect(s.page.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(s.fs.full).toBe(true);
    s.fs.toggle();
    expect(s.expanded).toBe(false);
    expect(s.fs.full).toBe(false);
    expect(s.page.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(s.toggleExpand, "one collapse, not a second from the fullscreenchange").toHaveBeenCalledTimes(2);
  });

  it("gives the board its room back when full screen ends some other way — Esc held, F11 — and lets go of Esc", async () => {
    const s = await stage(true);
    s.fs.toggle();
    await flush();
    s.page.userLeavesFullScreen();
    expect(s.fs.full).toBe(false);
    expect(s.expanded).toBe(false);
    expect(s.page.unlock).toHaveBeenCalled();
    expect(s.page.exitFullscreen, "already out: nothing to leave").not.toHaveBeenCalled();
  });

  it("is only the width where full screen is not what helps, or the browser refused it", async () => {
    const plain = await stage(false);
    plain.fs.toggle();
    await flush();
    expect(plain.expanded).toBe(true);
    expect(plain.page.requestFullscreen).not.toHaveBeenCalled();
    const refused = await stage(true, stubPage({ refuse: true }));
    refused.fs.toggle();
    await flush();
    expect(refused.expanded, "still the width").toBe(true);
    expect(refused.fs.full).toBe(false);
    refused.fs.toggle();
    expect(refused.expanded, "⤡ still gives the width back").toBe(false);
    expect(refused.page.exitFullscreen).not.toHaveBeenCalled();
  });

  it("leaves full screen with the stage, and never one the reader made", async () => {
    const s = await stage(true);
    s.fs.toggle();
    await flush();
    s.m.unmount();
    expect(s.page.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(s.expanded).toBe(false);

    const theirs = await stage(true);
    theirs.page.doc.fullscreenElement = {}; // a full screen someone else asked for
    theirs.m.unmount();
    expect(theirs.page.exitFullscreen).not.toHaveBeenCalled();
  });

  it("leaves a full screen that arrives after the stage closed, and gives the width back", async () => {
    const s = await stage(true);
    s.fs.toggle();
    s.m.unmount(); // before the browser's answer
    await flush();
    expect(s.page.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(s.expanded, "the stage reopens at its own width").toBe(false);
  });

  it("lets go of a full screen that arrives after ⤡ was already pressed", async () => {
    const s = await stage(true);
    s.fs.toggle();
    s.fs.toggle(); // before the browser's answer
    await flush();
    expect(s.expanded).toBe(false);
    expect(s.fs.full).toBe(false);
    expect(s.page.exitFullscreen).toHaveBeenCalledTimes(1);
  });
});
