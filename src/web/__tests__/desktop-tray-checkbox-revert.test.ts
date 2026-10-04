// A tray checkbox whose toggle does not take goes back to what is true.
//
// Electron ticks a checkbox in the native menu before it calls the row's click
// handler. When the toggle then fails — "Start at login" that macOS's Login
// Items will not register, notifications whose POST to the deck fails during a
// restart — the next template says what it said before, the swap
// (tray-menu-swap.mjs) took that for "unchanged", and the menu kept claiming a
// state that was not true until some other row changed.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs, no types
import { createMenuSwap } from "../../../desktop/tray-menu-swap.mjs";
// @ts-expect-error — plain .mjs, no types
import { trayMenuItems } from "../../../desktop/tray-menu.mjs";

type Row = { label?: string; type?: string; checked?: boolean; click?: (item: Row) => void };

/** The tray as main.mjs wires it: its actions change what the app holds and
 *  then redraw, and the swap installs into a stand-in for Electron's Menu —
 *  a copy of each row whose click flips a checkbox and then calls the row's
 *  handler with it, as MenuItem does. */
function tray({ loginTakes = true, prefsAnswer = true } = {}) {
  let openAtLogin = false;
  let notifyOn: boolean | null = false;
  const menus: Row[][] = [];
  const on = new Proxy({
    setOpenAtLogin: (checked: boolean) => { if (loginTakes) openAtLogin = checked; swap.refresh(); },
    toggleNotifications: () => { if (prefsAnswer) notifyOn = !notifyOn; swap.refresh(); },
  } as Record<string, unknown>, { get: (o, k) => o[k as string] ?? (() => {}) });
  const swap = createMenuSwap({
    build: () => trayMenuItems({
      now: 0,
      snapshot: { icon: "idle", waiting: 0, running: 0, blocked: [] },
      deck: { port: 4317, version: "3.36.9" },
      starting: null, restarting: null, notifyOn, openAtLogin,
      appVersion: "3.36.9", update: { status: "current" }, incidents: [],
    }, on),
    install: (template: Row[]) => {
      menus.push(template.map(row => {
        const item: Row = { ...row };
        item.click = () => { if (item.type === "checkbox") item.checked = !item.checked; row.click?.(item); };
        return item;
      }));
    },
  });
  swap.refresh();
  const row = (label: string) => menus.at(-1)!.find(r => r.label === label)!;
  return { swap, menus, row, click: (label: string) => row(label).click!(row(label)) };
}

describe("a tray checkbox", () => {
  it("unticks itself again when Start at login does not take", () => {
    const t = tray({ loginTakes: false });
    t.click("Start at login");
    expect(t.row("Start at login").checked).toBe(false);
  });

  it("unticks itself again when the deck does not take Notifications while closed", () => {
    const t = tray({ prefsAnswer: false });
    t.click("Notifications while closed");
    expect(t.row("Notifications while closed").checked).toBe(false);
  });

  it("stays ticked when the toggle takes", () => {
    const t = tray();
    t.click("Start at login");
    expect(t.row("Start at login").checked).toBe(true);
    t.click("Notifications while closed");
    expect(t.row("Notifications while closed").checked).toBe(true);
  });

  it("is put right once, and the redraws after that leave the menu alone", () => {
    const t = tray({ loginTakes: false });
    t.click("Start at login");
    const menus = t.menus.length;
    t.swap.refresh();
    t.swap.refresh();
    expect(t.menus).toHaveLength(menus);
  });
});
