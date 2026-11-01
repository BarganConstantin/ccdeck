// What quick open can reach, built where the presses live: the stripes' doors
// as rail-items.tsx defines them, the sessions as the session list orders
// them, Settings' sections and rows as its own search finds them, the canvas
// actions and the themes. Each item says
// what Enter does in words, and carries the key it already has, so the field
// teaches the deck's shortcuts as it is used.
import { liveKey, type RailItem } from "./components/EdgeRails";
import type { RailItems } from "./rail-items";
import { elapsedShort, type Row } from "./components/SessionList";
import { isAlarming } from "./ambient-counts";
import { SETTINGS_SECTIONS, type SettingsSection } from "./settings";
import { isSectionEntry, resultPlace, type SettingsEntry } from "./settings-search";
import { THEME_DEFINITIONS, THEMES, type Theme } from "./theme";
import type { QuickItem } from "./quick-open";
import { t } from "./i18n";
import SettingsSectionGlyph from "./components/SettingsSectionGlyph";
import { ArrangeGlyph, ClearGlyph, FitGlyph, PauseGlyph, TourGlyph } from "./components/rail-glyphs";

/** Words that find a door without being in its name. */
const DOOR_WORDS: Record<string, readonly string[]> = {
  "session-list": ["sessions", "agents"],
  accounts: ["claude", "login", "switch account"],
  "account-capacity": ["limits", "quota", "5h", "7d"],
  "reset-calendar": ["limits", "weekly", "reset"],
  usage: ["cost", "spend", "quota", "tokens", "money"],
  machine: ["cpu", "memory", "ram", "temperature", "system", "load"],
  history: ["cost", "spend", "chart", "days"],
  "tool-activity": ["tools", "commands", "bash", "slow"],
  "skill-activity": ["skills"],
  "browser-watch": ["browser", "history"],
  "traffic-radar": ["telemetry", "network", "connections"],
  radio: ["music", "fm", "stations"],
  settings: ["preferences", "options"],
  feedback: ["bug", "report", "idea", "contact"],
  "explore-integrations": ["jira", "github", "gitlab", "connect"],
};

/** Settings' rows that are doors out to something quick open lists itself:
 *  the field offers the thing, not the button in Settings that opens it. The
 *  themes are listed as themes, for the same reason. */
const OPENED_ELSEWHERE = new Set(["accounts", "browser-watch", "radar-open", "tour", "feedback"]);

function settingItem(entry: SettingsEntry, openSettings: QuickOpenSources["openSettings"]): QuickItem {
  const glyph = <SettingsSectionGlyph section={entry.section} />;
  if (isSectionEntry(entry)) {
    return {
      id: `settings:${entry.id}`, section: "settings", title: entry.label,
      subtitle: SETTINGS_SECTIONS.find(s => s.id === entry.section)?.note,
      keywords: ["settings", ...entry.keywords], tag: t("board.quick.tag.settings"), verb: t("board.quick.verb.openInSettings"), glyph,
      run: () => openSettings(entry.section),
    };
  }
  const place = resultPlace(entry);
  return {
    id: `settings:${entry.id}`, section: "settings", title: entry.label, subtitle: place,
    keywords: [...entry.keywords, ...place.split(" › ")], tag: t("board.quick.tag.setting"), verb: t("board.quick.verb.goSetting"), glyph,
    queryOnly: true,
    run: () => openSettings(entry.section, entry.id),
  };
}

function doorItem(door: RailItem, singleKeys: boolean): QuickItem {
  const panel = door.kind === "panel";
  return {
    id: `door:${door.id}`,
    section: "open",
    title: door.hint ?? door.menu ?? door.label,
    subtitle: door.detail?.split("\n")[0],
    keywords: [door.label, door.short, ...(DOOR_WORDS[door.id] ?? []), ...(door.detail ? [door.detail] : [])],
    tag: panel ? (door.open ? t("board.quick.tag.shown") : t("board.quick.tag.panel")) : t("board.quick.tag.dialog"),
    verb: panel ? (door.open ? t("board.quick.verb.hidePanel") : t("board.quick.verb.showPanel")) : t("board.quick.verb.open"),
    keyCap: liveKey(door.key, singleKeys)?.cap,
    glyph: door.glyph,
    run: door.onPress,
  };
}

/** A session's state in the words its row and card use. */
export function sessionLine(row: Pick<Row, "state" | "waiting" | "label" | "cwdBasename">, now: number): { line: string; tone: QuickItem["tone"] } {
  const where = row.cwdBasename && row.cwdBasename !== row.label ? ` · ${row.cwdBasename}` : "";
  if (row.waiting && isAlarming(row.waiting)) return { line: `${t("board.quick.needsYou")} · ${elapsedShort(row.waiting.since, undefined, now)}${where}`, tone: "waiting" };
  if (row.state === "active") return { line: `${t("board.quick.working")}${where}`, tone: "active" };
  if (row.state === "err") return { line: `${t("board.quick.failed")}${where}`, tone: "err" };
  return { line: `${t("board.quick.done")}${where}`, tone: "done" };
}

export interface QuickOpenSources {
  rails: RailItems;
  /** In the session list's order: who needs you first. */
  sessions: readonly Row[];
  now: number;
  openSession: (sessionId: string) => void;
  /** Settings' search index as this deck draws it (indexFor): its sections,
   *  and every row a search can land on. */
  settings: readonly SettingsEntry[];
  openSettings: (section?: SettingsSection, landOn?: string) => void;
  singleKeys: boolean;
  fit: () => void;
  rearrange: () => void;
  paused: boolean;
  togglePause: () => void;
  /** Absent while the canvas has nothing to clear. */
  clear?: () => void;
  keyHelp: () => void;
  tour: () => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

export function quickOpenItems(src: QuickOpenSources): QuickItem[] {
  const key = (cap: string) => (src.singleKeys ? cap : undefined);
  const doors = [
    ...src.rails.left, ...(src.rails.codexDoor ?? []), ...src.rails.capacity, ...src.rails.right.flat(),
    ...src.rails.integrations, ...src.rails.explore, ...src.rails.utilities,
  ];
  const items: QuickItem[] = [];

  for (const row of src.sessions) {
    const { line, tone } = sessionLine(row, src.now);
    items.push({
      id: `session:${row.sessionId}`,
      section: "sessions",
      title: row.label,
      subtitle: line,
      keywords: [row.cwdBasename ?? "", row.modelId ?? ""].filter(Boolean),
      tag: t("board.quick.tag.session"),
      verb: t("board.quick.verb.goSession"),
      tone,
      run: () => src.openSession(row.sessionId),
    });
  }

  for (const door of doors) items.push(doorItem(door, src.singleKeys));

  for (const entry of src.settings) {
    if (entry.id.startsWith("theme-") || OPENED_ELSEWHERE.has(entry.id)) continue;
    items.push(settingItem(entry, src.openSettings));
  }

  items.push(
    { id: "action:fit", section: "actions", title: t("board.quick.action.fit"), keywords: ["zoom", "view", "recenter"],
      tag: t("board.quick.tag.action"), verb: t("board.quick.verb.run"), keyCap: key("F"), glyph: <FitGlyph />, run: src.fit },
    { id: "action:rearrange", section: "actions", title: t("board.controls.arrangeLabel"), keywords: ["layout", "tidy", "pins"],
      tag: t("board.quick.tag.action"), verb: t("board.quick.verb.run"), keyCap: key("R"), glyph: <ArrangeGlyph />, run: src.rearrange },
    { id: "action:pause", section: "actions", title: src.paused ? t("board.quick.action.resume") : t("board.quick.action.pause"), keywords: ["pause", "resume", "freeze", "live"],
      tag: t("board.quick.tag.action"), verb: t("board.quick.verb.run"), keyCap: key("Space"), glyph: <PauseGlyph />, run: src.togglePause },
    { id: "action:keys", section: "actions", title: t("board.controls.keys"), keywords: ["keys", "help", "?"],
      tag: t("board.quick.tag.action"), verb: t("board.quick.verb.open"), keyCap: key("?"), glyph: <SettingsSectionGlyph section="keyboard" />, run: src.keyHelp },
    { id: "action:tour", section: "actions", title: t("board.hero.tour"), keywords: ["help", "guide", "intro", "start"],
      tag: t("board.quick.tag.action"), verb: t("board.quick.verb.start"), glyph: <TourGlyph />, run: src.tour },
  );
  if (src.clear) {
    items.push({ id: "action:clear", section: "actions", title: t("board.quick.action.clear"), subtitle: t("board.quick.asksFirst"),
      keywords: ["clear", "reset", "empty", "delete"], tag: t("board.quick.tag.action"), verb: t("board.quick.verb.askFirst"), keyCap: key("C"), glyph: <ClearGlyph />, run: src.clear });
  }

  for (const theme of THEMES) {
    const def = THEME_DEFINITIONS[theme];
    items.push({
      id: `theme:${theme}`,
      section: "themes",
      title: def.name,
      keywords: ["theme", def.colorScheme],
      tag: theme === src.theme ? t("board.quick.tag.current") : t("board.quick.tag.theme"),
      verb: t("board.quick.verb.useTheme"),
      queryOnly: true,
      glyph: <span className="appearance-preview qo-swatch" data-swatch={theme} />,
      run: () => src.setTheme(theme),
    });
  }
  return items;
}
