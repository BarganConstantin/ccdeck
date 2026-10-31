// Search in Settings (#2176): every setting a reader can look for, what it is
// called, where it lives, and the other words people type for it — and the
// ranking that turns what was typed into a short list — apart from React, so a
// plain-node test can hold the index to the rows the sections draw.
//
// Settings has nine sections and some forty controls, and a reader who wants
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

import { CLAUDE_SETTING_GROUPS, CLAUDE_SETTINGS } from "../server/claude-settings-catalog.mjs";
import { CHARACTERS } from "./character";
import type { IntegrationsReach } from "./integrations/client";
import { ACCOUNT_NOTIFY_SWITCHES } from "./notify-reach";
import { SETTINGS_SECTIONS, type SettingsSection } from "./settings";
import { CHIME_ORDER } from "./sound";
import { THEMES } from "./theme";
import { themeName } from "./settings-names";
import { en } from "./i18n/en";
import { currentLanguage, t } from "./i18n";
import type { Vars } from "./i18n/translate";

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




const sectionLabel = (section: SettingsSection) => t(`settings.section.${section}.label`);

/** The words people type for an entry, in English (always: the product is
 *  documented in English, and many people type the English word whatever their
 *  language) and in the language on show, both from the catalog, comma
 *  separated, under `settings.search.kw.<name>`. */
function keywordsOf(name: string): readonly string[] {
  const key = `settings.search.kw.${name}`;
  const split = (text: string | undefined) => (text ? text.split(/\s*[,，、]\s*/).filter(Boolean) : []);
  const english = split(en[key]);
  if (currentLanguage() === "en") return english;
  const own = t(key);
  return [...english, ...(own === key ? [] : split(own))];
}

type Text = () => string;
/** The words of a catalog key, read when the entry is read so a change of
 *  language shows at once. */
const L = (key: string, vars?: Vars): Text => () => t(key, vars);

interface Spec {
  id: string;
  section: SettingsSection;
  group?: Text;
  label: Text;
  /** Which `settings.search.kw.*` entry holds the words; the id by default. */
  kw?: string;
  claudeOnly?: true;
  /** Words that are not in the catalog (a Claude Code setting's own). */
  words?: readonly string[];
}

/** An entry whose label, group and keywords follow the language on show. They
 *  are read where they are used (a getter), so the index built once at load is
 *  still right after the language changes. */
function entryOf(spec: Spec): SettingsEntry {
  const base: SettingsEntry = {
    id: spec.id,
    section: spec.section,
    get label() { return spec.label(); },
    get keywords() { return spec.words ?? keywordsOf(spec.kw ?? spec.id); },
    ...(spec.claudeOnly ? { claudeOnly: true as const } : {}),
  };
  return Object.defineProperty(base, "group", { get: () => spec.group?.(), enumerable: true });
}

function sectionEntry(section: SettingsSection): SettingsEntry {
  return entryOf({
    id: `${SECTION_PREFIX}${section}`, section, label: () => sectionLabel(section), kw: `section-${section}`,
    // Drawn only where Claude Code is (sectionsDrawn, settings.ts).
    ...(section === "claude" ? { claudeOnly: true as const } : {}),
  });
}

const CHARACTER_WORDS = ["deck companion", "fox", "penguin"];

/** Every entry, in nav order, each section's own entry first in its block. */
function buildIndex(): SettingsEntry[] {
  const recover = (provider: "Claude" | "Codex") => L("settings.recover.group", { provider });
  const rows: Record<SettingsSection, SettingsEntry[]> = {
    general: [
      entryOf({ id: "claude-session-recovery", claudeOnly: true, section: "general", group: recover("Claude"), label: L("settings.recover.name") }),
      entryOf({ id: "claude-continue-stopped", claudeOnly: true, section: "general", group: recover("Claude"), label: L("settings.recover.continueName") }),
      entryOf({ id: "codex-session-recovery", section: "general", group: recover("Codex"), label: L("settings.recover.name") }),
      entryOf({ id: "language", section: "general", group: L("settings.language.group"), label: L("settings.language.name") }),
      entryOf({ id: "hide-finished", section: "general", group: L("settings.board.title"), label: L("settings.board.hideLabel") }),
      entryOf({ id: "auto-update", section: "general", group: L("settings.updates.title"), label: L("settings.updates.label") }),
      entryOf({ id: "accounts", section: "general", group: L("settings.search.group.elsewhere"), label: L("settings.search.accounts"), claudeOnly: true }),
      entryOf({ id: "local-network", section: "general", group: L("settings.search.group.elsewhere"), label: L("settings.search.localNetwork"), claudeOnly: true }),
      entryOf({ id: "browser-watch", section: "general", group: L("settings.search.group.elsewhere"), label: L("settings.search.browserWatch") }),
    ],
    appearance: [
      entryOf({ id: "theme", section: "appearance", label: L("settings.theme.title") }),
      ...THEMES.map((theme): SettingsEntry => entryOf({
        id: `theme-${theme}`, section: "appearance", group: L("settings.theme.title"), label: () => themeName(theme),
        ...(theme.endsWith("contrast") ? { kw: "contrast" } : { words: [] }),
      })),
      entryOf({ id: "character", section: "appearance", group: L("settings.character.title"), label: L("settings.character.show") }),
      entryOf({
        id: "character-choice", section: "appearance", group: L("settings.character.title"), label: L("settings.character.choose"),
        // The names as printed, and as English has them, so either finds a character.
        get words() { return [...keywordsOf("character-choice"), ...CHARACTERS.map(c => c.name.toLowerCase()), ...CHARACTER_WORDS]; },
      } as Spec),
    ],
    reading: [
      entryOf({ id: "text-size", section: "reading", label: L("settings.reading.sizeTitle") }),
      entryOf({ id: "density", section: "reading", label: L("settings.reading.densityTitle") }),
    ],
    keyboard: [
      entryOf({ id: "single-keys", section: "keyboard", label: L("settings.keyboard.singleKeys") }),
    ],
    notifications: [
      entryOf({ id: "notify-closed", section: "notifications", group: L("settings.notify.closedGroup"), label: L("settings.notify.closedName") }),
      ...ACCOUNT_NOTIFY_SWITCHES.map(({ kind }): SettingsEntry => entryOf({
        id: kind, section: "notifications", group: L("settings.notify.accountsGroup"),
        label: () => ACCOUNT_NOTIFY_SWITCHES.find(s => s.kind === kind)?.label ?? kind,
      })),
    ],
    sounds: [
      entryOf({ id: "play-sounds", section: "sounds", label: L("settings.search.playSounds") }),
      ...CHIME_ORDER.map((chime): SettingsEntry => entryOf({
        id: `tone-${chime}`, section: "sounds", label: L(chime === "done" ? "settings.sounds.tone.done" : "settings.sounds.tone.needsInput"),
      })),
      entryOf({ id: "custom-sounds", section: "sounds", label: L("settings.sounds.custom.title") }),
      entryOf({ id: "custom-import", section: "sounds", group: L("settings.sounds.custom.title"), label: L("settings.sounds.custom.import") }),
      entryOf({ id: "custom-record", section: "sounds", group: L("settings.sounds.custom.title"), label: L("settings.sounds.custom.record") }),
    ],
    integrations: [
      // The names of the tools are the tools'.
      entryOf({ id: "integration-github", section: "integrations", label: () => "GitHub" }),
      entryOf({ id: "integration-gitlab", section: "integrations", label: () => "GitLab" }),
      entryOf({ id: "integration-jira", section: "integrations", label: () => "Jira" }),
      entryOf({ id: "integrations-add", section: "integrations", label: L("settings.search.connectTools") }),
      entryOf({ id: "integrations-connections", section: "integrations", label: L("settings.search.connections") }),
    ],
    data: [
      entryOf({ id: "tool-history-retention", section: "data", group: L("settings.tools.title"), label: L("settings.tools.keep") }),
      entryOf({ id: "tool-history-size", section: "data", group: L("settings.tools.title"), label: L("settings.tools.space") }),
      entryOf({ id: "tool-history-clear", section: "data", group: L("settings.tools.title"), label: L("settings.tools.clear") }),
    ],
    // From the table the rows are drawn from (claude-settings-catalog.mjs), in
    // its words — Claude Code's own, so they stay English — and a result and
    // its row cannot drift apart.
    claude: [
      ...CLAUDE_SETTINGS.map((entry): SettingsEntry => entryOf({
        id: `claude-${entry.id}`, claudeOnly: true, section: "claude",
        group: () => CLAUDE_SETTING_GROUPS.find(g => g.id === entry.group)?.title as string, label: () => entry.label, words: entry.keywords,
      })),
      entryOf({ id: "claude-all-settings", claudeOnly: true, section: "claude", label: L("settings.claudeIndex.title") }),
    ],
    radar: [
      entryOf({ id: "radar-open", section: "radar", label: L("settings.section.radar.label") }),
    ],
    about: [
      entryOf({ id: "version", section: "about", group: () => "ccdeck", label: L("settings.about.version") }),
      entryOf({ id: "whats-new", section: "about", group: () => "ccdeck", label: L("settings.about.whatsNew") }),
      entryOf({ id: "licence", section: "about", group: () => "ccdeck", label: L("settings.about.licence") }),
      entryOf({ id: "sponsor", section: "about", group: () => "ccdeck", label: L("settings.about.sponsor") }),
      entryOf({ id: "tour", section: "about", group: L("settings.about.helpGroup"), label: L("settings.about.tour") }),
      entryOf({ id: "feedback", section: "about", group: L("settings.about.helpGroup"), label: L("settings.about.feedback") }),
    ],
  };
  return SETTINGS_SECTIONS.flatMap(({ id }) => [sectionEntry(id), ...rows[id]]);
}

export const SETTINGS_INDEX: readonly SettingsEntry[] = buildIndex();

/** The entries a deck can land on: without Claude Code, General draws no door
 *  to the accounts panel, and a result for one would open a section with no
 *  such row in it. A deck that offers no integration draws no Integrations
 *  section, or only its stranded connections (integrationsReach), so it is
 *  offered nothing there, or nothing but Connections. */
export function indexFor(claudeHere: boolean, integrations: IntegrationsReach = "all", kinds?: ReadonlySet<string>): readonly SettingsEntry[] {
  if (claudeHere && integrations === "all" && !kinds) return SETTINGS_INDEX;
  return SETTINGS_INDEX.filter(entry =>
    (claudeHere || !entry.claudeOnly)
    && (!kinds || !entry.id.startsWith("integration-") || kinds.has(entry.id.slice("integration-".length)))
    && (entry.section !== "integrations" || integrations === "all"
      || (integrations === "connections" && (isSectionEntry(entry) || entry.id === "integrations-connections"))));
}

/** Where a result lives, as its line in the list says it: "Appearance › Theme".
 *  A section is said as what it is. */
export function resultPlace(entry: SettingsEntry): string {
  if (isSectionEntry(entry)) return t("settings.search.section");
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
  if (count === 0) return t("settings.search.none", { query: said });
  return count === 1 ? t("settings.search.one", { query: said }) : t("settings.search.many", { count, query: said });
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
