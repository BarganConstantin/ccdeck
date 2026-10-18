// Settings › About, General's Updates and its Elsewhere on the deck (#2176).
//
// About is a calm page of rows that are each a second way to something the
// deck already has: the version the chip wears, an update offered with the
// chip's own action, the doors to What's new, the tour and the feedback
// dialog, and the licence with a link to its source. General gained the
// update banner's auto-restart switch, where it can be found while no restart
// is waiting, and a list of the preferences that live in their own panels,
// with the door to each.
//
// No DOM in this suite. The markup is drawn with renderToStaticMarkup, and the
// sections that call no hooks are called as functions so their buttons can be
// pressed directly, the way topbar-restart-to-update.test.ts presses the
// chip's; the wiring above them is read off the source.
import { describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import SettingsModal, { type SettingsModalProps } from "../components/SettingsModal";
import AboutSection, {
  FEEDBACK_NOTE, LICENCE, LICENCE_NOTE, pageBehind, pageBehindNote, SOURCE_URL, updateOffer, WHATS_NEW_NOTE, type AboutProps,
} from "../components/AboutSection";
import UpdatesSection, {
  APP_UPDATES_NOTE, AUTO_UPDATE_CHECKS_OFF_NOTE, AUTO_UPDATE_LABEL, AUTO_UPDATE_NO_RESTART_NOTE, AUTO_UPDATE_NOTE, updatesShape,
} from "../components/UpdatesSection";
import ElsewhereSection, {
  ACCOUNTS_ROW, ACCOUNTS_ROW_NOTE, LAN_ROW, LAN_ROW_NOTE, WATCH_ROW, WATCH_ROW_NOTE,
} from "../components/ElsewhereSection";
import { TOUR_WHY } from "../components/ReleaseActions";
import { doorOut, SETTINGS_SECTIONS, type SettingsDoors, type SettingsSection } from "../settings";
import { readyButtonCopy, RESTART_TO_UPDATE, updateRestartFailureText } from "../desktop-update";
import { IDLE_BEFORE_RESTART_MS } from "../restart";
import { CHECKS_OFF } from "../update-check";
import type { VersionInfo } from "../use-version-check";
import { DEFAULT_PREFS } from "../sound";
import { ACCOUNT_NOTIFY_DEFAULTS } from "../use-os-notifications";
import { AWAY_QUIET_MS } from "../../server/auto-update.mjs";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");
const noop = () => {};
const asyncNoop = async () => {};

const VERSION: VersionInfo = {
  name: "ccdeck", running: "3.41.0", installed: "3.41.0", latest: "3.41.0", notice: null,
  command: "npm i -g ccdeck", canRestart: true, checkDisabled: false,
};

function doors(): SettingsDoors {
  return {
    whatsNew: vi.fn(), update: vi.fn(), tour: vi.fn(), feedback: vi.fn(),
    accounts: vi.fn(), localNetwork: vi.fn(), browserWatch: vi.fn(),
  };
}

/** Everything Settings is handed, as the values a first render reads. */
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
    versionCheck: {
      version: VERSION, notice: null, noticeOpen: false, showNotice: noop, dismissNotice: noop,
      versionChecking: false, loadVersion: async () => null,
    },
    desktopUpdate: {
      desktopUpdateRestarting: false, desktopUpdateFailure: null, readyAppUpdate: null, appUpdate: null,
      askDesktopUpdateRestart: asyncNoop, onDesktopUpdateEvent: noop,
    },
    restart: { autoRestart: true, toggleAutoRestart: noop },
    doors: doors(),
    ...over,
  } as unknown as SettingsModalProps;
}
const drawSettings = (over: Partial<SettingsModalProps> = {}) =>
  renderToStaticMarkup(createElement(SettingsModal, settingsProps(over)));

function aboutProps(over: Partial<AboutProps> = {}): AboutProps {
  return {
    version: VERSION, notice: null, readyAppUpdate: null, updateRestarting: false, updateFailure: null,
    onUpdateRestart: noop, doors: doors(), bundle: "3.41.0", ...over,
  };
}
const drawAbout = (over: Partial<AboutProps> = {}) => renderToStaticMarkup(createElement(AboutSection, aboutProps(over)));

/** Every host element in a tree, depth first, with every function component
 *  in it called in place. Only for the hook-free sections: About, Updates,
 *  Elsewhere and the rows they are built from. */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function") return elements((el.type as (props: unknown) => ReactNode)(el.props));
  return [el, ...elements(el.props.children as ReactNode)];
}
/** The text inside an element, as a reader would hear it run together. */
const textOf = (node: ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (!isValidElement(node)) return "";
  return textOf((node as ReactElement<{ children?: ReactNode }>).props.children);
};
const buttons = (node: ReactNode) => elements(node).filter(el => el.type === "button");
const press = (el: ReactElement<Record<string, unknown>> | undefined) => (el?.props.onClick as () => void)();

const deckDialogs = flat(read("../components/DeckDialogs.tsx"));
/** The <SettingsModal … /> element as the dialog stack mounts it. */
const mounted = deckDialogs.slice(deckDialogs.indexOf("<SettingsModal"), deckDialogs.indexOf("/>", deckDialogs.indexOf("<SettingsModal")));

// ── About ────────────────────────────────────────────────────────────────────

describe("Settings › About says which ccdeck this is", () => {
  it("is the last section in the nav, and is drawn when it is chosen", () => {
    expect(SETTINGS_SECTIONS.at(-1)?.id).toBe("about");
    const html = drawSettings({ section: "about" as SettingsSection });
    expect(html).toContain('aria-labelledby="settings-tab-about"');
    expect(html).toContain('data-setting="version"');
  });

  it("names the version the deck runs, which is the server's and the chip's, not the page's", () => {
    const html = drawAbout({ version: { ...VERSION, running: "3.41.2" }, bundle: "3.41.2" });
    expect(html).toMatch(/data-setting="version"[\s\S]*?<span class="settings-read">3\.41\.2<\/span>/);
    // Until the deck has answered, the bundle's, as the chip defaults it.
    expect(drawAbout({ version: null, bundle: "3.40.9" })).toContain('<span class="settings-read">3.40.9</span>');
    expect(read("../use-welcome-and-notes.ts")).toContain("const chipVersion = version?.running ?? __APP_VERSION__;");
  });

  it("says so when the page is older than the deck, in the words the deck already uses for that tab", () => {
    expect(pageBehind("3.40.0", "3.41.0")).toBe(true);
    expect(pageBehind("3.41.0", "3.41.0")).toBe(false);
    // Newer than the deck is the restart notice's to say, not this line's.
    expect(pageBehind("3.42.0", "3.41.0")).toBe(false);
    expect(pageBehind("3.40.0", null)).toBe(false);
    expect(pageBehind("", "3.41.0")).toBe(false);

    const behind = drawAbout({ version: { ...VERSION, running: "3.41.0" }, bundle: "3.40.0" });
    expect(behind).toContain(pageBehindNote("3.40.0"));
    expect(drawAbout()).not.toContain("This page is");
    // The sentence the deck says when a dialog fails to load for this reason.
    const said = "The deck has most likely been updated since this tab opened, and a reload picks up the new version.";
    expect(pageBehindNote("3.40.0")).toBe(`This page is from v3.40.0. ${said}`);
    expect(flat(read("../components/LazyDialog.tsx"))).toContain(said);
  });

  it("draws no update row while nothing is waiting", () => {
    expect(updateOffer(null, null)).toBeNull();
    expect(drawAbout()).not.toContain('data-setting="update"');
  });

  it("offers a ready desktop update with the chip's own press, and stays open to say what came of it", () => {
    const onUpdateRestart = vi.fn();
    const tree = AboutSection(aboutProps({ readyAppUpdate: { version: "3.42.0" }, onUpdateRestart }));
    const restart = buttons(tree).find(el => el.props["aria-label"] === readyButtonCopy("3.42.0").label);
    expect(restart, "Restart to update").toBeDefined();
    expect(textOf(restart?.props.children as ReactNode)).toBe(RESTART_TO_UPDATE);
    expect(restart?.props.title).toBe(readyButtonCopy("3.42.0").title);
    press(restart);
    expect(onUpdateRestart).toHaveBeenCalledWith("3.42.0");
    const html = drawAbout({ readyAppUpdate: { version: "3.42.0" } });
    expect(html).toContain("ccdeck v3.42.0 is downloaded and verified.");
    // The live region is there before it speaks, and says the failure in
    // What's new's words — only about the update on offer.
    expect(html).toMatch(/<span class="settings-row-said" role="status"><\/span>/);
    const failed = drawAbout({ readyAppUpdate: { version: "3.42.0" }, updateFailure: { failure: "timeout", version: "3.42.0" } });
    expect(failed).toContain(updateRestartFailureText("timeout", "3.42.0").replace(/"/g, "&quot;"));
    const stale = drawAbout({ readyAppUpdate: { version: "3.43.0" }, updateFailure: { failure: "timeout", version: "3.42.0" } });
    expect(stale).toMatch(/<span class="settings-row-said" role="status"><\/span>/);
    // Busy, never disabled (#620).
    const busy = buttons(AboutSection(aboutProps({ readyAppUpdate: { version: "3.42.0" }, updateRestarting: true })))
      .find(el => textOf(el.props.children as ReactNode) === "Restarting…");
    expect(busy?.props["aria-busy"]).toBe(true);
    expect(busy?.props.disabled).toBeUndefined();
    // The same function the topbar's button presses.
    expect(read("../components/SettingsModal.tsx")).toMatch(/onUpdateRestart=\{version => \{ void desktopUpdate\.askDesktopUpdateRestart\(version\); \}\}/);
    expect(read("../components/TopbarReadouts.tsx")).toContain("void askDesktopUpdateRestart(updateVersion);");
  });

  it("offers a version on disk or on npm with the lit chip's action: What's new, and the banner put back", () => {
    const restart = drawAbout({ notice: { kind: "restart", from: "3.41.0", to: "3.42.0" } });
    expect(restart).toContain("Update installed");
    expect(restart).toContain("v3.42.0 is installed — this deck still runs v3.41.0.");
    const upgrade = drawAbout({ notice: { kind: "upgrade", from: "3.41.0", to: "3.42.0" } });
    expect(upgrade).toContain("Update available");
    expect(upgrade).toContain("ccdeck v3.42.0 is out — you are on v3.41.0.");
    // The banner's own first sentences.
    const banner = flat(read("../components/VersionBanner.tsx"));
    expect(banner).toContain("<strong>v{notice.to} is installed — this deck still runs v{notice.from}.</strong>");
    expect(banner).toContain("<strong>{PRODUCT} v{notice.to} is out — you are on v{notice.from}.</strong>");

    const d = doors();
    const update = buttons(AboutSection(aboutProps({ notice: { kind: "upgrade", from: "3.41.0", to: "3.42.0" }, doors: d })))
      .find(el => textOf(el.props.children as ReactNode) === "Update…");
    press(update);
    expect(d.update).toHaveBeenCalledOnce();
    // What that door is: the chip's click while it is lit, behind Settings closing.
    expect(read("../components/VersionChip.tsx")).toContain("onClick={() => { openReleaseNotes(); showNotice(); }}");
    expect(mounted).toContain("update: doorOut(closeSettings, () => { openReleaseNotes(); showNotice(); }),");
    // A ready app update outranks a notice, as it does on the chip.
    expect(updateOffer({ version: "3.42.0" }, { kind: "upgrade", from: "3.41.0", to: "3.42.0" })?.kind).toBe("ready");
  });

  it("opens What's new, the tour and the feedback dialog through their doors", () => {
    const d = doors();
    const tree = AboutSection(aboutProps({ doors: d }));
    const byLabel = (label: string) => buttons(tree).find(el => el.props["aria-label"] === label);
    press(byLabel("Open What's new"));
    press(byLabel("Start the tour"));
    press(byLabel("Open the feedback dialog"));
    expect(d.whatsNew).toHaveBeenCalledOnce();
    expect(d.tour).toHaveBeenCalledOnce();
    expect(d.feedback).toHaveBeenCalledOnce();
    // Each name starts with the word printed on the button (WCAG 2.5.3), and
    // says a dialog is behind it.
    for (const el of buttons(tree)) {
      const label = el.props["aria-label"] as string | undefined;
      if (label) expect(label.startsWith(textOf(el.props.children as ReactNode))).toBe(true);
      expect(el.props["aria-haspopup"]).toBe("dialog");
    }
    const html = drawAbout();
    for (const said of [WHATS_NEW_NOTE, TOUR_WHY, FEEDBACK_NOTE, "Take the tour", "Send feedback", "What&#x27;s new"]) {
      expect(html, said).toContain(said);
    }
  });

  it("names the licence package.json and LICENSING.md name, and links to the repository in a new tab", () => {
    const pkg = JSON.parse(read("../../../package.json")) as { license: string; repository: { url: string } };
    expect(LICENCE).toBe(pkg.license);
    expect(read("../../../LICENSING.md")).toContain(`(\`${LICENCE}\`)`);
    expect(SOURCE_URL).toBe(pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, ""));
    const html = drawAbout();
    expect(html).toContain(`<span class="settings-read">${LICENCE}</span>`);
    expect(html).toContain(LICENCE_NOTE);
    expect(html).toContain(`<a class="settings-link" href="${SOURCE_URL}" target="_blank" rel="noreferrer">Source`);
  });
});

// ── the doors out ────────────────────────────────────────────────────────────

describe("a door out of Settings closes it before it opens what it names", () => {
  it("closes, then opens, in that order and once each", () => {
    const calls: string[] = [];
    const door = doorOut(() => calls.push("close"), () => calls.push("open"));
    door();
    expect(calls).toEqual(["close", "open"]);
  });

  it("is wired to the deck's own way in, every one of them", () => {
    expect(mounted).toContain("whatsNew: doorOut(closeSettings, openReleaseNotes),");
    expect(mounted).toContain("tour: doorOut(closeSettings, openTour),");
    expect(mounted).toContain("feedback: doorOut(closeSettings, () => openFeedback()),");
    expect(mounted).toContain("accounts: doorOut(closeSettings, panelDoors.accounts),");
    expect(mounted).toContain("localNetwork: doorOut(closeSettings, panelDoors.localNetwork),");
    expect(mounted).toContain("browserWatch: doorOut(closeSettings, () => setBrowserWatchOpen(true)),");
    // The shortcuts sheet's hand-over to Settings is the same shape the other way.
    expect(deckDialogs).toContain('onSettings={() => { setKeyHelpOpen(false); openSettings("keyboard"); }}');
    const app = flat(read("../App.tsx"));
    expect(app).toContain("panelDoors={{ accounts: openAccountsPanel, localNetwork: openLocalNetwork }}");
  });
});

// ── General › Updates ────────────────────────────────────────────────────────

describe("Settings › General › Updates is the update banner's switch", () => {
  it("is drawn in General, under the board, with the state the banner reads", () => {
    const on = drawSettings({ section: "general" });
    expect(on.indexOf(">Updates</h3>")).toBeGreaterThan(on.indexOf(">Board</h3>"));
    expect(on).toMatch(/role="switch" aria-checked="true" aria-labelledby="settings-auto-update-label"/);
    const off = drawSettings({ section: "general", restart: { autoRestart: false, toggleAutoRestart: noop } as unknown as SettingsModalProps["restart"] });
    expect(off).toMatch(/role="switch" aria-checked="false" aria-labelledby="settings-auto-update-label"/);
    expect(on).toContain(`>${AUTO_UPDATE_LABEL}<`);
  });

  it("presses the same toggle the banner's switch presses, from the same hook", () => {
    const toggle = vi.fn();
    const sw = elements(UpdatesSection({ autoRestart: true, onToggleAutoRestart: toggle, version: VERSION, inApp: false }))
      .find(el => el.props.role === "switch");
    press(sw);
    expect(toggle).toHaveBeenCalledOnce();
    // Settings hands it the hook's own toggle, DeckDialogs hands Settings the
    // hook's return whole, and App the one it made for the banner.
    expect(read("../components/SettingsModal.tsx")).toContain("<UpdatesSection autoRestart={restart.autoRestart} onToggleAutoRestart={restart.toggleAutoRestart}");
    expect(mounted).toContain("restart={restart}");
    const app = flat(read("../App.tsx"));
    expect(app).toMatch(/<DeckDialogs[^>]*restart=\{restart\}/);
    expect(app).toMatch(/<DeckBanner restart=\{restart\}/);
    expect(read("../components/DeckBanner.tsx")).toMatch(/toggleAutoRestart/);
    // One preference: prefs.json's autoUpdate, which the toggle writes.
    expect(read("../use-auto-restart.ts")).toMatch(/body: JSON\.stringify\(\{ autoUpdate: next \}\)/);
  });

  it("says the rule it runs on, with the one quiet stretch both paths wait for", () => {
    expect(AWAY_QUIET_MS).toBe(IDLE_BEFORE_RESTART_MS);
    expect(AUTO_UPDATE_NOTE).toContain(`${IDLE_BEFORE_RESTART_MS / 1000} seconds`);
    // Both paths, and the off state.
    expect(AUTO_UPDATE_NOTE).toMatch(/already installed/);
    expect(AUTO_UPDATE_NOTE).toMatch(/installs the new version first/);
    expect(AUTO_UPDATE_NOTE).toMatch(/Off, it updates only when you press\./);
  });

  it("says when update checks were switched off at launch, and still records the choice", () => {
    const off = { ...VERSION, checkDisabled: true };
    expect(updatesShape(off, false)).toBe("checks-off");
    expect(AUTO_UPDATE_CHECKS_OFF_NOTE.startsWith(CHECKS_OFF)).toBe(true);
    expect(AUTO_UPDATE_CHECKS_OFF_NOTE).toContain("AGENTS_DECK_NO_UPDATE_CHECK");
    const html = renderToStaticMarkup(createElement(UpdatesSection, { autoRestart: true, onToggleAutoRestart: noop, version: off, inApp: false }));
    expect(html).toContain(AUTO_UPDATE_CHECKS_OFF_NOTE);
    expect(html).toContain('role="switch"');
    // What the server sets it from.
    expect(read("../../server/self-update.mjs")).toMatch(/process\.env\.AGENTS_DECK_NO_UPDATE_CHECK === "1"/);
  });

  it("says when the deck cannot restart itself, ahead of anything about npm", () => {
    expect(updatesShape({ ...VERSION, canRestart: false }, false)).toBe("no-restart");
    expect(updatesShape({ ...VERSION, canRestart: false, checkDisabled: true }, false)).toBe("no-restart");
    const html = renderToStaticMarkup(createElement(UpdatesSection, {
      autoRestart: true, onToggleAutoRestart: noop, version: { ...VERSION, canRestart: false }, inApp: false,
    }));
    expect(html).toContain(AUTO_UPDATE_NO_RESTART_NOTE);
    expect(html).toContain('role="switch"');
    // Until the deck has answered, the general rule.
    expect(updatesShape(null, false)).toBe("plain");
    expect(updatesShape(VERSION, true)).toBe("plain");
  });

  it("draws no switch in the desktop app's own deck, which the app updates, and says how", () => {
    expect(updatesShape({ ...VERSION, checkDisabled: true }, true)).toBe("app");
    const html = renderToStaticMarkup(createElement(UpdatesSection, {
      autoRestart: true, onToggleAutoRestart: noop, version: { ...VERSION, checkDisabled: true }, inApp: true,
    }));
    expect(html).not.toContain('role="switch"');
    expect(html).toContain(APP_UPDATES_NOTE);
    // The app's deck always skips npm, which is what the inference rests on.
    expect(read("../../server/self-update.mjs")).toMatch(/process\.env\.AGENTS_DECK_NO_INSTALL === "1" \|\|\s*inApp\(\);/);
  });
});

// ── General › Elsewhere on the deck ──────────────────────────────────────────

describe("Settings › General › Elsewhere on the deck", () => {
  const draw = (claudeHere: boolean, singleKeys: boolean) =>
    renderToStaticMarkup(createElement(ElsewhereSection, { claudeHere, singleKeys, doors: doors() }));

  it("lists the accounts panel and Local network only where Claude Code is, as the stripe does", () => {
    const here = draw(true, true);
    for (const said of [ACCOUNTS_ROW, ACCOUNTS_ROW_NOTE, LAN_ROW, LAN_ROW_NOTE, WATCH_ROW, WATCH_ROW_NOTE]) {
      expect(here, said).toContain(said);
    }
    const codexOnly = draw(false, true);
    expect(codexOnly).not.toContain(ACCOUNTS_ROW);
    expect(codexOnly).not.toContain(LAN_ROW);
    expect(codexOnly).toContain(WATCH_ROW);
    // The stripe's condition, and A's.
    expect(read("../rail-items.tsx")).toContain("left: providers.claude ? [accounts, sessionList] : [sessionList],");
    expect(read("../use-deck-shortcuts.ts")).toContain('if (e.key === "a" || e.key === "A") { if (providersRef.current.claude) toggleAccountsPanel(); }');
    // And Settings hands it the deck's providers.
    expect(read("../components/SettingsModal.tsx")).toContain("<ElsewhereSection claudeHere={providers.claude} singleKeys={singleKeys} doors={doors} />");
    expect(drawSettings({ section: "general", providers: { kind: "reported", claude: false, codex: true } })).not.toContain(ACCOUNTS_ROW);
  });

  it("is a row with a door on the right, never a switch, and each opens its own panel", () => {
    const d = doors();
    const tree = ElsewhereSection({ claudeHere: true, singleKeys: true, doors: d });
    expect(elements(tree).some(el => el.props.role === "switch")).toBe(false);
    const opens = buttons(tree);
    expect(opens.map(el => textOf(el.props.children as ReactNode))).toEqual(["Open", "Open", "Open"]);
    opens.forEach(press);
    expect(d.accounts).toHaveBeenCalledOnce();
    expect(d.localNetwork).toHaveBeenCalledOnce();
    expect(d.browserWatch).toHaveBeenCalledOnce();
    // Three Opens, three names: the word, then the row's own.
    const html = draw(true, true);
    expect(html).toContain('aria-labelledby="settings-accounts-open settings-accounts-name"');
    expect(html).toContain('id="settings-local-network-name">Local network<');
    expect(html).not.toMatch(/<label[^>]*data-setting="(?:accounts|local-network|browser-watch)"/);
  });

  it("draws each panel's key beside its door only while single keys answer", () => {
    const on = draw(true, true);
    expect(on).toMatch(/<kbd class="settings-key" aria-hidden="true" title="Press A[^"]*">A<\/kbd><button[^>]*aria-keyshortcuts="A"/);
    expect(on).toMatch(/<kbd class="settings-key" aria-hidden="true" title="Press B[^"]*">B<\/kbd><button[^>]*aria-keyshortcuts="B"/);
    const off = draw(true, false);
    expect(off).not.toContain('class="settings-key"');
    expect(off).not.toContain("aria-keyshortcuts");
    // The keys the deck answers for those two.
    expect(read("../use-deck-shortcuts.ts")).toContain('if (e.key === "b" || e.key === "B") setBrowserWatchOpen(o => !o);');
  });

  it("opens the accounts panel without ever shutting it, and Local network once the panel can draw it", () => {
    const column = flat(read("../use-left-column.ts"));
    expect(column).toContain("const openAccountsPanel = useCallback(() => { accountsEvictedRef.current = false; setAccountsPanelOpen(open => { if (!open) setSessionListOpen(false); return true; }); }, []);");
    const app = flat(read("../App.tsx"));
    expect(app).toContain("const openLocalNetwork = useCallback(() => { openAccountsPanel(); setLanWanted(true); }, [openAccountsPanel]);");
    expect(app).toContain("useEffect(() => { if (!accountsPanelOpen) setLanWanted(false); }, [accountsPanelOpen]);");
    expect(app).toContain("lanWanted={lanWanted} onLanShown={lanShown}");
    const panel = flat(read("../components/AccountsPanel.tsx"));
    expect(panel).toContain("if (!lanWanted || !lanReady) return; openLan(); onLanShown?.();");
  });

  it("says General holds more than the board now, in one line", () => {
    const general = SETTINGS_SECTIONS.find(s => s.id === "general")!;
    expect(general.note).toMatch(/board/);
    expect(general.note).toMatch(/updates/);
    expect(general.note.split(". ").length).toBe(1);
  });
});

// ── the voice ────────────────────────────────────────────────────────────────

describe("the new copy keeps the deck's voice", () => {
  it("has no exclamation, no minimising word, no capital C, and no claim about telemetry", () => {
    const copy = [
      WHATS_NEW_NOTE, FEEDBACK_NOTE, LICENCE_NOTE, pageBehindNote("3.40.0"), AUTO_UPDATE_LABEL, AUTO_UPDATE_NOTE,
      AUTO_UPDATE_CHECKS_OFF_NOTE, AUTO_UPDATE_NO_RESTART_NOTE, APP_UPDATES_NOTE, ACCOUNTS_ROW, ACCOUNTS_ROW_NOTE,
      LAN_ROW, LAN_ROW_NOTE, WATCH_ROW, WATCH_ROW_NOTE, SETTINGS_SECTIONS.find(s => s.id === "general")!.note,
    ];
    for (const line of copy) {
      expect(line, line).not.toContain("!");
      expect(line, line).not.toMatch(/\b(?:simply|just)\b/i);
      expect(line, line).not.toContain("Ccdeck");
      expect(line, line).not.toMatch(/anonymous|telemetry/i);
    }
  });
});
