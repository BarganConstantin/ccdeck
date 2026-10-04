// The tray's words and rows (#1160, #1163), run rather than read.
//
// The menu used to be written inline in desktop/main.mjs, which imports
// electron at its first line, so the only way the suite could check it was by
// slicing the source text. It is a function of the app's state now
// (desktop/tray-menu.mjs), and these call it.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ago, statusLine, trayMenuItems, updateItem } from "../../../desktop/tray-menu.mjs";

type Item = { label?: string; type?: string; enabled?: boolean; checked?: boolean; click?: (item?: unknown) => unknown };

const NOW = 1_790_550_000_000;
const MIN = 60_000;
const deck = { pid: 1, port: 4317, token: "t", version: "3.29.10" };
const quiet = { icon: "idle", waiting: 0, running: 0, title: "ccdeck", blocked: [] as unknown[] };

function actions() {
  return {
    openWindow: vi.fn(), startDeck: vi.fn(), openInBrowser: vi.fn(), toggleNotifications: vi.fn(),
    setOpenAtLogin: vi.fn(), restartToUpdate: vi.fn(), checkForUpdates: vi.fn(), restartDeck: vi.fn(), quit: vi.fn(),
  };
}

function menu(over: Record<string, unknown> = {}, on = actions()): Item[] {
  return trayMenuItems({
    now: NOW, snapshot: quiet, deck, starting: null, restarting: null, notifyOn: true,
    openAtLogin: false, appVersion: "3.29.10", update: { status: "idle" }, ...over,
  }, on);
}
const labels = (items: Item[]) => items.map(i => i.label ?? `(${i.type})`);
const row = (items: Item[], label: string) => items.find(i => i.label === label);

describe("the line under the icon", () => {
  const s = (over: Record<string, unknown>) =>
    statusLine({ restarting: null, starting: null, deck, snapshot: quiet, ...over });

  it("says what the app is doing before what the deck is", () => {
    // A restart outranks a start, and both outrank a deck that is gone or
    // unreachable: the app is the one mid-way through something.
    expect(s({ restarting: NOW, starting: Promise.resolve() })).toBe("Restarting the deck…");
    expect(s({ starting: Promise.resolve(), deck: null })).toBe("Starting the deck…");
    expect(s({ deck: null })).toBe("No deck running");
    expect(s({ snapshot: { ...quiet, icon: "offline", waiting: 2 } })).toBe("Reconnecting to the deck…");
  });

  it("puts sessions waiting on the person ahead of sessions running", () => {
    expect(s({ snapshot: { ...quiet, waiting: 1, running: 3 } })).toBe("1 session waiting for you");
    expect(s({ snapshot: { ...quiet, waiting: 2 } })).toBe("2 sessions waiting for you");
    expect(s({ snapshot: { ...quiet, running: 1 } })).toBe("1 session running");
    expect(s({ snapshot: { ...quiet, running: 4 } })).toBe("4 sessions running");
    expect(s({})).toBe("Idle");
  });
});

describe("how long a session has been waiting", () => {
  it("is minutes under an hour and hours from there, never negative", () => {
    expect(ago(0)).toBe("0m");
    expect(ago(3 * MIN)).toBe("3m");
    expect(ago(59 * MIN)).toBe("59m");
    expect(ago(59.6 * MIN)).toBe("1h");
    expect(ago(125 * MIN)).toBe("2h");
    expect(ago(-5 * MIN)).toBe("0m");
  });
});

describe("the tray menu", () => {
  it("lists at most six sessions waiting, each saying why and for how long", () => {
    const blocked = Array.from({ length: 8 }, (_, i) => ({
      label: `s${i}`, kind: i % 2 ? "asked" : "permission", since: NOW - (i * 40 + 3) * MIN,
    }));
    const items = menu({ snapshot: { ...quiet, waiting: 8, blocked } });
    expect(labels(items).slice(0, 8)).toEqual([
      "8 sessions waiting for you",
      "s0 — needs permission, 3m", "s1 — asking, 43m", "s2 — needs permission, 1h",
      "s3 — asking, 2h", "s4 — needs permission, 3h", "s5 — asking, 3h",
      "(separator)",
    ]);
    expect(items[0].enabled).toBe(false);
  });

  it("offers to start a deck only while there is none and none is starting", () => {
    expect(labels(menu({ deck: null }))).toContain("Start the deck");
    expect(labels(menu({ deck: null, starting: Promise.resolve() }))).not.toContain("Start the deck");
    expect(labels(menu())).not.toContain("Start the deck");
  });

  it("opens the deck only when there is one", () => {
    for (const label of ["Open ccdeck", "Open in browser"]) {
      expect(row(menu(), label)?.enabled, label).toBe(true);
      expect(row(menu({ deck: null }), label)?.enabled, label).toBe(false);
    }
  });

  it("shows the deck's own notification switch, and greys it out until it has been read", () => {
    const n = (over: Record<string, unknown>) => row(menu(over), "Notifications while closed");
    expect(n({ notifyOn: true })).toMatchObject({ type: "checkbox", checked: true, enabled: true });
    expect(n({ notifyOn: false })).toMatchObject({ checked: false, enabled: true });
    expect(n({ notifyOn: null })).toMatchObject({ checked: false, enabled: false });
    expect(n({ deck: null })).toMatchObject({ enabled: false });
    expect(row(menu({ openAtLogin: true }), "Start at login")).toMatchObject({ type: "checkbox", checked: true });
  });

  it("names the deck's version beside the app's only when the two differ", () => {
    expect(labels(menu())).toContain("ccdeck v3.29.10");
    expect(labels(menu({ deck: { ...deck, version: "3.28.0" } }))).toContain("ccdeck v3.29.10 · deck v3.28.0");
    expect(labels(menu({ deck: { ...deck, version: "" } }))).toContain("ccdeck v3.29.10");
    expect(labels(menu({ deck: null }))).toContain("ccdeck v3.29.10");
  });

  it("restarts only while there is a deck to restart, from the row above Quit (#1163)", () => {
    const items = labels(menu());
    expect(items.indexOf("Restart ccdeck")).toBe(items.indexOf("Quit ccdeck") - 1);
    expect(row(menu(), "Restart ccdeck")?.enabled).toBe(true);
    for (const over of [{ deck: null }, { starting: Promise.resolve() }, { restarting: NOW }]) {
      expect(row(menu(over), "Restart ccdeck")?.enabled, JSON.stringify(Object.keys(over))).toBe(false);
    }
    expect(row(menu({ deck: null }), "Quit ccdeck")?.enabled).toBeUndefined();
  });

  it("hands every click to the action it names, and Start at login the box's new state", () => {
    const on = actions();
    const items = menu({ deck: null, snapshot: { ...quiet, blocked: [{ label: "a", kind: "asked", since: NOW }] } }, on);
    const click = (label: string, arg?: unknown) => items.find(i => i.label?.startsWith(label))?.click?.(arg);
    click("a — asking");
    click("Start the deck");
    click("Open ccdeck");
    click("Open in browser");
    click("Notifications while closed");
    click("Start at login", { checked: true });
    click("Check for updates");
    click("Restart ccdeck");
    click("Quit ccdeck");
    expect(on.openWindow).toHaveBeenCalledTimes(2);
    expect(on.startDeck).toHaveBeenCalledTimes(1);
    expect(on.openInBrowser).toHaveBeenCalledTimes(1);
    expect(on.toggleNotifications).toHaveBeenCalledTimes(1);
    expect(on.setOpenAtLogin).toHaveBeenCalledWith(true);
    expect(on.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(on.restartDeck).toHaveBeenCalledTimes(1);
    expect(on.quit).toHaveBeenCalledTimes(1);
    expect(on.restartToUpdate).not.toHaveBeenCalled();
  });
});

describe("the update row", () => {
  it("says where the update is, and offers only what can be done now", () => {
    const on = actions();
    const ready = updateItem({ status: "ready", version: "3.30.0" }, on);
    expect(ready.label).toBe("Restart to update to v3.30.0");
    ready.click();
    expect(on.restartToUpdate).toHaveBeenCalledTimes(1);
    expect(updateItem({ status: "downloading", version: "3.30.0" }, on)).toEqual({ label: "Downloading ccdeck v3.30.0…", enabled: false });
    expect(updateItem({ status: "checking" }, on)).toEqual({ label: "Checking for updates…", enabled: false });
    expect(updateItem({ status: "current" }, on).label).toBe("Up to date — check again");
    expect(updateItem({ status: "idle" }, on).label).toBe("Check for updates");
    // A failure is said (desktop-update-failed-tray.test.ts), and still checks again.
    expect(updateItem({ status: "error" }, on).label).toBe("Update failed — try again");
    updateItem({ status: "error" }, on).click();
    expect(on.checkForUpdates).toHaveBeenCalledTimes(1);
  });
});

describe("the app's wiring", () => {
  const main = readFileSync(fileURLToPath(new URL("../../../desktop/main.mjs", import.meta.url)), "utf8");

  it("draws the menu and the tooltip from tray-menu.mjs, with the app's live state", () => {
    expect(main).toContain('import { statusLine, statusWorthAsking, trayMenuItems } from "./tray-menu.mjs";');
    // buildMenu gives the template; the tray menu is built from it, and only
    // from it, where tray-menu-swap.mjs installs a new one.
    expect(main).toMatch(/function buildMenu\(\) \{\s*return trayMenuItems\(\{[\s\S]*?\}, TRAY_ACTIONS\);\s*\}/);
    expect(main).toContain("build: buildMenu,");
    expect(main).toContain("const menu = Menu.buildFromTemplate(template);");
    expect(main).toContain("tray.setToolTip(`${snapshot.title} — ${statusLine({ restarting, starting, deck, snapshot })}`);");
    // Nothing of the menu is left written out in main.mjs to drift from it.
    expect(main).not.toMatch(/label: "(?:Restart ccdeck|Quit ccdeck|Start at login|Open in browser)"/);
  });

  it("reads the deck and the updater when a row is clicked, not when the menu was drawn", () => {
    // A menu drawn before a restart and clicked after it must open the deck
    // that is there now — the action reads `deck` itself.
    expect(main).toContain("openInBrowser: () => deck && shell.openExternal(`http://127.0.0.1:${deck.port}/`),");
    expect(main).toContain("restartToUpdate: () => updater.restartNow(),");
    expect(main).toContain("checkForUpdates: () => updater?.check(),");
  });

  it("ships inside the app", () => {
    const config = readFileSync(fileURLToPath(new URL("../../../desktop/electron-builder.config.cjs", import.meta.url)), "utf8");
    expect(config).toMatch(/"tray-menu\.mjs"/);
  });
});
