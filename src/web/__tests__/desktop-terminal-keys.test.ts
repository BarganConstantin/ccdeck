// The desktop app's menu and the terminal pane's keys (#23's first half). On
// Windows and Linux the app's menu binds Ctrl+R (reload), Ctrl+W, Ctrl+Q and,
// through Edit, Ctrl+C, Ctrl+V, Ctrl+A and Ctrl+Z, and a menu shortcut is taken
// before the page sees the key: in the pane, Ctrl+R reloaded the deck instead
// of reaching Claude Code's history search. While the pane has the keys, the
// window ignores the menu's shortcuts. Read off the source, the way the other
// desktop bridges are pinned (notification-audio-store-1207.test.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tellDesktopKeys } from "../desktop-keys";

const desktop = (name: string) => readFileSync(fileURLToPath(new URL(`../../../desktop/${name}`, import.meta.url)), "utf8");
const web = (name: string) => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");

describe("the bridge", () => {
  const preload = desktop("preload.cjs");
  const main = desktop("main.mjs");

  it("exposes one call that carries a boolean and nothing else", () => {
    expect(preload.match(/exposeInMainWorld\("ccdeckTerminal"/g)).toHaveLength(1);
    expect(preload).toMatch(/keys: owned => ipcRenderer\.invoke\("ccdeck:terminal:keys", owned === true\)/);
  });

  it("answers only the deck's own page, in its main frame, and leaves macOS menus alone", () => {
    const handler = main.match(/function installTerminalKeysIpc\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(handler).toMatch(/if \(!fromDeckPage\(event\) \|\| event\.senderFrame !== event\.sender\.mainFrame\) return;/);
    expect(handler).toMatch(/if \(process\.platform === "darwin"\) return;/);
    expect(handler).toMatch(/event\.sender\.setIgnoreMenuShortcuts\(owned === true\)/);
    expect(main).toMatch(/installWindowChromeIpc\(\);\n\s+installTerminalKeysIpc\(\);/);
  });

  it("gives the menu its keys back when the page goes, not on a same-page navigation", () => {
    expect(main).toMatch(/contents\.on\("did-start-navigation", \(details\) => \{\n\s+if \(details\?\.isMainFrame && !details\.isSameDocument\) contents\.setIgnoreMenuShortcuts\(false\);/);
  });

  it("is told by the stage whenever the pane's keys change hands, and given back when the stage goes", () => {
    const stage = web("components/terminal/TerminalStage.tsx");
    expect(stage).toMatch(/useEffect\(\(\) => \{ tellDesktopKeys\(session\.keysOwner === "pane"\); \}, \[session\.keysOwner\]\);/);
    expect(stage).toMatch(/useEffect\(\(\) => \(\) => tellDesktopKeys\(false\), \[\]\);/);
  });
});

describe("tellDesktopKeys", () => {
  const g = globalThis as Record<string, unknown>;
  afterEach(() => { delete g.window; });

  it("passes the pane's ownership to the app as a boolean", () => {
    const keys = vi.fn(() => Promise.resolve());
    g.window = { ccdeckTerminal: { keys } };
    tellDesktopKeys(true);
    tellDesktopKeys(false);
    expect(keys.mock.calls).toEqual([[true], [false]]);
  });

  it("does nothing in a browser, and swallows an app that refuses", async () => {
    g.window = {};
    expect(() => tellDesktopKeys(true)).not.toThrow();
    g.window = { ccdeckTerminal: { keys: () => Promise.reject(new Error("no handler")) } };
    expect(() => tellDesktopKeys(true)).not.toThrow();
    g.window = { ccdeckTerminal: { keys: () => { throw new Error("old app"); } } };
    expect(() => tellDesktopKeys(true)).not.toThrow();
    await Promise.resolve();
  });
});
