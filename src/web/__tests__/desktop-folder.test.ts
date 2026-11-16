// New session's "Choose another folder…" in the desktop app (internal #106):
// the system's own folder dialog, behind a bridge that takes nothing from the
// page and answers only the folder the person chose. Read off the source, the
// way the other desktop bridges are pinned (desktop-terminal-keys.test.ts),
// and the page's half run against stand-in bridges.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canChooseFolder, chooseFolder } from "../desktop-folder";

const desktop = (name: string) => readFileSync(fileURLToPath(new URL(`../../../desktop/${name}`, import.meta.url)), "utf8");

describe("the bridge", () => {
  const preload = desktop("preload.cjs");
  const main = desktop("main.mjs");
  const handler = main.match(/function installFolderPickerIpc\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";

  it("exposes one call that sends the app nothing", () => {
    expect(preload.match(/exposeInMainWorld\("ccdeckFolder"/g)).toHaveLength(1);
    expect(preload).toMatch(/choose: \(\) => ipcRenderer\.invoke\("ccdeck:folder:choose"\)/);
  });

  it("answers only the deck's own page, in its main frame, one dialog at a time", () => {
    expect(handler).toMatch(/ipcMain\.handle\("ccdeck:folder:choose", async event => \{/);
    expect(handler, "the handler takes no argument from the page").not.toMatch(/async \(event, /);
    expect(handler).toMatch(/if \(!fromDeckPage\(event\) \|\| event\.senderFrame !== event\.sender\.mainFrame\) return null;/);
    expect(handler).toMatch(/if \(choosingFolder\) return null;/);
    expect(main).toMatch(/installTerminalKeysIpc\(\);\n\s+installFolderPickerIpc\(\);/);
  });

  it("asks the system for a folder, attached to the window once it is on screen, and adds nothing to the OS's recents", () => {
    expect(handler).toMatch(/await windowOnScreen\(ON_SCREEN_WAIT_MS\)/);
    expect(handler).toMatch(/properties: \["openDirectory", "dontAddToRecent"\]/);
    expect(handler).toMatch(/parent \? dialog\.showOpenDialog\(parent, options\) : dialog\.showOpenDialog\(options\)/);
    expect(handler).toMatch(/return out\.canceled \|\| !out\.filePaths\?\.length \? null : String\(out\.filePaths\[0\]\);/);
    // Counted as a question on screen, as ask()'s are, so the update notice waits.
    expect(handler).toMatch(/asking \+= 1;[\s\S]*asking -= 1;/);
  });
});

describe("chooseFolder", () => {
  const g = globalThis as Record<string, unknown>;
  afterEach(() => { delete g.window; });

  it("is not there in a browser, nor in an app older than the bridge", async () => {
    expect(canChooseFolder()).toBe(false);
    expect(await chooseFolder()).toBeUndefined();
    g.window = {};
    expect(canChooseFolder()).toBe(false);
    expect(await chooseFolder()).toBeUndefined();
  });

  it("hands back the folder chosen, null when the dialog closed without one, undefined when it failed", async () => {
    const choose = vi.fn();
    g.window = { ccdeckFolder: { choose } };
    expect(canChooseFolder()).toBe(true);
    choose.mockResolvedValueOnce("/home/u/code/api");
    expect(await chooseFolder()).toBe("/home/u/code/api");
    choose.mockResolvedValueOnce(null);
    expect(await chooseFolder()).toBeNull();
    choose.mockResolvedValueOnce({ path: "/not/a/string" });
    expect(await chooseFolder(), "anything but a path is no folder").toBeNull();
    choose.mockRejectedValueOnce(new Error("no handler"));
    expect(await chooseFolder()).toBeUndefined();
    expect(choose.mock.calls.every(c => c.length === 0), "the page names no folder").toBe(true);
  });
});
