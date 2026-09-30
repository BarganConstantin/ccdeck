// The tray menu stays open while somebody is reading it.
//
// Every redraw used to hand the tray a new menu — each ten-second tick and
// each burst of hook events — and on Linux a new menu closes the one that is
// open, often before the pressed row takes the click. Now it is replaced only
// when what it says changes, and never while it is open (tray-menu-swap.mjs).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs, no types
import { createMenuSwap, menuSignature, MENU_HOLD_MS } from "../../../desktop/tray-menu-swap.mjs";
// @ts-expect-error — plain .mjs, no types
import { trayMenuItems } from "../../../desktop/tray-menu.mjs";

type Row = Record<string, unknown>;

/** A swap over a template the test changes, with a clock and a timer it
 *  drives by hand. */
function harness(first: Row[]) {
  let template = first;
  let t = 1_000;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const installed: Row[][] = [];
  let on: { opened: () => void; closed: () => void } | null = null;
  const swap = createMenuSwap({
    build: () => template,
    install: (tpl: Row[], callbacks: { opened: () => void; closed: () => void }) => { installed.push(tpl); on = callbacks; },
    now: () => t,
    later: (fn: () => void, ms: number) => { const timer = { at: t + ms, fn }; timers.push(timer); return timer; },
    cancel: (timer: unknown) => { const i = timers.indexOf(timer as never); if (i >= 0) timers.splice(i, 1); },
  });
  return {
    swap,
    installed,
    set: (next: Row[]) => { template = next; },
    open: () => on!.opened(),
    close: () => on!.closed(),
    advance: (ms: number) => {
      t += ms;
      for (const timer of timers.filter(x => x.at <= t)) { timers.splice(timers.indexOf(timer), 1); timer.fn(); }
    },
  };
}

const idle = (update = "Check for updates"): Row[] => [
  { label: "Idle", enabled: false },
  { type: "separator" },
  { label: update, click: () => {} },
  { label: "Quit ccdeck", click: () => {} },
];

describe("when the tray is handed a new menu", () => {
  it("not at all while nothing it says has changed, however often the app redraws", () => {
    const h = harness(idle());
    expect(h.swap.refresh()).toBe("installed");
    // A ten-second tick, and a burst of hook events that moved no count.
    for (let i = 0; i < 50; i++) h.swap.refresh();
    h.set(idle());          // a fresh template, new click closures, same words
    h.swap.refresh();
    expect(h.installed).toHaveLength(1);
  });

  it("as soon as a row's words or state change, while it is closed", () => {
    const h = harness(idle());
    h.swap.refresh();
    h.set(idle("Checking for updates…"));
    expect(h.swap.refresh()).toBe("installed");
    expect(h.installed.at(-1)![2]).toMatchObject({ label: "Checking for updates…" });
  });

  it("never while it is open: the change waits, and lands once it closes", () => {
    const h = harness(idle());
    h.swap.refresh();
    h.open();
    h.set(idle("Up to date — check again"));
    expect(h.swap.refresh()).toBe("held");
    expect(h.swap.refresh()).toBe("held");
    expect(h.installed).toHaveLength(1);
    h.close();
    expect(h.installed).toHaveLength(2);
    expect(h.installed[1][2]).toMatchObject({ label: "Up to date — check again" });
  });

  it("builds the menu at the close from the state then, not the state it was held at", () => {
    const h = harness(idle());
    h.swap.refresh();
    h.open();
    h.set(idle("Checking for updates…"));
    h.swap.refresh();
    h.set(idle("Up to date — check again"));
    h.close();
    expect(h.installed.map(t => t[2].label)).toEqual(["Check for updates", "Up to date — check again"]);
  });

  it("puts a held change in after MENU_HOLD_MS if the panel never says the menu closed", () => {
    const h = harness(idle());
    h.swap.refresh();
    h.open();
    h.set(idle("Restart to update to v3.34.0"));
    h.swap.refresh();
    h.advance(MENU_HOLD_MS - 1);
    expect(h.installed).toHaveLength(1);
    h.advance(1);
    expect(h.installed).toHaveLength(2);
    expect(h.swap.open).toBe(false);
  });

  it("does nothing at a close when nothing was held", () => {
    const h = harness(idle());
    h.swap.refresh();
    h.open();
    h.close();
    expect(h.installed).toHaveLength(1);
  });
});

describe("what counts as a change", () => {
  const menu = (state: Partial<Record<string, unknown>>) => trayMenuItems({
    now: 10 * 60_000,
    snapshot: { icon: "idle", waiting: 0, running: 0, blocked: [] },
    deck: { port: 4317, version: "3.34.0" },
    starting: null, restarting: null, notifyOn: true, openAtLogin: false,
    appVersion: "3.34.0", update: { status: "current" }, incidents: [],
    ...state,
  }, new Proxy({}, { get: () => () => {} }));

  it("is the rows' words and states, not the functions behind them", () => {
    expect(menuSignature(menu({}))).toBe(menuSignature(menu({})));
    expect(menuSignature(menu({ notifyOn: false }))).not.toBe(menuSignature(menu({})));
    expect(menuSignature(menu({ update: { status: "checking" } }))).not.toBe(menuSignature(menu({})));
    expect(menuSignature(menu({ snapshot: { icon: "busy", waiting: 0, running: 2, blocked: [] } }))).not.toBe(menuSignature(menu({})));
  });

  it("moves with a waiting session's minutes, and not in between", () => {
    const waitingSince = (now: number) => menu({ now, snapshot: { icon: "waiting", waiting: 1, running: 0, blocked: [{ label: "ccdeck", kind: "asked", since: 0 }] } });
    expect(menuSignature(waitingSince(3 * 60_000))).toBe(menuSignature(waitingSince(3 * 60_000 + 10_000)));
    expect(menuSignature(waitingSince(4 * 60_000))).not.toBe(menuSignature(waitingSince(3 * 60_000)));
  });
});

describe("main.mjs", () => {
  const main = readFileSync(fileURLToPath(new URL("../../../desktop/main.mjs", import.meta.url)), "utf8");
  const code = main.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("hands the tray a menu only through the swap, which hears when it opens and closes", () => {
    expect(code.match(/setContextMenu\(/g)).toHaveLength(1);
    const install = code.slice(code.indexOf("createMenuSwap({"), code.indexOf("menuSwap.refresh();"));
    expect(install).toContain('menu.on("menu-will-show", opened)');
    expect(install).toContain('menu.on("menu-will-close", closed)');
    expect(install).toContain("tray.setContextMenu(menu)");
    const redraw = code.slice(code.indexOf("function scheduleRedraw"), code.indexOf("}, 150);"));
    expect(redraw).toContain("menuSwap?.refresh()");
    expect(redraw).not.toContain("setContextMenu");
  });
});
