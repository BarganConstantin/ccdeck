// Quick open: one field that reaches everything the deck can open (owner,
// 2026-10-24, after the UI review scored "recognition rather than recall" 1 of
// 4). Thirteen doors on the stripes said their names only under a 450ms hover,
// seven had no key, and Settings, the sessions and the deck's actions each had
// their own way in. ⌘K (Ctrl+K off a Mac) opens a field in the manner of
// Raycast and VS Code: type a few letters of a panel, a session, a setting,
// an action or a theme, and Enter opens it.
//
// This file is the part a bare-node suite can call: what matches, in what
// order, what was opened recently, and which chord opens it. The items
// themselves are built where the presses live (quick-open-items.tsx), and
// drawn by components/QuickOpen.tsx.
import type { ReactNode } from "react";
import { readStored, writeStored } from "./storage";
import { t, type TFunction } from "./i18n";

/** The sections, in the order an empty field lists them. */
export type QuickSection = "recent" | "sessions" | "open" | "settings" | "actions" | "themes";

export const SECTION_TITLES: Record<QuickSection, string> = {
  recent: "Recent",
  sessions: "Sessions",
  open: "Panels and dialogs",
  settings: "Settings",
  actions: "Actions",
  themes: "Themes",
};

/** The section titles in the language on show; SECTION_TITLES stays the English. */
export const sectionTitle = (key: QuickSection, tr: TFunction = t): string => tr(`board.quick.section.${key}`);

const SECTION_ORDER: readonly QuickSection[] = ["recent", "sessions", "open", "settings", "actions", "themes"];

export interface QuickItem {
  /** Stable across loads: what the recent list stores. */
  id: string;
  section: Exclude<QuickSection, "recent">;
  title: string;
  /** One muted line after the title: a session's state, a door's purpose. */
  subtitle?: string;
  /** Words that find the item without being in its title: "cost" for Usage. */
  keywords?: readonly string[];
  /** The word on the row's right: Panel, Dialog, Session, Theme. */
  tag: string;
  /** What Enter does, said in the footer: "Show panel", "Go to session". */
  verb: string;
  /** Its own key, where it has one: U, ⌘,. */
  keyCap?: string;
  glyph?: ReactNode;
  /** A session's state, drawn as its dot. */
  tone?: "waiting" | "active" | "done" | "err";
  /** Listed only once something is typed: a theme, a single setting. There
   *  are dozens, and an empty field is the map of the deck, not the index. */
  queryOnly?: true;
  run: () => void;
}

/** Where the query met the title, and how well. */
export interface QuickMatch {
  score: number;
  /** Indices into the title, for the highlight; empty for a keyword match. */
  hits: number[];
}

export interface RankedItem {
  item: QuickItem;
  hits: number[];
}

export interface RankedSection {
  section: QuickSection;
  title: string;
  items: RankedItem[];
}

const WORD_BREAK = /[\s\-_./·:,()›]/;

function wordStart(text: string, i: number): boolean {
  return i === 0 || WORD_BREAK.test(text[i - 1]);
}

function isSubsequence(q: string, t: string, from: number): boolean {
  let i = from;
  for (const ch of q) {
    i = t.indexOf(ch, i);
    if (i < 0) return false;
    i++;
  }
  return true;
}

/**
 * How well `query` finds `text`, or null when it does not.
 *
 * A run of the query inside the text wins outright, more so at the start of a
 * word and most at the start of the text: "set" finds Settings before it
 * finds Reset calendar. Failing that, the letters in order, each one taken
 * at the start of a word where the rest still fits, so "ta" is Tool activity
 * and "rb" is Rider Black. The first of them must start a word, as in VS
 * Code's quick open: "us" scattered over "Claude accounts" is noise, not an
 * answer. Spaces in the query are ignored there.
 */
export function fuzzyMatch(query: string, text: string): QuickMatch | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, hits: [] };
  const t = text.toLowerCase();
  const at = t.indexOf(q);
  if (at >= 0) {
    const score = 1000 - at + (wordStart(t, at) ? 200 : 0) + (at === 0 ? 300 : 0) + (q.length === t.length ? 500 : 0);
    return { score, hits: Array.from({ length: q.length }, (_, i) => at + i) };
  }
  const letters = q.replace(/\s+/g, "");
  if (!isSubsequence(letters, t, 0)) return null;
  const hits: number[] = [];
  let from = 0;
  let score = 100;
  for (let n = 0; n < letters.length; n++) {
    const ch = letters[n];
    const rest = letters.slice(n + 1);
    let pick = t.indexOf(ch, from);
    for (let i = pick; i >= 0; i = t.indexOf(ch, i + 1)) {
      if (!isSubsequence(rest, t, i + 1)) break;
      if (wordStart(t, i)) { pick = i; break; }
    }
    if (n === 0 && !wordStart(t, pick)) return null;
    const prev = hits[hits.length - 1];
    score += wordStart(t, pick) ? 12 : 2;
    if (prev !== undefined && pick === prev + 1) score += 6;
    score -= Math.min(pick - from, 10);
    hits.push(pick);
    from = pick + 1;
  }
  return { score, hits };
}

/** A keyword finds an item only from the start of one of its words, and
 *  below any title that matches as well: "cost" opens Usage, "o" does not. */
function keywordScore(query: string, keywords: readonly string[] | undefined): number {
  const q = query.trim().toLowerCase();
  if (!q || !keywords) return 0;
  let best = 0;
  for (const keyword of keywords) {
    const k = keyword.toLowerCase();
    if (k === q) best = Math.max(best, 600);
    else if (k.startsWith(q)) best = Math.max(best, 500);
    else if (k.split(WORD_BREAK).some(word => word.startsWith(q))) best = Math.max(best, 400);
  }
  return best;
}

/** How many rows a section lists while a query narrows it, so one long
 *  section cannot push every other match out of the window. */
export const SECTION_CAP = 8;
/** How many sessions an empty field lists: the ones waiting first. */
export const EMPTY_SESSIONS = 5;
/** How many recent items an empty field lists, and the list keeps. */
export const RECENT_MAX = 5;

/**
 * The list to draw for a query.
 *
 * Empty: what was opened recently, then the sessions (waiting first, as the
 * caller orders them), the doors, Settings' sections and the actions, each
 * section in its own order; the themes and the single settings wait for a
 * query (queryOnly), since dozens of them would bury the rest. Recent lists
 * them all the same. Typed: every item that matches its title or a keyword,
 * best first inside each section, and the sections in the order of their best match, so
 * the top row is the best answer whatever kind it is.
 */
export function rankQuick(items: readonly QuickItem[], query: string, recent: readonly string[] = []): RankedSection[] {
  const q = query.trim();
  if (!q) {
    const byId = new Map(items.map(item => [item.id, item]));
    const recentItems = recent.map(id => byId.get(id)).filter((item): item is QuickItem => !!item).slice(0, RECENT_MAX);
    const shownRecently = new Set(recentItems.map(item => item.id));
    const sections: RankedSection[] = [];
    if (recentItems.length) sections.push(section("recent", recentItems.map(item => ({ item, hits: [] }))));
    for (const key of SECTION_ORDER) {
      if (key === "recent") continue;
      let rows = items.filter(item => item.section === key && !item.queryOnly && !shownRecently.has(item.id));
      if (key === "sessions") rows = rows.slice(0, EMPTY_SESSIONS);
      if (rows.length) sections.push(section(key, rows.map(item => ({ item, hits: [] }))));
    }
    return sections;
  }
  const scored = new Map<QuickSection, Array<RankedItem & { score: number }>>();
  for (const item of items) {
    const title = fuzzyMatch(q, item.title);
    const keyword = keywordScore(q, item.keywords);
    const score = Math.max(title?.score ?? 0, keyword);
    if (score <= 0) continue;
    const hits = title && title.score >= keyword ? title.hits : [];
    const list = scored.get(item.section) ?? [];
    list.push({ item, hits, score });
    scored.set(item.section, list);
  }
  return [...scored.entries()]
    .map(([key, list]) => {
      list.sort((a, b) => b.score - a.score);
      return { key, list: list.slice(0, SECTION_CAP), best: list[0].score };
    })
    .sort((a, b) => b.best - a.best || SECTION_ORDER.indexOf(a.key) - SECTION_ORDER.indexOf(b.key))
    .map(({ key, list }) => section(key, list.map(({ item, hits }) => ({ item, hits }))));
}

function section(key: QuickSection, items: RankedItem[]): RankedSection {
  return { section: key, title: sectionTitle(key), items };
}

/** The rows in the order the arrows walk them. */
export function flatRows(sections: readonly RankedSection[]): RankedItem[] {
  return sections.flatMap(s => s.items);
}

/** The next row for an arrow, wrapping at both ends as Raycast's does. */
export function stepRow(index: number, count: number, delta: number): number {
  if (count <= 0) return -1;
  if (index < 0) return delta > 0 ? 0 : count - 1;
  return (((index + delta) % count) + count) % count;
}

export const RECENT_KEY = "agent-dag.quickOpenRecent";

/** The ids opened from the field, newest first. */
export function readRecent(): string[] {
  try {
    const parsed = JSON.parse(readStored(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/** The list with `id` moved to its front. */
export function withRecent(recent: readonly string[], id: string): string[] {
  return [id, ...recent.filter(other => other !== id)].slice(0, RECENT_MAX);
}

export function rememberRecent(id: string): void {
  writeStored(RECENT_KEY, JSON.stringify(withRecent(readRecent(), id)));
}

/** The keys that open the field: ⌘K on a Mac and Ctrl+K elsewhere, so a Mac
 *  text field keeps Ctrl+K, which deletes to the end of its line. Read off the
 *  key or, on a layout with no Latin letters, the key's place. */
export interface QuickChordKey {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function isQuickOpenChord(e: QuickChordKey, apple: boolean): boolean {
  const k = e.key === "k" || e.key === "K" || e.code === "KeyK";
  const modifier = apple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return k && modifier && !e.altKey && !e.shiftKey;
}

/** The chord as the keys in front of the reader spell it. */
export function quickOpenChordLabel(apple: boolean): string {
  return apple ? "⌘K" : "Ctrl+K";
}
