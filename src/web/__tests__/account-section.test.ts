// Settings › Account (hidden): absent from a deck without the account, and
// each of its states saying its own sentences when it is there.
//
// No DOM in this suite, so the markup is drawn with renderToStaticMarkup —
// the section's pure half (AccountPanel) for each answer /api/account can
// give, and the dialog itself for whether the section is in the nav at all.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountPanel, ACCOUNT_MSGS, expiresIn, PROBLEM_MSGS, STORAGE_MSGS, statusLine } from "../components/AccountSection";
import { en } from "../i18n/en";
import { resetLanguageForTest, setLanguage } from "../i18n";
import { catalogFor } from "../i18n/catalogs";
import SettingsModal, { type SettingsModalProps } from "../components/SettingsModal";
import type { AccountView, SyncView } from "../account-bridge";
import { settingsSections, SETTINGS_SECTIONS } from "../settings";
import { sourceOf } from "./client-source";
import { DEFAULT_PREFS } from "../sound";
import { ACCOUNT_NOTIFY_DEFAULTS } from "../use-os-notifications";

const noop = () => {};
const asyncNoop = async () => {};
const NOW = Date.parse("2026-10-18T09:00:00Z");

// CHANGED ON PURPOSE (the UI in every language): the section's sentences are
// keys now, so these tests read each one through the English catalog.
const ACCOUNT_COPY = Object.fromEntries(Object.entries(ACCOUNT_MSGS).map(([name, key]) => [name, en[key]])) as Record<keyof typeof ACCOUNT_MSGS, string>;
const PROBLEM_COPY = Object.fromEntries(Object.entries(PROBLEM_MSGS).map(([name, key]) => [name, en[key]])) as Record<string, string>;
const STORAGE_COPY = Object.fromEntries(Object.entries(STORAGE_MSGS).map(([name, key]) => [name, en[key]])) as Record<string, string>;

function settingsProps(over: Partial<SettingsModalProps> = {}): SettingsModalProps {
  return {
    section: "general", onSection: noop, onClose: noop,
    providers: { kind: "reported", claude: true, codex: true },
    sound: { soundOn: true, toggleSound: noop, setSound: noop, activateSoundRef: { current: noop }, soundOnRef: { current: true } },
    tones: { tonePrefs: DEFAULT_PREFS, setTonePrefs: noop, tonePrefsRef: { current: DEFAULT_PREFS }, previewTone: noop, changeTone: noop },
    customTones: {
      customSelections: { done: null, "needs-input": null }, customSelectionsRef: { current: { done: null, "needs-input": null } },
      customAssets: [], clearCustomOnly: noop, fallbackCustomRef: { current: null }, selectCustomTone: noop,
      importNotificationAudio: asyncNoop, createNotificationVoice: asyncNoop, renameCustomAsset: asyncNoop,
      deleteCustomAsset: asyncNoop, previewCustomAsset: noop,
    },
    notify: {
      notifyPermission: "default", notifySaid: new Set(), notifyOn: false, notifyVetoed: false, toggleNotify: noop,
      notifySupported: true, askForNotifications: noop, loadNotifyPrefs: noop, accountNotify: ACCOUNT_NOTIFY_DEFAULTS, toggleAccountNotify: noop,
    },
    appearance: { theme: "dark", setTheme: noop, characterEnabled: true, setCharacterEnabled: noop },
    versionCheck: { version: null, notice: null, noticeOpen: false, showNotice: noop, dismissNotice: noop, versionChecking: false, loadVersion: async () => null },
    desktopUpdate: { desktopUpdateRestarting: false, desktopUpdateFailure: null, readyAppUpdate: null, appUpdate: null, askDesktopUpdateRestart: asyncNoop, onDesktopUpdateEvent: noop },
    restart: { autoRestart: true, toggleAutoRestart: noop },
    doors: { whatsNew: noop, update: noop, tour: noop, feedback: noop, accounts: noop, localNetwork: noop, browserWatch: noop },
    ...over,
  } as unknown as SettingsModalProps;
}
const tabs = (html: string) => [...html.matchAll(/role="tab" id="settings-tab-([a-z]+)"/g)].map(m => m[1]);

const sync = (over: Partial<SyncView> = {}): SyncView => ({
  mode: "independent", overrides: ["sound"], profileId: "p", savedRevision: 4, appliedRevision: 3,
  adopt: { revision: 4, values: {} }, pending: null, conflict: null, apply: null, askUploadForNewAccount: false,
  initialUpload: false, saving: "idle", skipped: null, ...over,
});
const view = (over: Partial<AccountView> = {}): AccountView => ({
  enabled: true, vetoed: false, state: "disconnected", connect: null, account: null, device: null,
  suggestedName: "laptop-a", tokenStorage: "keychain", status: null, sync: null, revokedReason: null, problem: null, ...over,
});
const connected = (s: Partial<SyncView> = {}, over: Partial<AccountView> = {}) => view({
  state: "connected", account: { email: "me@example.com" },
  device: { id: "0199f0a2-6c1e-7b3a-9d2e-5b8f3c1a7e40", name: "laptop-a", consoleUrl: "https://app.ccdeck.dev/machines/0199f0a2-6c1e-7b3a-9d2e-5b8f3c1a7e40" },
  status: { lastSentAt: "2026-10-18T09:00:03.000Z", lastResult: "ok", nextAt: "2026-10-18T09:00:18.000Z", everySec: 15 },
  sync: sync(s), ...over,
});
const draw = (v: AccountView | null, vetoed = false) => renderToStaticMarkup(createElement(AccountPanel, { view: v, vetoed, now: NOW }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("Settings with the account off", () => {
  it("has no Account section, in the nav, the panes or the search", () => {
    expect(tabs(renderToStaticMarkup(createElement(SettingsModal, settingsProps())))).not.toContain("account");
    expect(SETTINGS_SECTIONS.map(s => s.id)).not.toContain("account");
    expect(settingsSections().map(s => s.id)).not.toContain("account");
    // A door that names the hidden section on such a deck lands on General.
    const html = renderToStaticMarkup(createElement(SettingsModal, settingsProps({ section: "account" })));
    expect(html).toMatch(/<h2 class="settings-pane-title">General<\/h2>/);
  });

  it("loads the section's code only through the lazy import", () => {
    const modal = sourceOf("components/SettingsModal.tsx");
    expect(modal).toContain('lazy(() => import("./AccountSection"))');
    expect(modal).not.toMatch(/^import .*AccountSection/m);
    const app = sourceOf("App.tsx");
    expect(app).toContain('lazy(() => import("./components/AccountBridge"))');
    expect(app).not.toMatch(/^import .*(AccountBridge|use-account")/m);
  });
});

describe("Settings with the account on", () => {
  it("draws Account before About, which stays last", () => {
    const html = renderToStaticMarkup(createElement(SettingsModal, settingsProps({ account: { on: true, vetoed: false } })));
    const order = tabs(html);
    expect(order.slice(-2)).toEqual(["account", "about"]);
    // Every other tab is the one this deck draws with the account off.
    const off = tabs(renderToStaticMarkup(createElement(SettingsModal, settingsProps())));
    expect(order).toEqual([...off.slice(0, -1), "account", "about"]);
  });

  it("draws it for a deck asked for one and vetoed, to say so", () => {
    expect(tabs(renderToStaticMarkup(createElement(SettingsModal, settingsProps({ account: { on: false, vetoed: true } }))))).toContain("account");
  });
});

describe("each state says its own sentences", () => {
  it("vetoed: off on this machine, and why", () => {
    expect(text(draw(null, true))).toContain(ACCOUNT_COPY.vetoed);
  });

  it("before the deck has answered", () => {
    expect(text(draw(null))).toContain(ACCOUNT_COPY.loading);
  });

  it("not connected: what connecting does, what is sent, the name to appear as, and Connect", () => {
    const t = text(draw(view()));
    expect(t).toContain(ACCOUNT_COPY.explain);
    expect(t).toContain(ACCOUNT_COPY.sent);
    expect(t).toContain("This deck will appear as");
    expect(draw(view())).toContain('value="laptop-a"');
    expect(t).toContain("Connect account");
    expect(t).toContain("stored in your keychain");
  });

  it("not connected, with what went wrong last time", () => {
    for (const [problem, said] of Object.entries(PROBLEM_COPY)) {
      if (problem === "keychain-locked") continue;
      expect(text(draw(view({ problem }))), problem).toContain(said);
    }
    expect(text(draw(view({ problem: "api-disabled" })))).toContain("Accounts are not open yet.");
  });

  it("connecting: the code, the page again, Cancel, and the time left", () => {
    const html = draw(view({
      state: "connecting",
      connect: { userCode: "WDJB-MJHT", verificationUri: "https://app.ccdeck.dev/connect", verificationUriComplete: "https://app.ccdeck.dev/connect?code=WDJB-MJHT", expiresAt: new Date(NOW + 9 * 60_000 + 42_000).toISOString() },
    }));
    const t = text(html);
    expect(t).toContain("WDJB-MJHT");
    expect(t).toContain(ACCOUNT_COPY.connecting);
    expect(t).toContain("Open the page again");
    expect(html).toContain('href="https://app.ccdeck.dev/connect?code=WDJB-MJHT"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(t).toContain("Cancel");
    expect(t).toContain("expires in 9:42");
    expect(expiresIn(new Date(NOW - 1).toISOString(), NOW)).toBe("0:00");
  });

  it("connecting, with a page the deck will not open: no link", () => {
    const html = draw(view({ state: "connecting", connect: { userCode: "WDJB-MJHT", verificationUri: "http://evil.example/", verificationUriComplete: "http://evil.example/?code=x", expiresAt: new Date(NOW + 60_000).toISOString() } }));
    expect(html).not.toContain("evil.example");
  });

  it("connected: the account, the device and its page, the status, the token's home, the sync, Disconnect", () => {
    const html = draw(connected());
    const t = text(html);
    expect(t).toContain("me@example.com");
    expect(t).toContain("This deck: laptop-a");
    expect(t).toContain("Open in Machines");
    expect(html).toContain('href="https://app.ccdeck.dev/machines/0199f0a2-6c1e-7b3a-9d2e-5b8f3c1a7e40"');
    expect(t).toMatch(/Status: sent .* · every 15 s\./);
    expect(t).toContain(STORAGE_COPY.keychain);
    expect(t).toContain("This deck only");
    expect(t).toContain("Saved r4 · Applied r3");
    expect(t).toContain("Share settings…");
    expect(t).toContain("Disconnect…");
  });

  it("connected and offline", () => {
    expect(text(draw(connected({}, { status: { lastSentAt: "2026-10-18T09:00:03.000Z", lastResult: "offline", nextAt: null, everySec: 15 } })))).toContain("Offline, retrying.");
    expect(text(draw(connected({}, { tokenStorage: "file" })))).toContain("Stored in a file only you can read.");
    expect(text(draw(connected({}, { problem: "keychain-locked" })))).toContain(PROBLEM_COPY["keychain-locked"]);
  });

  it("shared, with an edit pending while offline", () => {
    const t = text(draw(connected({ mode: "shared", pending: { since: "2026-10-18T09:00:00Z", keys: ["theme", "density"] }, saving: "offline" })));
    expect(t).toContain("Shared with your other decks");
    expect(t).toContain("sound stays on this deck");
    expect(t).toContain("Stop sharing");
    expect(t).toContain("Theme, Density. Will save when back online.");
  });

  it("with a conflict: changed elsewhere, Use latest, Review", () => {
    const t = text(draw(connected({
      pending: { since: "2026-10-18T09:00:00Z", keys: ["theme"] },
      conflict: { latest: { revision: 15, values: { theme: "nord" }, updatedBy: { kind: "device", name: "desktop-a" } }, mine: { theme: "paper" } },
    })));
    expect(t).toContain("Changed elsewhere");
    expect(t).toContain("r15 from desktop-a");
    expect(t).toContain("Use latest");
    expect(t).toContain("Review");
    expect(t).not.toContain("Will save when back online");
  });

  it("connected to a different account: nothing uploaded until asked", () => {
    const t = text(draw(connected({ askUploadForNewAccount: true })));
    expect(t).toContain("Save this deck's settings to me@example.com");
    expect(t).toContain("Nothing is uploaded until you say so");
  });

  it("with a theme this version does not have", () => {
    expect(text(draw(connected({ skipped: { theme: "nord" } })))).toContain("The theme “nord” is not in this version of ccdeck");
  });

  it("removed in the console, and the account deleted", () => {
    const t = text(draw(view({ state: "revoked", account: { email: "me@example.com" }, revokedReason: "device_revoked" })));
    expect(t).toContain(ACCOUNT_COPY.revoked);
    expect(t).toContain("Connect again");
    expect(text(draw(view({ state: "revoked", revokedReason: "account_gone" })))).toContain(ACCOUNT_COPY.accountGone);
  });

  it("a sign-in that could not be found", () => {
    expect(text(draw(view({ state: "error", problem: "token-missing" })))).toContain(ACCOUNT_COPY.tokenMissing);
  });

  it("never promises encryption it does not have", () => {
    for (const html of [draw(view()), draw(connected()), draw(connected({ mode: "shared" }))]) {
      expect(text(html)).not.toMatch(/end-to-end|end to end|e2e/i);
    }
    // And it says plainly that the server can read what is sent.
    expect(ACCOUNT_COPY.sent).toContain("which can read them");
  });
});

describe("the section's words read through keys, so they follow the language", () => {
  it("each sentence is a key the English catalog maps to the words it has always shown", () => {
    for (const msgs of [ACCOUNT_MSGS, PROBLEM_MSGS, STORAGE_MSGS]) {
      for (const [name, key] of Object.entries(msgs)) {
        expect(typeof key, name).toBe("string");
        expect(en[key], `${name} -> ${key}`).toMatch(/\S/);
        expect(en[key], `${name} is a key, not the words`).not.toBe(key);
      }
    }
    expect(ACCOUNT_COPY).toEqual({
      vetoed: "Off on this machine: the deck was started with AGENTS_DECK_NO_ACCOUNT=1 or AGENTS_DECK_NO_INSTALL=1, which keep it away from any account.",
      loading: "Reading this deck's account…",
      unreachable: "The deck did not answer. It may be restarting.",
      explain: "Connect this deck to your ccdeck account to see it in Machines at app.ccdeck.dev, and to keep the settings you choose in step with your other decks.",
      sent: "While connected it sends, every 15 seconds: its name, version and system, CPU and memory use, and how many sessions are running or waiting on you. Never what your sessions do, their names, your files or your Claude accounts. What it sends, and the settings you sync, are kept on ccdeck's server, which can read them.",
      nameNote: "How this deck is listed in your account. Change it before connecting if you would rather not use this computer's name.",
      connecting: "Approve this deck in the browser. Check that the code there matches this one.",
      revoked: "This deck was removed from your account at app.ccdeck.dev.",
      accountGone: "The ccdeck account this deck was connected to was deleted.",
      disconnectNote: "It stops sending status and syncing settings. Its settings stay as they are.",
      tokenMissing: "This deck's sign-in could not be found. Connect it again.",
    });
    expect(PROBLEM_COPY).toEqual({
      "api-disabled": "Accounts are not open yet.",
      offline: "Could not reach ccdeck. Check the connection and try again.",
      "rate-limited": "Too many tries just now. Wait a minute and try again.",
      "connect-denied": "Cancelled in the browser.",
      "connect-expired": "The code expired before it was approved. Connect again.",
      "connect-failed": "Connecting did not work. Try again.",
      "keychain-locked": "The keychain is locked, so this deck cannot read its sign-in. Retrying every minute.",
      "token-missing": "This deck's sign-in could not be found. Connect it again.",
    });
    expect(STORAGE_COPY).toEqual({
      keychain: "Stored in your keychain.",
      dpapi: "Stored encrypted for your Windows user.",
      "secret-service": "Stored in your keyring.",
      file: "Stored in a file only you can read.",
    });
  });

  it("the section's source draws every sentence with t, and holds no sentence of its own", () => {
    const source = sourceOf("components/AccountSection.tsx");
    expect(source).toContain("t(ACCOUNT_MSGS.vetoed)");
    expect(source).toContain('"settings.account.connect"');
    expect(source).toContain("t(ACCOUNT_MSGS.disconnectNote)");
    expect(source).not.toContain("Connect account");
    expect(source).not.toContain("Disconnect this deck");
    expect(source).not.toContain("Changed elsewhere");
    expect(source).not.toMatch(/toLocaleTimeString\(\[\]/);
  });

  it("the status line and its time follow the language on show", () => {
    const v = connected();
    const at = new Date("2026-10-18T09:00:03.000Z");
    const clock = (lang: string) => at.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    // The expected line is that language's own catalog text with the time and
    // the seconds filled in, so the test does not depend on a translation's words.
    const inLanguage = (lang: string, time: string) =>
      (catalogFor(lang)["settings.account.status.sent"] ?? en["settings.account.status.sent"]).replace("{time}", time).replace("{seconds}", "15");
    try {
      setLanguage("en");
      expect(statusLine(v)).toBe(`Status: sent ${clock("en")} · every 15 s.`);
      setLanguage("ja");
      expect(statusLine(v)).toBe(inLanguage("ja", clock("ja")));
      expect(statusLine(v)).toContain(clock("ja"));
      setLanguage("de");
      expect(statusLine(v)).toBe(inLanguage("de", clock("de")));
      expect(statusLine(v)).toContain(clock("de"));
      expect(clock("en")).not.toBe(clock("de"));
    } finally {
      setLanguage("en");
      resetLanguageForTest();
    }
  });
});
