// The three switches the account notifications are governed by: one each, none
// tied to another or to "Notifications while closed", each saved like the
// menu's other settings, and all three held off by the launch veto.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import NotificationsSection from "../components/NotificationsSection";
import { accountNotifySettings, DEFAULTS } from "../../server/deck-prefs.mjs";
import { ACCOUNT_NOTIFY_DEFAULTS, accountNotifyFrom } from "../use-os-notifications";
import { ACCOUNT_NOTIFY_SWITCHES } from "../notify-reach";
import { WEB_DIR } from "./client-source";

describe("what each switch allows", () => {
  it("is its own answer, whatever the other two and the closed-deck switch say", () => {
    for (const notifySwap of [true, false]) {
      for (const notifyQuota of [true, false]) {
        for (const notifyReset of [true, false]) {
          for (const notifications of [true, false]) {
            expect(accountNotifySettings({ notifications, notifySwap, notifyQuota, notifyReset }, {}))
              .toEqual({ swap: notifySwap, quota: notifyQuota, reset: notifyReset });
          }
        }
      }
    }
  });

  it("is the default for a deck that saved nothing: the swap on, the quota two off", () => {
    expect(accountNotifySettings({}, {})).toEqual({ swap: true, quota: false, reset: false });
    expect(accountNotifySettings(null, {})).toEqual({ swap: true, quota: false, reset: false });
  });

  it("is nothing at all on a deck launched with AGENTS_DECK_NO_NOTIFY=1", () => {
    const all = { notifySwap: true, notifyQuota: true, notifyReset: true };
    expect(accountNotifySettings(all, { AGENTS_DECK_NO_NOTIFY: "1" })).toEqual({ swap: false, quota: false, reset: false });
  });
});

describe("the page's copy of them", () => {
  it("starts where the server starts, so the menu never draws a switch the deck does not hold", () => {
    expect(ACCOUNT_NOTIFY_DEFAULTS).toEqual({
      notifySwap: DEFAULTS.notifySwap, notifyQuota: DEFAULTS.notifyQuota, notifyReset: DEFAULTS.notifyReset,
    });
  });

  it("reads each from the prefs answer, and its default when the answer has no real boolean", () => {
    expect(accountNotifyFrom(undefined)).toEqual(ACCOUNT_NOTIFY_DEFAULTS);
    expect(accountNotifyFrom({ notifySwap: false, notifyQuota: true })).toEqual({ notifySwap: false, notifyQuota: true, notifyReset: false });
    expect(accountNotifyFrom({ notifyReset: "true" as unknown as boolean })).toEqual(ACCOUNT_NOTIFY_DEFAULTS);
  });

  it("names exactly the three fields the server keeps", () => {
    expect(ACCOUNT_NOTIFY_SWITCHES.map(s => s.kind)).toEqual(["notifySwap", "notifyQuota", "notifyReset"]);
    for (const { kind } of ACCOUNT_NOTIFY_SWITCHES) expect(typeof DEFAULTS[kind], kind).toBe("boolean");
  });
});

// The three switches moved from the sound popover to Settings › Notifications
// (2026-10-07), whole: the same markup, the same state, the same press.
describe("Settings › Notifications", () => {
  const menu = readFileSync(`${WEB_DIR}components/NotificationsSection.tsx`, "utf8");
  const hook = readFileSync(`${WEB_DIR}use-os-notifications.ts`, "utf8");

  it("draws a real switch for each, bound to its own state and its own press", () => {
    expect(menu).toMatch(/ACCOUNT_NOTIFY_SWITCHES\.map\(/);
    expect(menu).toMatch(/role="switch"\s+aria-checked=\{accountNotify\[kind\]\}/);
    expect(menu).toMatch(/onClick=\{\(\) => onToggleAccountNotify\(kind\)\}/);
  });

  it("saves a press as that one field, the way the switch above it is saved", () => {
    expect(hook).toMatch(/fetch\("\/api\/prefs", \{\s*method: "POST",[\s\S]{0,120}body: JSON\.stringify\(\{ \[kind\]: want \}\)/);
  });
});

describe("Settings › Notifications, drawn", () => {
  const draw = (accountNotify: Record<string, boolean>, notifyVetoed = false) => renderToStaticMarkup(createElement(NotificationsSection, {
    notifyOn: false, onToggleNotify: () => {}, notifyVetoed, notifyPermission: "default", onAskNotify: () => {},
    accountNotify, onToggleAccountNotify: () => {},
  } as Parameters<typeof NotificationsSection>[0]));
  const state = (html: string, kind: string) =>
    new RegExp(`role="switch" aria-checked="(true|false)" aria-labelledby="sm-${kind}-label"`).exec(html)?.[1];

  it("shows each switch as its own state", () => {
    const html = draw({ notifySwap: true, notifyQuota: false, notifyReset: true });
    expect(state(html, "notifySwap")).toBe("true");
    expect(state(html, "notifyQuota")).toBe("false");
    expect(state(html, "notifyReset")).toBe("true");
    expect(html).toContain('id="sm-notifySwap-label">Account auto-switched<');
    expect(html).toContain('id="sm-notifyQuota-label">Quota at 90% and 100%<');
    expect(html).toContain('id="sm-notifyReset-label">Quota reset<');
    expect(html).toContain("For the Claude and Codex accounts you&#x27;re on, whether or not the deck is open.");
  });

  it("says they are held off too when the machine vetoed notifications", () => {
    expect(draw(ACCOUNT_NOTIFY_DEFAULTS, true)).toContain("Held off for this run too.");
  });
});

describe("the way to the desktop app", () => {
  it("asks for silence only for a notification that wants it, and leaves the others as they were", async () => {
    const { notifyTrays, trayClients } = await import("../../server/sse-clients.mjs");
    const frames: string[] = [];
    const app = { write: (f: string) => { frames.push(f); return true; }, writableLength: 0 };
    trayClients.add(app);
    try {
      notifyTrays("vcrm — ccdeck", "Finished its turn", { chime: "done", who: "vcrm" });
      notifyTrays("Claude auto-switch — ccdeck", "Switched to work", { chime: null, who: "Claude auto-switch", silent: true });
    } finally {
      trayClients.delete(app);
    }
    const data = frames.map(f => JSON.parse(/^data: (.*)$/m.exec(f)![1]));
    expect(data).toEqual([
      { title: "vcrm", body: "Finished its turn", chime: "done" },
      { title: "Claude auto-switch", body: "Switched to work", chime: null, silent: true },
    ]);
  });

  it("is shown silently by the app when the deck says so, and with its tone otherwise", () => {
    const main = readFileSync(new URL("../../../desktop/main.mjs", import.meta.url), "utf8");
    expect(main).toMatch(/function showNotification\(\{ title, body, chime, silent \}\)/);
    expect(main).toContain("const quiet = silent === true;");
    expect(main).toContain("sound: quiet ? undefined : sound, silent: quiet");
  });
});
