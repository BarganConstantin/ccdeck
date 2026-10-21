// The integrations on a deck that cannot read them: no provider for a kind
// here, or one that is not answering. The page follows what GET
// /api/integrations offers (`providers[].available`): a deck offering no kind
// draws what a deck without integrations always drew — no Settings section, no
// rail control, no I, no row in Keyboard help or in Settings search — and a
// connection of a kind it does not offer is stranded, listed in Settings with
// Disconnect alone, which deletes it and its saved token. A read the deck
// cannot serve answers the `unavailable` kind (503), which the panels name and
// offer Try again for.
//
// No DOM in this suite: the list is set through the client's own read, with
// the deck's answer handed to a stub fetch, and the markup is drawn with the
// server renderer.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import {
  failureOf, IntegrationFailure, integrationsReach, kindOffered, kindOpenable, offeredKinds, refreshIntegrations,
  type IntegrationsState, type ProviderInfo,
} from "../integrations/client";
import { integrationDefs } from "../integrations/registry";
import type { IntegrationConnection, IntegrationKind } from "../integrations/types";
import { sectionsDrawn, SETTINGS_SECTIONS } from "../settings";
import { indexFor, searchSettings, SETTINGS_INDEX } from "../settings-search";
import { KEY_HELP, keyHelpFor } from "../key-help";
import { railItems } from "../rail-items";
import { fetchForge, forgeErrorWords, ForgeReadError } from "../forge-panel";
import { FATAL_KINDS } from "../use-jira-board";
import { failureCopy, FailureNote } from "../components/JiraParts";
import IntegrationsSection from "../components/IntegrationsSection";
import KeyboardHelp from "../components/KeyboardHelp";
import KeyboardSection from "../components/KeyboardSection";
import SettingsModal, { type SettingsModalProps } from "../components/SettingsModal";
import { DEFAULT_PREFS } from "../sound";
import { ACCOUNT_NOTIFY_DEFAULTS } from "../use-os-notifications";
import { draw } from "./edge-keys-rails";
import { sourceOf } from "./client-source";

const noop = () => {};
const asyncNoop = async () => {};

const HOSTS: Record<IntegrationKind, string> = {
  jira: "https://jira.example.com",
  github: "https://github.example.com",
  gitlab: "https://gitlab.example.com",
};

function conn(id: string, kind: IntegrationKind, name: string): IntegrationConnection {
  return {
    id, kind, name, baseUrl: HOSTS[kind],
    account: { id: "1", login: "jdoe", name: "Jane Doe", avatarUrl: "" },
    meta: {}, allowedOrigins: [HOSTS[kind]], createdAt: "", updatedAt: "", tokenSaved: true,
  };
}

const JIRA: ProviderInfo = { kind: "jira", label: "Jira", available: true };
const GITHUB: ProviderInfo = { kind: "github", label: "GitHub", available: true };

/** What the deck answers GET /api/integrations with, read through the client
 *  as the page reads it, so every surface below sees it. */
async function deckSays(connections: IntegrationConnection[], providers: ProviderInfo[]): Promise<void> {
  const asked: string[] = [];
  vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
  vi.stubGlobal("fetch", async (path: string) => {
    asked.push(path);
    return new Response(JSON.stringify({ connections, providers }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  try { await refreshIntegrations(); } finally { vi.unstubAllGlobals(); }
  expect(asked).toEqual(["/api/integrations"]);
}

afterEach(() => { vi.unstubAllGlobals(); });

/** Every hook Settings is handed, as the plain values a first render reads
 *  (settings-surface.test.ts draws it the same way). */
function settingsProps(over: Partial<SettingsModalProps> = {}): SettingsModalProps {
  return {
    section: "general",
    onSection: noop,
    onClose: noop,
    providers: { kind: "reported", claude: true, codex: true },
    sound: { soundOn: true, toggleSound: noop, activateSoundRef: { current: noop }, soundOnRef: { current: true } },
    tones: { tonePrefs: DEFAULT_PREFS, setTonePrefs: noop, tonePrefsRef: { current: DEFAULT_PREFS }, previewTone: noop, changeTone: noop },
    customTones: {
      customSelections: { done: null, "needs-input": null }, customSelectionsRef: { current: { done: null, "needs-input": null } },
      customAssets: [], clearCustomOnly: noop, fallbackCustomRef: { current: null }, selectCustomTone: noop,
      importNotificationAudio: asyncNoop, createNotificationVoice: asyncNoop, renameCustomAsset: asyncNoop,
      deleteCustomAsset: asyncNoop, previewCustomAsset: noop,
    },
    notify: {
      notifyPermission: "default", notifySaid: new Set(), notifyOn: false, notifyVetoed: false, toggleNotify: noop,
      notifySupported: true, askForNotifications: noop, loadNotifyPrefs: noop, accountNotify: ACCOUNT_NOTIFY_DEFAULTS,
      toggleAccountNotify: noop,
    },
    appearance: { theme: "dark", setTheme: noop, characterEnabled: true, setCharacterEnabled: noop },
    versionCheck: { version: null, notice: null, noticeOpen: false, showNotice: noop, dismissNotice: noop, versionChecking: false, loadVersion: async () => null },
    desktopUpdate: { desktopUpdateRestarting: false, desktopUpdateFailure: null, readyAppUpdate: null, appUpdate: null, askDesktopUpdateRestart: asyncNoop, onDesktopUpdateEvent: noop },
    restart: { autoRestart: true, toggleAutoRestart: noop },
    doors: { whatsNew: noop, update: noop, tour: noop, feedback: noop, accounts: noop, localNetwork: noop, browserWatch: noop },
    ...over,
  } as unknown as SettingsModalProps;
}

/** The nav's tabs, each by the word on it. */
const tabsOf = (html: string) => [...html.matchAll(/<button[^>]*role="tab"[^>]*>([\s\S]*?)<\/button>/g)]
  .map(m => m[1].replace(/<[^>]+>/g, "").replace("&amp;", "&"));

/** The rail's integration controls for a list, built the way App builds them. */
function railFor(state: IntegrationsState) {
  const openable = integrationDefs().filter(p => kindOpenable(state, p.kind));
  return railItems({
    providers: { kind: "reported", claude: true, codex: true } as never,
    sessionListOpen: false, toggleSessionList: noop, accountsPanelOpen: false, toggleAccountsPanel: noop,
    usagePanelOpen: false, setUsagePanelOpen: noop, machinePanelOpen: false, setMachinePanelOpen: noop,
    setUsageHistoryOpen: noop, watchOn: false, watchUnseen: 0, setBrowserWatchOpen: noop, openSettings: noop, onFeedback: noop,
    toggles: { sessionList: { current: null }, usage: { current: null }, accounts: { current: null }, machine: { current: null } } as never,
    integrations: openable.map(provider => ({ provider, onPress: noop })),
  } as Parameters<typeof railItems>[0]).integrations.map(r => r.id);
}

// ── before the list is read ──────────────────────────────────────────────────
// First in the file: every case after it sets the list.

describe("before the deck has answered", () => {
  it("keeps the Integrations section, with nothing offered to connect yet", () => {
    expect(tabsOf(draw(createElement(SettingsModal, settingsProps())))).toContain("Integrations");
    const html = draw(createElement(IntegrationsSection));
    expect(html).toContain(">Add integration</h3>");
    expect(html).toContain("Reading what this deck can connect…");
    expect(html).not.toContain(">Add integration</button>");
    expect(html).toContain("Reading connections…");
    expect(draw(createElement(KeyboardHelp, { onClose: noop }))).toContain("<kbd>I</kbd>");
  });
});

// ── what the deck offers ─────────────────────────────────────────────────────

describe("what a deck offers, as the list says it", () => {
  const unread: IntegrationsState = { connections: null, providers: [], error: "" };
  const none: IntegrationsState = { connections: [], providers: [], error: "" };

  it("knows nothing until the list is read, and draws no rail control meanwhile", () => {
    expect(offeredKinds(unread)).toBeNull();
    expect(kindOffered(unread, "jira")).toBe(true);
    expect(kindOpenable(unread, "jira")).toBe(false);
    expect(integrationsReach(unread)).toBe("all");
  });

  it("offers nothing where the deck lists no provider: an empty list is not every kind", () => {
    expect([...offeredKinds(none)!]).toEqual([]);
    for (const kind of ["jira", "github", "gitlab"] as const) expect(kindOffered(none, kind), kind).toBe(false);
    expect(integrationsReach(none)).toBe("none");
  });

  it("offers a kind listed as available, or listed without the field, and not one listed as unavailable", () => {
    const state: IntegrationsState = {
      connections: [],
      providers: [JIRA, { kind: "github", label: "GitHub" }, { kind: "gitlab", label: "GitLab", available: false }],
      error: "",
    };
    expect([...offeredKinds(state)!].sort()).toEqual(["github", "jira"]);
    expect(kindOffered(state, "gitlab")).toBe(false);
  });

  it("calls a connection of a kind not offered stranded: Settings keeps it, the rail does not", () => {
    const stranded: IntegrationsState = { connections: [conn("j1", "jira", "Work Jira")], providers: [], error: "" };
    expect(integrationsReach(stranded)).toBe("connections");
    expect(kindOpenable(stranded, "jira")).toBe(false);
    const mixed: IntegrationsState = { connections: [conn("j1", "jira", "Work Jira"), conn("g1", "github", "Code")], providers: [GITHUB], error: "" };
    expect(integrationsReach(mixed)).toBe("all");
    expect(kindOpenable(mixed, "jira")).toBe(false);
    expect(kindOpenable(mixed, "github")).toBe(true);
  });
});

// ── the rail and I ───────────────────────────────────────────────────────────

describe("the rail control and I follow what the deck offers", () => {
  it("draws a kind's control only while the deck offers it and a connection of it exists", () => {
    const connections = [conn("j1", "jira", "Work Jira"), conn("g1", "github", "Code")];
    expect(railFor({ connections, providers: [], error: "" })).toEqual([]);
    expect(railFor({ connections, providers: [GITHUB], error: "" })).toEqual(["integration-github"]);
    expect(railFor({ connections, providers: [JIRA, GITHUB], error: "" })).toEqual(["integration-jira", "integration-github"]);
    expect(railFor({ connections: [], providers: [JIRA, GITHUB], error: "" })).toEqual([]);
  });

  it("is App's list too: the rail, I and the modal all read it, and a kind no longer offered closes its modal", () => {
    const app = sourceOf("App.tsx");
    expect(app).toContain("const connectedKinds = integrationDefs().filter(p => kindOpenable(integrations, p.kind));");
    // I opens Jira through openIntegrationRef, which finds the kind among those.
    expect(app).toMatch(/const openIntegrationRef = useMirroredRef\(\(kind: string\) => \{\s*const def = connectedKinds\.find\(p => p\.kind === kind\);/);
    expect(app).toContain("integrations: connectedKinds.map(provider => ({ provider, onPress: () => setIntegrationOpen(provider.kind) })),");
    expect(app).toContain("connections={kindOffered(integrations, integrationOpen) ? connectionsOf(integrations, integrationOpen) : []}");
    expect(sourceOf("use-deck-shortcuts.ts")).toContain('openIntegrationRef?.current("jira")');
  });
});

// ── Settings ─────────────────────────────────────────────────────────────────

describe("Settings draws Integrations only where it holds something", () => {
  it("draws every section while a kind is offered or a connection is stranded, eight where neither", () => {
    expect(sectionsDrawn("all", "general")).toBe(SETTINGS_SECTIONS);
    expect(sectionsDrawn("connections", "general")).toBe(SETTINGS_SECTIONS);
    const eight = sectionsDrawn("none", "general").map(s => s.id);
    expect(eight).toEqual(SETTINGS_SECTIONS.map(s => s.id).filter(id => id !== "integrations"));
    // The section on show keeps its tab: the last Disconnect does not pull
    // the page from under the reader.
    expect(sectionsDrawn("none", "integrations")).toBe(SETTINGS_SECTIONS);
  });

  it("leaves Integrations out of the nav of a deck that offers none, and walks the arrows over what it draws", async () => {
    await deckSays([], []);
    const html = draw(createElement(SettingsModal, settingsProps()));
    expect(tabsOf(html)).toEqual(["General", "Appearance", "Text & density", "Keyboard", "Notifications", "Sounds", "Data", "Radar", "About"]);
    expect(html).not.toContain('id="settings-tab-integrations"');
    const modal = sourceOf("components/SettingsModal.tsx");
    expect(modal).toContain("const SETTINGS_SECTIONS = sectionsDrawn(integrationsReachHere, section);");
    expect(modal).toContain("const at = Math.max(0, SETTINGS_SECTIONS.findIndex(s => s.id === section));");
  });

  it("keeps the tab while a stranded connection waits to be disconnected, and where a kind is offered", async () => {
    await deckSays([conn("j1", "jira", "Work Jira")], []);
    expect(tabsOf(draw(createElement(SettingsModal, settingsProps())))).toContain("Integrations");
    await deckSays([], [JIRA]);
    expect(tabsOf(draw(createElement(SettingsModal, settingsProps())))).toContain("Integrations");
  });

  it("offers nothing of Integrations in Settings search where the section is not drawn, and only Connections where it is stranded", () => {
    expect(indexFor(true, "all")).toBe(SETTINGS_INDEX);
    expect(indexFor(true)).toBe(SETTINGS_INDEX);
    expect(indexFor(true, "none").some(e => e.section === "integrations")).toBe(false);
    expect(searchSettings("jira", indexFor(true, "none"))).toEqual([]);
    expect(searchSettings("personal access token", indexFor(true, "none"))).toEqual([]);
    const stranded = indexFor(true, "connections").filter(e => e.section === "integrations").map(e => e.id);
    expect(stranded).toEqual(["section:integrations", "integrations-connections"]);
    expect(searchSettings("disconnect", indexFor(true, "connections")).map(e => e.id)).toContain("integrations-connections");
    // And Claude Code's own filter still applies alongside.
    expect(indexFor(false, "none").some(e => e.claudeOnly)).toBe(false);
    expect(sourceOf("components/SettingsModal.tsx")).toContain("indexFor(providers.claude, integrationsReachHere)");
  });
});

describe("Settings › Integrations on a deck that cannot read a kind", () => {
  it("lists a stranded connection with the line that says why, and Disconnect alone", async () => {
    await deckSays([conn("j1", "jira", "Work Jira")], []);
    const html = draw(createElement(IntegrationsSection));
    expect(html).not.toContain('id="integrations-add-title"');
    expect(html).not.toContain(">Add integration<");
    expect(html).toContain('<span class="ig-stranded">Jira is not available on this deck. Disconnect deletes this connection and its saved token.</span>');
    expect(html).toContain('aria-label="Disconnect Work Jira"');
    expect(html).not.toContain('aria-label="Test Work Jira"');
    expect(html).not.toContain('aria-label="Edit Work Jira"');
    // Disconnect is a button with a name and no disabled state: Tab reaches it.
    expect(html).not.toMatch(/<button[^>]*disabled/);
  });

  it("keeps Test and Edit for the kinds it offers, beside a stranded one", async () => {
    await deckSays([conn("j1", "jira", "Work Jira"), conn("g1", "github", "Code")], [GITHUB]);
    const html = draw(createElement(IntegrationsSection));
    expect(html).toContain('id="integrations-add-title"');
    expect(html).toContain('aria-label="Test Code"');
    expect(html).toContain('aria-label="Edit Code"');
    expect(html).toContain('aria-label="Disconnect Code"');
    expect(html).not.toContain('aria-label="Test Work Jira"');
    expect(html).toContain("Jira is not available on this deck.");
    expect(html).not.toContain("GitHub is not available on this deck.");
    // Add integration names only the kinds the deck offers.
    expect(html).toMatch(/Connect a tracker<\/span><span class="settings-row-note">GitHub<\/span>/);
  });

  it("says nothing is connected, with no Add integration, once the last stranded one is gone", async () => {
    await deckSays([], []);
    const html = draw(createElement(IntegrationsSection));
    expect(html).not.toContain('id="integrations-add-title"');
    expect(html).toContain(">Nothing connected.</p>");
  });

  it("hands focus to the section's tab after a Disconnect where nothing can be added", () => {
    expect(sourceOf("components/IntegrationsSection.tsx"))
      .toContain('(addRef.current ?? document.getElementById("settings-tab-integrations"))?.focus();');
  });
});

// ── Keyboard help ────────────────────────────────────────────────────────────

describe("the I row in Keyboard help and Settings › Keyboard", () => {
  it("is the whole table where every kind is offered, and loses only I where Jira is not", () => {
    expect(keyHelpFor(true, () => true)).toBe(KEY_HELP);
    const without = keyHelpFor(true, () => false).flatMap(g => g.rows).map(r => r.cap);
    expect(without).not.toContain("I");
    expect(without).toEqual(KEY_HELP.flatMap(g => g.rows).map(r => r.cap).filter(cap => cap !== "I"));
    expect(keyHelpFor(false, () => false)).toEqual(keyHelpFor(false));
  });

  it("draws I on the sheet and in Settings only where the deck offers Jira", async () => {
    await deckSays([], []);
    expect(draw(createElement(KeyboardHelp, { onClose: noop }))).not.toContain("<kbd>I</kbd>");
    expect(draw(createElement(KeyboardSection, { singleKeys: true, onToggleSingleKeys: noop }))).not.toContain('<kbd class="settings-key">I</kbd>');
    await deckSays([], [JIRA]);
    expect(draw(createElement(KeyboardHelp, { onClose: noop }))).toContain("<kbd>I</kbd>");
    expect(draw(createElement(KeyboardSection, { singleKeys: true, onToggleSingleKeys: noop }))).toContain('<kbd class="settings-key">I</kbd>');
  });
});

// ── the unavailable words ────────────────────────────────────────────────────

describe("a read the deck cannot serve: 503, kind unavailable", () => {
  const body = JSON.stringify({ ok: false, error: { kind: "unavailable", message: "Jira is not available on this deck." } });
  const answer = () => new Response(body, { status: 503, headers: { "Content-Type": "application/json" } });

  it("is read as its own kind by the client and by the forge panel", async () => {
    const failure = await failureOf(answer());
    expect(failure).toBeInstanceOf(IntegrationFailure);
    expect(failure.kind).toBe("unavailable");
    const read = fetchForge(async () => answer(), "repos");
    await expect(read).rejects.toBeInstanceOf(ForgeReadError);
    await expect(fetchForge(async () => answer(), "repos")).rejects.toMatchObject({ info: { kind: "unavailable" } });
  });

  it("is named in GitHub's and GitLab's words, with Try again", () => {
    expect(forgeErrorWords("github", { kind: "unavailable", message: "x" })).toEqual({
      title: "GitHub is unavailable on this deck", detail: "The deck cannot read it right now. Try again in a moment.", action: "retry",
    });
    expect(forgeErrorWords("gitlab", { kind: "unavailable", message: "x" })).toMatchObject({ title: "GitLab is unavailable on this deck", action: "retry" });
  });

  it("is named in Jira's words, with Try again and no Reconnect, and ends a refresh at the first", () => {
    const jira = conn("j1", "jira", "Work Jira");
    const error = new IntegrationFailure("unavailable", "Jira is not available on this deck.");
    // The deck's own sentence ("Jira is not available on this deck.") would
    // repeat the heading, so the body says what to do instead.
    expect(failureCopy(error, jira)).toEqual({ title: "Jira is unavailable on this deck", body: "The deck cannot read Jira right now. Try again in a moment.", reconnect: false });
    const html = draw(createElement(FailureNote, { error, conn: jira, onRetry: noop, onReconnect: noop }));
    expect(html).toContain(">Try again</button>");
    expect(html).not.toContain(">Reconnect</button>");
    expect(html).toContain('data-kind="unavailable"');
    expect(FATAL_KINDS.has("unavailable")).toBe(true);
  });
});
