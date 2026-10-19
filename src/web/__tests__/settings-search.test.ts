// Search in Settings (#2176): the index of everything a reader can find, the
// order a query ranks it in, the keys the field answers, the chord that
// reaches it, and the markup that keeps the nav a tablist with the field
// above it.
//
// No DOM in this suite. The index is held to the components by reading their
// source: every `data-setting` a section draws is a place a result can land,
// so each must have an entry, and an entry with no row drawn anywhere would be
// a result that jumps to nothing.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  fold, isSectionEntry, MAX_RESULTS, resultPlace, resultSpoken, resultsLine, searchKeyIntent, searchSettings,
  SETTINGS_INDEX, type SettingsEntry,
} from "../settings-search";
import { isFindChord, SETTINGS_SECTIONS } from "../settings";
import { THEMES, THEME_DEFINITIONS } from "../theme";
import { ACCOUNT_NOTIFY_SWITCHES } from "../notify-reach";
import { CHIME_ORDER } from "../sound";
import { TONE_LABEL } from "../components/ToneSection";
import SettingsModal, { type SettingsModalProps } from "../components/SettingsModal";
import { DEFAULT_PREFS } from "../sound";
import { ACCOUNT_NOTIFY_DEFAULTS } from "../use-os-notifications";
import { clientPairs, clientText } from "./client-source";

const labels = (results: readonly SettingsEntry[]) => results.map(r => r.label);
const ids = (results: readonly SettingsEntry[]) => results.map(r => r.id);

// ── the index, against what the sections draw ──────────────────────────────

/** Every `settingId=` and `data-setting=` in the components, comments gone.
 *  A literal is an id; an expression is one of the few the sections build
 *  from a table, expanded from that table here, and any other expression
 *  fails — a new one has to say what it expands to. */
function renderedIds(): { found: Set<string>; unknown: string[] } {
  const DYNAMIC: Record<string, readonly string[]> = {
    "SessionRecoverySettings.tsx {settingId}": ["codex-session-recovery", "claude-session-recovery"],
    "NotificationsSection.tsx {kind}": ACCOUNT_NOTIFY_SWITCHES.map(s => s.kind),
    "ThemeSection.tsx {`theme-${choice}`}": THEMES.map(t => `theme-${t}`),
    "ToneSection.tsx {`tone-${chime}`}": CHIME_ORDER.map(c => `tone-${c}`),
  };
  const found = new Set<string>();
  const unknown: string[] = [];
  for (const [path, src] of clientPairs()) {
    // The markup only: a hook that looks a row up by the attribute
    // (use-settings-jump.ts) names it too, in a selector.
    if (!path.startsWith("components/") || !path.endsWith(".tsx")) continue;
    const file = path.slice("components/".length);
    for (const m of src.matchAll(/\b(?:settingId|data-setting)=(?:"([^"]+)"|\{(`[^`]*`|[^}]*)\})/g)) {
      if (m[1]) { found.add(m[1]); continue; }
      // The props that carry the id through to the markup: the shared parts'
      // and General's door rows, whose literal ids are on each DoorRow.
      if ((file === "SettingsParts.tsx" || file === "ElsewhereSection.tsx") && m[2] === "settingId") continue;
      const expanded = DYNAMIC[`${file} {${m[2]}}`];
      if (expanded) expanded.forEach(id => found.add(id));
      else unknown.push(`${file}: ${m[0]}`);
    }
  }
  return { found, unknown };
}

describe("the index holds every place a result can land", () => {
  it("knows every expression a section builds a setting id from", () => {
    expect(renderedIds().unknown).toEqual([]);
  });

  it("has an entry for every row a section draws, and draws a row for every entry", () => {
    const { found } = renderedIds();
    const indexed = new Set(SETTINGS_INDEX.filter(e => !isSectionEntry(e)).map(e => e.id));
    expect([...found].filter(id => !indexed.has(id)).sort(), "rows with no index entry").toEqual([]);
    expect([...indexed].filter(id => !found.has(id)).sort(), "entries with no row").toEqual([]);
    // If the source scan ever matched nothing, both lists above would pass.
    expect(found.size).toBeGreaterThan(20);
  });

  it("has one entry per section, under the nav's own name, in nav order", () => {
    const sections = SETTINGS_INDEX.filter(isSectionEntry);
    expect(sections.map(e => e.section)).toEqual(SETTINGS_SECTIONS.map(s => s.id));
    expect(sections.map(e => e.label)).toEqual(SETTINGS_SECTIONS.map(s => s.label));
  });

  it("keeps the index in nav order, so equal matches read in the order the nav does", () => {
    const order = SETTINGS_SECTIONS.map(s => s.id);
    const at = SETTINGS_INDEX.map(e => order.indexOf(e.section));
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it("gives every entry a unique id and a label a component prints", () => {
    expect(new Set(SETTINGS_INDEX.map(e => e.id)).size).toBe(SETTINGS_INDEX.length);
    const text = clientText();
    const unprinted = SETTINGS_INDEX
      .filter(e => !text.includes(`"${e.label}"`) && !text.includes(`>${e.label}<`))
      .map(e => e.label);
    expect(unprinted).toEqual([]);
  });

  it("names the tones as Settings › Sounds names them", () => {
    for (const chime of CHIME_ORDER) {
      expect(SETTINGS_INDEX.find(e => e.id === `tone-${chime}`)?.label).toBe(TONE_LABEL[chime]);
    }
  });

  it("names every theme by its name, under Appearance › Theme", () => {
    for (const theme of THEMES) {
      const entry = SETTINGS_INDEX.find(e => e.id === `theme-${theme}`)!;
      expect(entry.label).toBe(THEME_DEFINITIONS[theme].name);
      expect(resultPlace(entry)).toBe("Appearance › Theme");
    }
  });

  it("writes every keyword in lower case, so the index reads as one voice", () => {
    expect(SETTINGS_INDEX.flatMap(e => e.keywords).filter(k => k !== k.toLowerCase())).toEqual([]);
  });
});

// ── the ranking ─────────────────────────────────────────────────────────────

describe("searchSettings ranks what was typed", () => {
  it("finds nothing for an empty or blank query", () => {
    expect(searchSettings("")).toEqual([]);
    expect(searchSettings("   ")).toEqual([]);
  });

  it("puts a label that starts with the query before one with a word that does, before a keyword", () => {
    // "Dark" starts with it, "Gruvbox Dark" has a word that does, and Theme
    // is found by its keyword "dark mode".
    expect(labels(searchSettings("dark"))).toEqual(["Dark", "Gruvbox Dark", "Theme"]);
    expect(labels(searchSettings("light"))).toEqual(["Light", "Gruvbox Light", "Theme"]);
  });

  it("ranks a section by its name like any other label", () => {
    const sound = labels(searchSettings("sound"));
    expect(sound.slice(0, 3)).toEqual(["Sounds", "Play sounds", "Custom sounds"]);
  });

  it("puts a keyword match before a setting found only by its section's name", () => {
    // Notifications while closed starts with the word; the four account
    // switches are found by their section alone, and come after it.
    expect(ids(searchSettings("notifications"))).toEqual([
      "section:notifications", "notify-closed", "notifySwap", "notifyQuota", "notifyReset", "notifyStopped",
    ]);
    // "alerts" is a keyword of the five switches and of the section.
    const alerts = ids(searchSettings("alerts"));
    expect(alerts[0]).toBe("section:notifications");
    expect(alerts).toEqual(expect.arrayContaining(["notify-closed", "notifySwap", "notifyQuota", "notifyReset", "notifyStopped"]));
  });

  it("answers the words people type for a setting", () => {
    const first = (q: string) => searchSettings(q)[0]?.id;
    expect(first("dark mode")).toBe("theme");
    expect(first("colour")).toBe("theme");
    expect(first("color")).toBe("theme");
    expect(first("font")).toBe("text-size");
    expect(first("zoom")).toBe("text-size");
    expect(first("spacing")).toBe("density");
    expect(first("mute")).toBe("play-sounds");
    expect(first("hotkeys")).toBe("section:keyboard");
    expect(ids(searchSettings("shortcuts"))).toEqual(["single-keys", "section:keyboard"]);
    expect(first("quota")).toBe("notifyQuota");
    expect(first("retention")).toBe("tool-history-retention");
    expect(ids(searchSettings("delete history"))).toEqual(expect.arrayContaining(["tool-history-retention", "tool-history-clear"]));
    expect(first("version")).toBe("version");
    expect(ids(searchSettings("update"))).toContain("version");
    expect(ids(searchSettings("volume"))).toEqual(["tone-done", "tone-needs-input"]);
  });

  it("ignores case and accents", () => {
    expect(ids(searchSettings("THEME"))).toEqual(ids(searchSettings("theme")));
    expect(searchSettings("thème")[0]?.id).toBe("theme");
    expect(searchSettings("Dénsity")[0]?.id).toBe("density");
    expect(fold("  Thème   Sombre ")).toBe("theme sombre");
  });

  it("matches the start of a word, not the middle of one", () => {
    // "und" is inside "sounds" and "found" but starts no word of the index.
    expect(searchSettings("und")).toEqual([]);
    // A word after a hyphen or before a sign is still a word.
    expect(searchSettings("switched")[0]?.id).toBe("notifySwap");
    expect(searchSettings("90")[0]?.id).toBe("notifyQuota");
  });

  it("finds a query of several words when each is found somewhere in the entry", () => {
    // Neither word starts a tone's name; "volume" is a keyword of both and
    // "sound" starts the name of the section they are in.
    expect(ids(searchSettings("sound volume"))).toEqual(["tone-done", "tone-needs-input"]);
    expect(ids(searchSettings("quota reset"))[0]).toBe("notifyReset");
  });

  it("returns at most a short window's worth", () => {
    for (const q of ["s", "t", "a", "c"]) expect(searchSettings(q).length).toBeLessThanOrEqual(MAX_RESULTS);
    expect(searchSettings("s").length).toBe(MAX_RESULTS);
  });
});

// ── what a result says ──────────────────────────────────────────────────────

describe("a result says what it is and where it lives", () => {
  const entry = (id: string) => SETTINGS_INDEX.find(e => e.id === id)!;

  it("names the place as section › group, and drops a group that is the label", () => {
    expect(resultPlace(entry("theme-light"))).toBe("Appearance › Theme");
    expect(resultPlace(entry("theme"))).toBe("Appearance");
    expect(resultPlace(entry("notifyQuota"))).toBe("Notifications › Accounts");
    expect(resultPlace(entry("text-size"))).toBe("Text & density");
    expect(resultPlace(entry("section:sounds"))).toBe("Section");
  });

  it("says the place in commas to a screen reader, not in arrows", () => {
    expect(resultSpoken(entry("theme-light"))).toBe("Light, Appearance, Theme");
  });

  it("counts the matches in a sentence that agrees with its number", () => {
    expect(resultsLine(3, "dark")).toBe("3 settings match “dark”");
    expect(resultsLine(1, " dark ")).toBe("1 setting matches “dark”");
    expect(resultsLine(0, "xyz")).toBe("No setting matches “xyz”.");
  });
});

// ── the keys ────────────────────────────────────────────────────────────────

describe("the search field's keys", () => {
  it("walks the results round from either end", () => {
    expect(searchKeyIntent("ArrowDown", "s", 3, 0)).toEqual({ kind: "move", index: 1 });
    expect(searchKeyIntent("ArrowDown", "s", 3, 2)).toEqual({ kind: "move", index: 0 });
    expect(searchKeyIntent("ArrowUp", "s", 3, 0)).toEqual({ kind: "move", index: 2 });
    expect(searchKeyIntent("ArrowUp", "s", 3, 1)).toEqual({ kind: "move", index: 0 });
  });

  it("opens the highlighted result on Enter, and leaves Enter alone with nothing to open", () => {
    expect(searchKeyIntent("Enter", "s", 3, 1)).toEqual({ kind: "open", index: 1 });
    expect(searchKeyIntent("Enter", "s", 3, 7)).toEqual({ kind: "open", index: 2 });
    expect(searchKeyIntent("Enter", "xyz", 0, 0)).toEqual({ kind: "pass" });
    expect(searchKeyIntent("ArrowDown", "", 0, 0)).toEqual({ kind: "pass" });
  });

  it("empties a field with something in it on Escape, and hands an empty field's Escape to the dialog", () => {
    expect(searchKeyIntent("Escape", "dark", 3, 0)).toEqual({ kind: "clear" });
    expect(searchKeyIntent("Escape", "xyz", 0, 0)).toEqual({ kind: "clear" });
    expect(searchKeyIntent("Escape", "  ", 0, 0)).toEqual({ kind: "clear" });
    expect(searchKeyIntent("Escape", "", 0, 0)).toEqual({ kind: "pass" });
  });

  it("leaves every other key to the field", () => {
    for (const key of ["a", "T", " ", "Home", "End", "ArrowLeft", "Backspace", "Tab"]) {
      expect(searchKeyIntent(key, "dark", 3, 0), key).toEqual({ kind: "pass" });
    }
  });
});

describe("Cmd/Ctrl+F reaches the field", () => {
  const key = (over: Partial<{ key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }>) =>
    ({ key: "f", code: "KeyF", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over });

  it("is Ctrl+F or Cmd+F on any platform", () => {
    expect(isFindChord(key({ ctrlKey: true }))).toBe(true);
    expect(isFindChord(key({ metaKey: true }))).toBe(true);
    expect(isFindChord(key({ ctrlKey: true, key: "F" }))).toBe(true);
  });

  it("is not F alone, nor somebody else's chord", () => {
    expect(isFindChord(key({}))).toBe(false);
    expect(isFindChord(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isFindChord(key({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isFindChord(key({ ctrlKey: true, key: "g", code: "KeyG" }))).toBe(false);
  });

  it("reads the letter on the key, and the key's place only where the layout has no Latin letters", () => {
    // Dvorak's F is where QWERTY has Y; its key marked U is where F is.
    expect(isFindChord(key({ ctrlKey: true, key: "f", code: "KeyY" }))).toBe(true);
    expect(isFindChord(key({ ctrlKey: true, key: "u", code: "KeyF" }))).toBe(false);
    // A Russian layout types "а" on the key where F is.
    expect(isFindChord(key({ ctrlKey: true, key: "а", code: "KeyF" }))).toBe(true);
  });
});

// ── the markup ──────────────────────────────────────────────────────────────

const noop = () => {};
const asyncNoop = async () => {};
const drawSettings = () => renderToStaticMarkup(createElement(SettingsModal, {
  section: "general", onSection: noop, onClose: noop,
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
  // About's and General's inputs (#2176).
  versionCheck: { version: null, notice: null, noticeOpen: false, showNotice: noop, dismissNotice: noop, versionChecking: false, loadVersion: async () => null },
  desktopUpdate: { desktopUpdateRestarting: false, desktopUpdateFailure: null, readyAppUpdate: null, appUpdate: null, askDesktopUpdateRestart: asyncNoop, onDesktopUpdateEvent: noop },
  restart: { autoRestart: true, toggleAutoRestart: noop },
  doors: { whatsNew: noop, update: noop, tour: noop, feedback: noop, accounts: noop, localNetwork: noop, browserWatch: noop },
} as unknown as SettingsModalProps));

describe("the field stands above the nav, which stays a tablist", () => {
  const html = drawSettings();
  const side = /<div class="settings-side">([\s\S]*?)<div class="settings-pane"/.exec(html)?.[1] ?? "";

  it("puts a search field, named by a label, at the top of the nav's column", () => {
    const field = /<input[^>]*type="search"[^>]*>/.exec(side)?.[0] ?? "";
    expect(field).toMatch(/id="settings-search-field"/);
    expect(field).toMatch(/placeholder="Search settings"/);
    expect(field).toMatch(/role="combobox"/);
    // Collapsed with nothing typed: no list to point at yet.
    expect(field).toMatch(/aria-expanded="false"/);
    expect(field).not.toMatch(/aria-activedescendant/);
    expect(side).toMatch(/<label class="vis-hidden" for="settings-search-field">Search settings<\/label>/);
    expect(side.indexOf("settings-search-field")).toBeLessThan(side.indexOf('role="tablist"'));
  });

  it("keeps nothing but tabs in the tablist", () => {
    const strip = /<div class="settings-nav" role="tablist"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
    const children = [...strip.matchAll(/<button[^>]*>/g)].map(m => m[0]);
    expect(children).toHaveLength(SETTINGS_SECTIONS.length);
    for (const tab of children) expect(tab).toMatch(/role="tab"/);
    expect(strip).not.toMatch(/<input/);
  });

  it("shows the section, not results, while the field is empty", () => {
    expect(html).toMatch(/role="tabpanel"/);
    expect(/<div[^>]*role="tabpanel"[^>]*>/.exec(html)?.[0]).not.toMatch(/hidden/);
    expect(html).not.toMatch(/settings-results/);
  });
});
