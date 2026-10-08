// The deck's one Settings surface: the dialog behind the gear, the section a
// door opens it at, the nav's arrow keys, V's way into Sounds, a Codex-only
// machine's way to its notifications — and that moving every control into it
// reset nobody's settings. The chord that opens it is
// settings-chord.test.ts's, which drives the deck's keydown handler.
//
// No DOM in this suite, so the markup is drawn with renderToStaticMarkup and
// the rules each part lives by are called as functions.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { focusedTabToFollow, openedAt, sectionIndex, SETTINGS_CLOSED, SETTINGS_SECTIONS, type SettingsSection } from "../settings";
import { tabStripMove } from "../tablist-keys";
import SettingsModal, { type SettingsModalProps } from "../components/SettingsModal";
import { SettingsRun } from "../components/TopbarRuns";
import SettingsSectionGlyph from "../components/SettingsSectionGlyph";
import { CODEX_ONLY_SOUNDS_NOTE } from "../components/SoundsSection";
import { DEFAULT_PREFS, FIGURE_KEYS, LEVEL_KEYS } from "../sound";
import { ACCOUNT_NOTIFY_DEFAULTS } from "../use-os-notifications";
import { CHARACTER_ENABLED_KEY, FM_SOURCE_KEY, FM_VOLUME_KEY } from "../appearance";
import { FM_CUSTOM_STATIONS_KEY, FM_MUTED_KEY } from "../fm-stations";
import { THEME_KEY } from "../theme";
import { DEFAULTS } from "../../server/deck-prefs.mjs";
import { sheetText } from "./sheet-source";
import { sourceOf } from "./client-source";

const noop = () => {};
const asyncNoop = async () => {};

/** Every hook Settings is handed, as the plain values a first render reads. */
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
    fm: {
      fmVolume: 50, setFmVolume: noop, fmMuted: false, setFmMuted: noop, fmSource: "claude-fm", customFmStations: [],
      unavailableFmStations: new Set(), fmPlayRequest: 0, addFmStation: noop, renameFmStation: noop,
      removeFmStation: noop, pickFmSource: noop, markFmStationAvailability: noop,
    },
    ...over,
  } as unknown as SettingsModalProps;
}

const drawSettings = (over: Partial<SettingsModalProps> = {}) =>
  renderToStaticMarkup(createElement(SettingsModal, settingsProps(over)));

/** The tab the markup says is on show, by its id. */
const selectedTab = (html: string) => /<button[^>]*role="tab" id="settings-tab-([a-z]+)"[^>]*aria-selected="true"/.exec(html)?.[1];

// ── the doors, and the section each opens at ────────────────────────────────

describe("a door into Settings opens it at the section it names", () => {
  it("opens at General the first time, and at the section a door names", () => {
    expect(SETTINGS_CLOSED).toEqual({ open: false, section: "general" });
    expect(openedAt(SETTINGS_CLOSED)).toEqual({ open: true, section: "general" });
    expect(openedAt(SETTINGS_CLOSED, "sounds")).toEqual({ open: true, section: "sounds" });
  });

  it("reopens where the reader left it when the door names nothing", () => {
    expect(openedAt({ open: false, section: "music" })).toEqual({ open: true, section: "music" });
    expect(openedAt({ open: false, section: "music" }, "notifications")).toEqual({ open: true, section: "notifications" });
  });

  it("draws the section it was opened at, with that tab on show and the rest one Tab stop away", () => {
    const cases: Array<[SettingsSection, RegExp]> = [
      ["general", /Color theme/],
      ["notifications", />Notifications while closed</],
      ["sounds", />Custom sounds</],
      ["music", />Show character on minimap</],
    ];
    for (const [section, shows] of cases) {
      const html = drawSettings({ section });
      expect(selectedTab(html), section).toBe(section);
      expect(html, section).toMatch(shows);
      expect(html.match(/aria-selected="true"/g), section).toHaveLength(1);
      expect(html.match(/role="tab"[^>]*tabindex="0"/g), section).toHaveLength(1);
      expect(html, section).toContain(`aria-labelledby="settings-tab-${section}"`);
    }
  });

  it("draws General's Keyboard group under the color theme, its switch on as every deck starts", () => {
    const html = drawSettings({ section: "general" });
    expect(html.indexOf("Color theme")).toBeGreaterThan(-1);
    expect(html.indexOf(">Keyboard</h3>")).toBeGreaterThan(html.indexOf("Color theme"));
    expect(html).toMatch(/role="switch" aria-checked="true" aria-labelledby="settings-single-keys-label"/);
    expect(html.match(/role="switch"/g)).toHaveLength(1);
  });

  it("names the four sections in the nav, in order", () => {
    expect(SETTINGS_SECTIONS.map(s => s.label)).toEqual(["General", "Notifications", "Sounds", "Music & character"]);
    // Each tab's text, its glyph's markup stripped: a tab carries a drawn
    // glyph before its word now (the next block), and the word is still all
    // of the text a tab holds.
    const html = drawSettings();
    const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>([\s\S]*?)<\/button>/g)]
      .map(m => m[1].replace(/<[^>]+>/g, "").replace("&amp;", "&"));
    expect(tabs).toEqual(["General", "Notifications", "Sounds", "Music & character"]);
  });

  it("is a dialog named Settings, holding the focus it hands the section's own tab", () => {
    const html = drawSettings();
    expect(html).toMatch(/role="dialog" aria-modal="true" aria-labelledby="settings-title"/);
    expect(html).toMatch(/id="settings-title"[^>]*>Settings</);
    expect(sourceOf("components/SettingsModal.tsx")).toMatch(/useModalDismiss\(onClose, \{ focusRef: selectedTabRef \}\)/);
  });

  it("is opened at Sounds by V, and by nothing else in particular", () => {
    // The sound popover's "All sound settings…" was the door that named Sounds
    // until the popover left with the topbar speaker (2026-10-07); V, which
    // opened the popover, names it now. The gear and the chord name nothing.
    const keys = sourceOf("use-deck-shortcuts.ts");
    expect(keys).toContain('if (e.key === "v" || e.key === "V") openSettings("sounds");');
    expect(keys).toContain("if (!e.repeat) openSettings();");
    expect(sourceOf("components/TopbarRuns.tsx")).toContain("onClick={() => openSettings()}");
    expect(sourceOf("components/TopbarRuns.tsx")).not.toContain("onAllSettings");
  });
});

// ── the nav's glyphs ────────────────────────────────────────────────────────

describe("each section in the nav carries its glyph", () => {
  const html = drawSettings();
  const tabs = [...html.matchAll(/<button([^>]*role="tab"[^>]*)>([\s\S]*?)<\/button>/g)]
    .map(m => ({ attrs: m[1], inner: m[2] }));
  const glyphOf = (section: SettingsSection) => renderToStaticMarkup(createElement(SettingsSectionGlyph, { section }));
  const SPEC = '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';

  it("draws one glyph before each name, hidden from assistive technology", () => {
    expect(tabs).toHaveLength(SETTINGS_SECTIONS.length);
    tabs.forEach((tab, i) => {
      const { id, label } = SETTINGS_SECTIONS[i];
      expect(tab.inner.match(/<svg\b/g), id).toHaveLength(1);
      expect(tab.inner.startsWith(glyphOf(id)), id).toBe(true);
      expect(tab.inner, id).toBe(`${glyphOf(id)}<span class="settings-tab-label">${label.replace("&", "&amp;")}</span>`);
    });
  });

  it("names each tab by its word alone", () => {
    tabs.forEach((tab, i) => {
      const { id, label } = SETTINGS_SECTIONS[i];
      expect(tab.attrs, id).not.toMatch(/aria-label|aria-labelledby|title=/);
      expect(tab.inner, id).not.toMatch(/<title|<text|<desc/);
      expect(tab.inner.replace(/<[^>]+>/g, "").replace("&amp;", "&"), id).toBe(label);
    });
  });

  it("draws every glyph on the topbar's one spec, in the tab's own ink", () => {
    // currentColor and nothing else, so a glyph is --muted at rest, --text
    // chosen, and the system's text colour under a Contrast theme.
    for (const { id } of SETTINGS_SECTIONS) {
      const glyph = glyphOf(id);
      expect(glyph.startsWith(SPEC), id).toBe(true);
      expect(glyph.match(/fill="[^"]*"/g), id).toEqual(['fill="none"']);
      expect(glyph.match(/stroke="[^"]*"/g), id).toEqual(['stroke="currentColor"']);
      expect(glyph, id).not.toMatch(/style=|class=/);
    }
  });

  it("gives Sounds the speaker and General the sliders, never the gear", () => {
    // The speaker the topbar's sound button wore — a cone and two waves, the
    // drawing for sound on — kept here alone since that button left the bar.
    const sounds = glyphOf("sounds");
    expect(sounds).toContain('d="M3.2 5.2h2L7.8 3v8L5.2 8.8h-2z"');
    expect(sounds).toContain('d="M9.8 5.4a2.4 2.4 0 0 1 0 3.2"');
    expect(sounds).toContain('d="M11.3 3.9a4.6 4.6 0 0 1 0 6.2"');
    expect(sounds.match(/<path\b/g)).toHaveLength(3);
    expect(sourceOf("components/TopbarRuns.tsx")).not.toMatch(/SpeakerGlyph|M3\.2 5\.2h2/);
    const general = glyphOf("general");
    expect(general).toContain('d="M1.5 3h4.3M9.2 3h3.3M1.5 7h1.3M6.2 7h6.3M1.5 11h6.3M11.2 11h1.3"');
    expect(general.match(/<circle\b/g)).toHaveLength(3);
    const glyphs = SETTINGS_SECTIONS.map(s => glyphOf(s.id));
    for (const glyph of glyphs) expect(glyph).not.toContain("M5.4 2.9L5.6 1.1L8.4 1.1");
    expect(new Set(glyphs).size).toBe(SETTINGS_SECTIONS.length);
  });

  it("keeps each tab to one line, and the phone grid even", () => {
    const css = sheetText();
    expect(css).toMatch(/\.settings-tab-label \{[^}]*white-space: nowrap;/);
    expect(css).toMatch(/@media \(max-width: 640px\) \{[\s\S]*?\.settings-nav \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
    expect(css).toMatch(/@media \(max-width: 359px\) \{\s*\.settings-tab > svg \{ display: none; \}/);
  });
});

// ── the nav's arrow keys ────────────────────────────────────────────────────

describe("the arrow keys walk the nav", () => {
  const key = (k: string) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false });
  const count = SETTINGS_SECTIONS.length;

  it("goes down and up the side, wrapping at both ends", () => {
    expect(tabStripMove(key("ArrowDown"), 0, count, "vertical")).toEqual({ kind: "select", index: 1 });
    expect(tabStripMove(key("ArrowUp"), 1, count, "vertical")).toEqual({ kind: "select", index: 0 });
    expect(tabStripMove(key("ArrowDown"), count - 1, count, "vertical")).toEqual({ kind: "select", index: 0 });
    expect(tabStripMove(key("ArrowUp"), 0, count, "vertical")).toEqual({ kind: "select", index: count - 1 });
  });

  it("answers Left and Right too, for the row the nav becomes at a phone's width", () => {
    expect(tabStripMove(key("ArrowRight"), 0, count, "vertical")).toEqual({ kind: "select", index: 1 });
    expect(tabStripMove(key("ArrowLeft"), 0, count, "vertical")).toEqual({ kind: "select", index: count - 1 });
  });

  it("goes to the ends on Home and End, and leaves Tab and Escape to the dialog", () => {
    expect(tabStripMove(key("End"), 0, count, "vertical")).toEqual({ kind: "select", index: count - 1 });
    expect(tabStripMove(key("Home"), 2, count, "vertical")).toEqual({ kind: "select", index: 0 });
    expect(tabStripMove(key("Tab"), 0, count, "vertical")).toEqual({ kind: "pass" });
    expect(tabStripMove(key("Escape"), 0, count, "vertical")).toEqual({ kind: "pass" });
  });

  it("is what the nav runs, with the section the arrow lands on shown and focused", () => {
    const modal = (sourceOf("components/SettingsModal.tsx"));
    expect(modal).toContain('const move = tabStripMove(event, at, SETTINGS_SECTIONS.length, "vertical");');
    expect(modal).toContain("onSection(SETTINGS_SECTIONS[move.index].id);");
    expect(modal).toContain("tabRefs.current[move.index]?.focus();");
    expect(drawSettings()).toMatch(/role="tablist" aria-label="Settings sections" aria-orientation="vertical"/);
  });

  it("finds each section where the nav draws it", () => {
    SETTINGS_SECTIONS.forEach((s, i) => expect(sectionIndex(s.id)).toBe(i));
  });

  it("focuses the section Settings opened on, not General", () => {
    for (const { id } of SETTINGS_SECTIONS) {
      const general = "settings-tab-general";
      expect(focusedTabToFollow(general, id), id).toBe(id === "general" ? null : id);
    }
  });

  it("moves focus to the selected tab when focus sits on another tab, and leaves focus elsewhere alone", () => {
    expect(focusedTabToFollow("settings-tab-music", "sounds")).toBe("sounds");
    expect(focusedTabToFollow("settings-tab-sounds", "sounds")).toBeNull();
    expect(focusedTabToFollow("settings-pane-field", "sounds")).toBeNull();
    expect(focusedTabToFollow(undefined, "sounds")).toBeNull();
  });

  it("keeps focus on the selected tab whenever the section changes", () => {
    const modal = sourceOf("components/SettingsModal.tsx");
    expect(modal).toContain("focusedTabToFollow(document.activeElement?.id, section)");
    expect(modal).toMatch(/\[section\]\);/);
  });
});

// ── what the popover held ───────────────────────────────────────────────────

describe("Settings › Sounds holds everything the topbar's sound popover did", () => {
  // The popover held the switch, a volume for each tone named for its tone,
  // and a link here; it went with the topbar speaker (2026-10-07), so the
  // guarantee it carried — those controls one door away — is pinned where
  // they are now.
  const html = drawSettings({ section: "sounds" });

  it("draws the switch, with M named under it, and a volume for each tone under the tone's name", () => {
    expect(html.match(/role="switch"/g)).toHaveLength(1);
    expect(html).toMatch(/role="switch" aria-checked="true"/);
    expect(html).toMatch(/<kbd>M<\/kbd>Mute or unmute sounds anywhere\./);
    expect(html.match(/type="range"/g)).toHaveLength(2);
    expect(html).toMatch(/id="sm-level-done"/);
    expect(html).toMatch(/id="sm-level-needs-input"/);
    expect(html).toMatch(/>Turn finished</);
    expect(html).toMatch(/>Claude is asking</);
  });

  it("draws the switch off when the deck is silenced, with nothing below it dimmed or disabled", () => {
    const off = drawSettings({
      section: "sounds",
      sound: { soundOn: false, toggleSound: noop, activateSoundRef: { current: noop }, soundOnRef: { current: false } },
    } as unknown as Partial<SettingsModalProps>);
    expect(off).toMatch(/role="switch" aria-checked="false"/);
    expect(off.match(/type="range"/g)).toHaveLength(2);
    expect(off).not.toMatch(/type="range"[^>]*disabled/);
  });
});

// ── a machine with no Claude Code ───────────────────────────────────────────

describe("Import audio is a button like the deck's others", () => {
  const section = sourceOf("components/CustomSoundsSection.tsx");

  it("draws Choose file as a real button, in the tab order, beside Record", () => {
    expect(section).toMatch(/<button\s+ref=\{importRef\}\s+type="button"\s+className="btn sm-custom-action"/);
    expect(section).not.toMatch(/<span className="btn/);
    expect(section).toMatch(/<input\s+ref=\{pickerRef\}\s+type="file"\s+hidden/);
  });

  it("refuses at the ceiling with aria-disabled and without opening the picker", () => {
    expect(section).toContain("onClick={() => { if (!full) pickerRef.current?.click(); }}");
  });

  it("styles the button at the same size as Record", () => {
    expect(sheetText()).toContain("button.btn.sm-custom-action { align-self: flex-start;");
  });
});

describe("a Codex-only machine reaches every setting", () => {
  const codexOnly = { kind: "reported" as const, claude: false, codex: true };

  it("draws the gear, and no speaker, whatever the machine runs", () => {
    // The run takes no providers since the speaker left it: the gear is the
    // way to every setting on every machine.
    const html = renderToStaticMarkup(createElement(SettingsRun, {
      openSettings: noop, onFeedback: noop, watchUnseen: 0, setUsageHistoryOpen: noop, setBrowserWatchOpen: noop,
    }));
    expect(html).toMatch(/aria-label="Settings"/);
    expect(html).not.toMatch(/aria-label="Sound settings/);
    expect(html).not.toMatch(/M3\.2 5\.2h2/);
  });

  it("reaches the notification switches through Settings", () => {
    const html = drawSettings({ section: "notifications", providers: codexOnly });
    expect(html).toMatch(/role="switch" aria-checked="false" aria-labelledby="sm-notify-label"/);
    for (const kind of ["notifySwap", "notifyQuota", "notifyReset"]) {
      expect(html, kind).toMatch(new RegExp(`role="switch" aria-checked="(true|false)" aria-labelledby="sm-${kind}-label"`));
    }
  });

  it("keeps the Sounds section, and says in one line which tone plays there and for what", () => {
    const html = drawSettings({ section: "sounds", providers: codexOnly });
    expect(html).toContain(CODEX_ONLY_SOUNDS_NOTE.replace("'", "&#x27;"));
    expect(html).toMatch(/role="switch"/);
    // Only on that machine.
    expect(drawSettings({ section: "sounds" })).not.toContain("isn&#x27;t on this machine");
    // And true: a Codex rollout's turn ends in a Stop, which is the finish tone.
    expect(CODEX_ONLY_SOUNDS_NOTE).toMatch(/Turn finished/);
    const translate = readFileSync(new URL("../../server/codex-translate.mjs", import.meta.url), "utf8");
    expect(translate).toContain('hook_event_name: "Stop"');
  });

});

// ── nobody's settings reset ────────────────────────────────────────────────

describe("moving every control into Settings resets no setting", () => {
  it("keeps every browser key the moved controls read and write, spelled as before", () => {
    expect(THEME_KEY).toBe("agent-dag.theme");
    expect(CHARACTER_ENABLED_KEY).toBe("agent-dag.character-enabled");
    expect(FM_VOLUME_KEY).toBe("agent-dag.fm-volume");
    expect(FM_SOURCE_KEY).toBe("agent-dag.fm-source");
    expect(FM_MUTED_KEY).toBe("agent-dag.fm-muted");
    expect(FM_CUSTOM_STATIONS_KEY).toBe("agent-dag.fm-custom-stations");
    expect(LEVEL_KEYS).toEqual({ done: "agent-dag.soundLevel.done", "needs-input": "agent-dag.soundLevel.needs-input" });
    expect(FIGURE_KEYS).toEqual({ done: "agent-dag.soundFigure.done", "needs-input": "agent-dag.soundFigure.needs-input" });
    expect(sourceOf("use-sound-switch.ts")).toContain('readStored("agent-dag.sound")');
    expect(sourceOf("use-sound-switch.ts")).toContain('writeStored("agent-dag.sound", next ? "on" : "off")');
    const audio = sourceOf("notification-audio.ts");
    expect(audio).toContain('const DONE_CUSTOM_KEY = "agent-dag.soundCustom.done";');
    expect(audio).toContain('const ASKING_CUSTOM_KEY = "agent-dag.soundCustom.needs-input";');
  });

  it("keeps the server's notification fields, and their defaults", () => {
    expect(DEFAULTS.notifications).toBe(false);
    expect(DEFAULTS.notifySwap).toBe(true);
    expect(DEFAULTS.notifyQuota).toBe(false);
    expect(DEFAULTS.notifyReset).toBe(false);
  });

  it("writes nothing itself: every control still leaves through the hook that owned it", () => {
    for (const rel of [
      "settings.ts", "use-settings-menus.ts", "components/SettingsModal.tsx", "components/ThemeSection.tsx",
      "components/NotificationsSection.tsx", "components/SoundsSection.tsx", "components/SoundSwitch.tsx",
      "components/MusicSection.tsx", "components/KeyboardSection.tsx",
    ]) {
      const src = sourceOf(rel);
      expect(src, rel).not.toMatch(/localStorage|writeStored|readStored|sessionStorage|\/api\/prefs/);
    }
  });
});
