// Search in Settings (#2176): every setting a reader can look for, what it is
// called, where it lives, and the other words people type for it — and the
// ranking that turns what was typed into a short list — apart from React, so a
// plain-node test can hold the index to the rows the sections draw.
//
// Settings has eight sections and some forty controls, and a reader who wants
// "dark mode" does not know it is called Theme or that it is under Appearance.
// Every settings window this dialog follows answers that with a field at the
// top of its nav: type, see the matching settings with where each one lives,
// pick one and land on it. The list is short and ranked, not filtered in
// place, because the sections are pages of different shapes — a filter that
// hid rows would leave a theme grid with two previews in it and a Sounds page
// with half a tone.
//
// ONE ENTRY PER PLACE A RESULT CAN LAND. A setting's id is the `data-setting`
// its row carries (SettingRow's `settingId`, SettingsParts.tsx), so the jump
// finds the row by the id the index holds and nothing else; settings-search
// .test.ts reads the components and fails when a row gains an id the index does
// not list, or the index lists one no component draws. A section is an entry
// too, so "keyboard" finds the Keyboard page even where no row is called that.
// The keyboard shortcuts are not entries: Settings › Keyboard has its own
// filter for them, and forty of them here would bury the settings.
//
// Labels are the words the rows print, so a result and the row it lands on say
// the same thing; where a row's words come from a table (the themes, the
// account notifications, the characters) the entries come from that table too,
// and cannot drift from it. Keywords are what people type instead: synonyms,
// the other spelling, the word another app uses.

import { CHARACTERS } from "./character";
import { ACCOUNT_NOTIFY_SWITCHES } from "./notify-reach";
import { SETTINGS_SECTIONS, type SettingsSection } from "./settings";
import { CHIME_ORDER, type Chime } from "./sound";
import { THEME_DEFINITIONS, THEMES } from "./theme";

export interface SettingsEntry {
  /** The `data-setting` the jump scrolls to, or `section:<id>` for a section. */
  id: string;
  section: SettingsSection;
  /** The caption of the group the row is drawn under, when it is not the
   *  label itself. */
  group?: string;
  /** What the row is called, as it prints. */
  label: string;
  /** Other words for it, lower-case. */
  keywords: readonly string[];
  /** Drawn only where Claude Code is — the doors to the accounts panel — so
   *  offered only there (indexFor). */
  claudeOnly?: true;
}

const SECTION_PREFIX = "section:";

/** Whether a result opens a section rather than landing on a row in one. */
export function isSectionEntry(entry: SettingsEntry): boolean {
  return entry.id.startsWith(SECTION_PREFIX);
}

/** The words people use for each section as a whole, past its own name. A
 *  word that names one setting in it is that setting's keyword and not the
 *  section's: an equal match lists the section first, and "font" is asking
 *  for Text size, not for the page it is on. */
const SECTION_KEYWORDS: Record<SettingsSection, readonly string[]> = {
  general: ["behaviour", "behavior", "preferences"],
  appearance: ["look", "style"],
  reading: ["readability", "legibility"],
  keyboard: ["shortcuts", "hotkeys", "keybindings", "keys"],
  notifications: ["alerts", "notify"],
  sounds: ["audio", "tones", "chimes"],
  data: ["privacy", "local data"],
  about: ["information"],
};

/** The two tones as Settings › Sounds names them (TONE_LABEL in
 *  ToneSection.tsx, which is React and so cannot be imported here; the test
 *  holds the two spellings together). */
const TONE_LABEL: Record<Chime, string> = { done: "Turn finished", "needs-input": "Claude is asking" };
const TONE_KEYWORDS: Record<Chime, readonly string[]> = {
  done: ["done", "complete", "finished", "end of turn", "volume", "preview", "chime", "tone"],
  "needs-input": ["question", "needs input", "permission", "waiting", "volume", "preview", "chime", "tone"],
};

const ACCOUNT_KEYWORDS: Record<(typeof ACCOUNT_NOTIFY_SWITCHES)[number]["kind"], readonly string[]> = {
  notifySwap: ["auto-switch", "switch account", "swap", "alerts"],
  notifyQuota: ["quota", "limit", "rate limit", "usage", "alerts"],
  notifyReset: ["quota", "limit", "window", "available", "alerts"],
};

const sectionLabel = (section: SettingsSection) => SETTINGS_SECTIONS.find(s => s.id === section)?.label ?? section;

function sectionEntry(section: SettingsSection): SettingsEntry {
  return { id: `${SECTION_PREFIX}${section}`, section, label: sectionLabel(section), keywords: SECTION_KEYWORDS[section] };
}

/** Every entry, in nav order, each section's own entry first in its block. */
function buildIndex(): SettingsEntry[] {
  const rows: Record<SettingsSection, SettingsEntry[]> = {
    general: [
      { id: "hide-finished", section: "general", group: "Board", label: "Hide finished sessions after",
        keywords: ["finished", "done", "completed", "idle", "clean up", "auto hide", "canvas", "board", "remove"] },
      { id: "terminal", section: "general", group: "Terminal", label: "Type into sessions from the deck",
        keywords: ["terminal", "tmux", "shell", "console", "command line", "cli", "pane", "attach", "type", "beta"] },
      { id: "auto-update", section: "general", group: "Updates", label: "Update when idle",
        keywords: ["update", "auto update", "automatic updates", "upgrade", "restart", "new version"] },
      { id: "accounts", section: "general", group: "Elsewhere on the deck", label: "Accounts and auto-switch", claudeOnly: true,
        keywords: ["accounts", "auto-switch", "switch account", "login", "claude accounts"] },
      { id: "local-network", section: "general", group: "Elsewhere on the deck", label: "Local network", claudeOnly: true,
        keywords: ["lan", "pairing", "pair", "other machines", "sync", "network"] },
      { id: "browser-watch", section: "general", group: "Elsewhere on the deck", label: "Browser Watch",
        keywords: ["browser", "watch", "away", "automation", "security"] },
    ],
    appearance: [
      { id: "theme", section: "appearance", label: "Theme",
        keywords: ["colour theme", "color theme", "dark mode", "light mode", "colours", "colors", "palette", "skin"] },
      ...THEMES.map((theme): SettingsEntry => ({
        id: `theme-${theme}`, section: "appearance", group: "Theme", label: THEME_DEFINITIONS[theme].name,
        keywords: theme.endsWith("contrast") ? ["high contrast", "accessibility"] : [],
      })),
      { id: "character", section: "appearance", group: "Character", label: "Show the character",
        keywords: ["character", "mascot", "companion", "claude fm", "radio", "music", "minimap", "hide the character"] },
      { id: "character-choice", section: "appearance", group: "Character", label: "Choose character",
        keywords: ["mascot", "avatar", ...CHARACTERS.map(c => c.name.toLowerCase())] },
    ],
    reading: [
      { id: "text-size", section: "reading", label: "Text size",
        keywords: ["font", "font size", "zoom", "bigger", "larger", "smaller", "scale", "readability"] },
      { id: "density", section: "reading", label: "Density",
        keywords: ["spacing", "compact", "comfortable", "padding", "tight", "dense"] },
    ],
    keyboard: [
      { id: "single-keys", section: "keyboard", label: "Single-key shortcuts",
        keywords: ["single key", "letters", "voice control", "dictation", "accessibility"] },
    ],
    notifications: [
      { id: "notify-closed", section: "notifications", group: "While the deck is closed", label: "Notifications while closed",
        keywords: ["alerts", "desktop notifications", "browser notifications", "push", "background", "permission"] },
      ...ACCOUNT_NOTIFY_SWITCHES.map(({ kind, label }): SettingsEntry => ({
        id: kind, section: "notifications", group: "Accounts", label, keywords: ACCOUNT_KEYWORDS[kind],
      })),
    ],
    sounds: [
      { id: "play-sounds", section: "sounds", label: "Play sounds",
        keywords: ["sound", "mute", "unmute", "silence", "quiet"] },
      ...CHIME_ORDER.map((chime): SettingsEntry => ({
        id: `tone-${chime}`, section: "sounds", label: TONE_LABEL[chime], keywords: TONE_KEYWORDS[chime],
      })),
      { id: "custom-sounds", section: "sounds", label: "Custom sounds",
        keywords: ["voice", "speech", "text to speech", "spoken voice", "own sound", "library"] },
      { id: "custom-import", section: "sounds", group: "Custom sounds", label: "Import audio",
        keywords: ["import", "upload", "file", "mp3", "wav", "ogg", "own sound"] },
      { id: "custom-record", section: "sounds", group: "Custom sounds", label: "Record a clip",
        keywords: ["record", "microphone", "mic", "clip"] },
    ],
    data: [
      { id: "tool-history-retention", section: "data", group: "Tool history", label: "Keep history",
        keywords: ["retention", "delete history", "history", "days", "tool calls", "statistics"] },
      { id: "tool-history-size", section: "data", group: "Tool history", label: "Space used",
        keywords: ["storage", "disk", "size", "bytes"] },
      { id: "tool-history-clear", section: "data", group: "Tool history", label: "Clear history",
        keywords: ["delete history", "erase", "wipe", "remove"] },
    ],
    about: [
      { id: "version", section: "about", group: "ccdeck", label: "Version",
        keywords: ["update", "release", "build", "about"] },
      { id: "whats-new", section: "about", group: "ccdeck", label: "What's new",
        keywords: ["changelog", "release notes", "changes", "news"] },
      { id: "licence", section: "about", group: "ccdeck", label: "Licence",
        keywords: ["license", "agpl", "source", "source code", "open source", "github"] },
      { id: "tour", section: "about", group: "Tour and feedback", label: "Take the tour",
        keywords: ["tour", "guide", "help", "onboarding", "tutorial", "introduction"] },
      { id: "feedback", section: "about", group: "Tour and feedback", label: "Send feedback",
        keywords: ["feedback", "bug", "report", "contact", "suggestion", "idea"] },
    ],
  };
  return SETTINGS_SECTIONS.flatMap(({ id }) => [sectionEntry(id), ...rows[id]]);
}

export const SETTINGS_INDEX: readonly SettingsEntry[] = buildIndex();

/** The entries a deck can land on: without Claude Code, General draws no door
 *  to the accounts panel, and a result for one would open a section with no
 *  such row in it. */
export function indexFor(claudeHere: boolean): readonly SettingsEntry[] {
  return claudeHere ? SETTINGS_INDEX : SETTINGS_INDEX.filter(entry => !entry.claudeOnly);
}

/** Where a result lives, as its line in the list says it: "Appearance › Theme".
 *  A section is said as what it is. */
export function resultPlace(entry: SettingsEntry): string {
  if (isSectionEntry(entry)) return "Section";
  const section = sectionLabel(entry.section);
  return entry.group && entry.group !== entry.label ? `${section} › ${entry.group}` : section;
}

/** The result as a screen reader says it: the name, then the place, commas
 *  for the arrow a voice reads out as a character's name. */
export function resultSpoken(entry: SettingsEntry): string {
  return `${entry.label}, ${resultPlace(entry).replace(/ › /g, ", ")}`;
}

/** Lower case, no accents, single spaces, so "Thème" finds Theme and
 *  "COLOUR" finds colour. */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Whether `needle` starts a word of `hay`: at its start, or after anything
 *  that is not a letter or a digit. "sounds" in "play sounds", "90" in "at 90%",
 *  "switched" in "auto-switched" — but not "und" in "sounds". */
function startsAWord(hay: string, needle: string): boolean {
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
    if (at === 0 || !/[a-z0-9]/.test(hay[at - 1])) return true;
  }
  return false;
}

/** How well an entry answers a folded query, 0 best, or null for not at all.
 *  0, the label starts with it; 1, a word in the label does; 2, a keyword
 *  does; 3, only where it lives does — its section or its group; 4, a query of
 *  several words each of which is found somewhere above. */
function rank(entry: SettingsEntry, q: string): number | null {
  const label = fold(entry.label);
  if (label.startsWith(q)) return 0;
  if (startsAWord(label, q)) return 1;
  const keywords = entry.keywords.map(fold);
  if (keywords.some(k => startsAWord(k, q))) return 2;
  const place = [fold(sectionLabel(entry.section)), ...(entry.group ? [fold(entry.group)] : [])];
  if (place.some(p => startsAWord(p, q))) return 3;
  const words = q.split(" ");
  if (words.length > 1) {
    const everything = [label, ...keywords, ...place];
    if (words.every(w => everything.some(text => startsAWord(text, w)))) return 4;
  }
  return null;
}

/** As many results as a short window holds without a scroll. */
export const MAX_RESULTS = 12;

/** The entries that answer `query`, best first, nav order among equals, at
 *  most MAX_RESULTS. Nothing for an empty or blank query. */
export function searchSettings(query: string, index: readonly SettingsEntry[] = SETTINGS_INDEX): SettingsEntry[] {
  const q = fold(query);
  if (!q) return [];
  return index
    .map((entry, at) => ({ entry, at, score: rank(entry, q) }))
    .filter((hit): hit is { entry: SettingsEntry; at: number; score: number } => hit.score !== null)
    .sort((a, b) => a.score - b.score || a.at - b.at)
    .slice(0, MAX_RESULTS)
    .map(hit => hit.entry);
}

/** The line under the results' heading, and what the live region says. */
export function resultsLine(count: number, query: string): string {
  const said = query.trim();
  if (count === 0) return `No setting matches “${said}”.`;
  return count === 1 ? `1 setting matches “${said}”` : `${count} settings match “${said}”`;
}

/** What a key pressed in the search field does to the results. */
export type SearchKey =
  | { kind: "move"; index: number }
  | { kind: "open"; index: number }
  | { kind: "clear" }
  | { kind: "pass" };

/** Down and Up walk the results, round from either end the way a list under
 *  a field does; Enter opens the one on show; Escape empties a field that has
 *  something in it and otherwise is the dialog's, so a second Escape closes
 *  Settings as it always has. Everything else is the field's own. */
export function searchKeyIntent(key: string, query: string, count: number, active: number): SearchKey {
  if (key === "Escape") return query !== "" ? { kind: "clear" } : { kind: "pass" };
  if (count === 0) return { kind: "pass" };
  const at = Math.min(Math.max(active, 0), count - 1);
  if (key === "ArrowDown") return { kind: "move", index: (at + 1) % count };
  if (key === "ArrowUp") return { kind: "move", index: (at - 1 + count) % count };
  if (key === "Enter") return { kind: "open", index: at };
  return { kind: "pass" };
}
