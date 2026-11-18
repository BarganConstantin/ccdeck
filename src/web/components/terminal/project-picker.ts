// The New session picker's projects (internal #106): which folders it offers,
// in what order, what a search keeps, how two folders of the same name are
// told apart, and the short list of folders the reader started in or chose,
// kept in this browser so a folder picked once is offered again tomorrow.
//
// WHAT IS REMEMBERED. Only what the reader did here: a folder they started an
// agent in, or chose in the desktop app's folder dialog. Not every folder a
// tool touched — the board already offers the folders its sessions ran in,
// and those come and go with the board. Twelve at most, newest first, one
// entry per folder.
//
// WHAT "REMOVE" MEANS. The folder leaves this list, and a folder the board
// still offers stays out of it too, until the reader chooses it again. Nothing
// on disk is touched and no session is ended: it is a list of shortcuts.
//
// Kept as the deck keeps its other choices (agent-dag.* in the browser's
// store, through storage.ts's one guard); a browser that refuses storage
// simply forgets, and the picker still works.
import { sessionHue } from "../../session-hue";
import { localStore } from "../../storage";
import { elidePath, folderName, isAbsolutePath, type ProjectChoice } from "./stage-model";

export const RECENT_KEY = "agent-dag.newSession.recent";
export const FORGOTTEN_KEY = "agent-dag.newSession.forgotten";
/** How many folders the list keeps. */
export const RECENT_MAX = 12;
/** How many removed board folders stay hidden. */
export const FORGOTTEN_MAX = 50;

export interface RecentProject {
  cwd: string;
  /** When the reader last chose or started in it, ms since the epoch. */
  at: number;
}

export type ProjectStore = Pick<Storage, "getItem" | "setItem">;

/** The browser's storage, or null where there is none or it is refused. */
export function browserStore(): ProjectStore | null {
  return localStore();
}

function readJson(store: ProjectStore | null, key: string): unknown {
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(store: ProjectStore | null, key: string, value: unknown): void {
  if (!store) return;
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    // Full or refused: the list is a convenience, never a reason to fail.
  }
}

/** The folder as one entry: trailing separators off, the root kept. */
export function projectKey(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  if (trimmed === "") return cwd.startsWith("/") ? "/" : cwd;
  return /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}${cwd.slice(2, 3) || "\\"}` : trimmed;
}

/** Windows tools can report either separator. Keep the real path for launch. */
export function projectIdentity(cwd: string): string {
  const key = projectKey(cwd);
  if (!/^[A-Za-z]:[\\/]|^\\\\/.test(key)) return key;
  return key.replace(/\\/g, "/").replace(/^[a-z]:/, drive => drive.toUpperCase());
}

/** The remembered folders, newest first, each once, at most RECENT_MAX. */
export function readRecents(store: ProjectStore | null = browserStore()): RecentProject[] {
  const raw = readJson(store, RECENT_KEY);
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: RecentProject[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const { cwd, at } = r as Record<string, unknown>;
    if (typeof cwd !== "string" || !isAbsolutePath(cwd) || typeof at !== "number" || !Number.isFinite(at)) continue;
    const key = projectKey(cwd);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ cwd: key, at });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, RECENT_MAX);
}

/** The board's folders the reader took off the list. */
export function readForgotten(store: ProjectStore | null = browserStore()): string[] {
  const raw = readJson(store, FORGOTTEN_KEY);
  return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === "string" && isAbsolutePath(c)).slice(0, FORGOTTEN_MAX) : [];
}

/** What the picker keeps: the remembered folders and the removed ones. */
export interface KeptProjects {
  recents: RecentProject[];
  forgotten: string[];
}

export function readKept(store: ProjectStore | null = browserStore()): KeptProjects {
  return { recents: readRecents(store), forgotten: readForgotten(store) };
}

/** Write what the picker keeps. Held in the page as well, so a browser that
 *  refuses storage still has this visit's list. */
export function saveKept(kept: KeptProjects, store: ProjectStore | null = browserStore()): void {
  writeJson(store, RECENT_KEY, kept.recents);
  writeJson(store, FORGOTTEN_KEY, kept.forgotten);
}

/** A folder the reader chose or started in, at the top of the list; one they
 *  had removed is back. */
export function withRecent(kept: KeptProjects, cwd: string, now: number): KeptProjects {
  const key = projectKey(cwd);
  if (!isAbsolutePath(key)) return kept;
  return {
    recents: [{ cwd: key, at: now }, ...kept.recents.filter(r => r.cwd !== key)].slice(0, RECENT_MAX),
    forgotten: kept.forgotten.filter(c => c !== key),
  };
}

/** A folder off the list — the remembered one, and the board's offer of it —
 *  touching nothing on disk. */
export function withoutRecent(kept: KeptProjects, cwd: string): KeptProjects {
  const key = projectKey(cwd);
  return {
    recents: kept.recents.filter(r => r.cwd !== key),
    forgotten: [key, ...kept.forgotten.filter(c => c !== key)].slice(0, FORGOTTEN_MAX),
  };
}

/**
 * Everything the picker offers: the board's folders (the stage's own first,
 * as projectChoices orders them) and the remembered ones, each folder once,
 * the rest newest first, without the ones the reader removed.
 */
export function pickerProjects(board: ProjectChoice[], recents: RecentProject[], forgotten: readonly string[] = [], discovered: ProjectChoice[] = []): ProjectChoice[] {
  const hidden = new Set(forgotten.map(projectIdentity));
  const byKey = new Map<string, ProjectChoice>();
  for (const p of board) {
    const key = projectIdentity(p.cwd);
    if (!hidden.has(key) && !byKey.has(key)) byKey.set(key, { ...p, cwd: projectKey(p.cwd) });
  }
  for (const r of recents) {
    const key = projectIdentity(r.cwd);
    if (hidden.has(key)) continue;
    const had = byKey.get(key);
    if (had) byKey.set(key, { ...had, at: Math.max(had.at ?? 0, r.at) });
    else byKey.set(key, { cwd: r.cwd, name: folderName(r.cwd), hue: sessionHue(r.cwd), at: r.at });
  }
  for (const p of discovered) {
    const key = projectIdentity(p.cwd);
    if (hidden.has(key)) continue;
    const had = byKey.get(key);
    if (!had) byKey.set(key, p);
    else if (p.worktree) byKey.set(key, { ...had, name: p.name, worktree: p.worktree });
  }
  const all = [...byKey.values()];
  if (all.length < 2) return all;
  // The stage's own project stays first, as the board put it; the rest by
  // when they were last used (a stable sort keeps the board's order on ties).
  const leads = board.length > 0 && projectIdentity(board[0].cwd) === projectIdentity(all[0].cwd);
  const rest = (leads ? all.slice(1) : all).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return leads ? [all[0], ...rest] : rest;
}

/** Preserve project order while putting each worktree beside its own checkout. */
export function groupProjects(projects: ProjectChoice[]) {
  const groups = new Map<string, { key: string; main?: ProjectChoice; worktrees: ProjectChoice[] }>();
  for (const project of projects) {
    const key = projectIdentity(project.worktree?.projectCwd ?? project.cwd);
    const group = groups.get(key) ?? { key, worktrees: [] };
    if (project.worktree) group.worktrees.push(project);
    else group.main = project;
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** The search's words, lower case. */
function words(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * The projects a search keeps: every word found in the name or the path, the
 * names that start with what was typed first, then names that hold it, then
 * the rest — each group in the list's own order. An empty search keeps all.
 */
export function matchProjects(projects: ProjectChoice[], query: string): ProjectChoice[] {
  const ws = words(query);
  if (!ws.length) return projects;
  const ranked: Array<{ p: ProjectChoice; rank: number; i: number }> = [];
  projects.forEach((p, i) => {
    const name = p.name.toLowerCase();
    const path = p.cwd.toLowerCase();
    const worktree = p.worktree;
    const context = worktree ? `${worktree.projectName} ${worktree.projectCwd} ${worktree.branch ?? ""}`.toLowerCase() : "";
    if (!ws.every(w => name.includes(w) || path.includes(w) || context.includes(w))) return;
    const rank = name.startsWith(ws[0]) ? 0 : ws.every(w => name.includes(w)) ? 1 : 2;
    ranked.push({ p, rank, i });
  });
  return ranked.sort((a, b) => a.rank - b.rank || a.i - b.i).map(r => r.p);
}

/** A typed full path the list does not already hold, offered as its own
 *  option ("Use /srv/api"); null for a search, or a folder already listed. */
export function typedFolder(projects: ProjectChoice[], query: string): ProjectChoice | null {
  const path = query.trim();
  if (!isAbsolutePath(path)) return null;
  const key = projectKey(path);
  if (projects.some(p => projectIdentity(p.cwd) === projectIdentity(key))) return null;
  return { cwd: key, name: folderName(key), hue: sessionHue(key) };
}

/** Text that is a path but not a full one: "~/code", "./api", "..\\web". The
 *  deck has no shell to expand it, so it is said rather than searched. */
export function looksRelative(query: string): boolean {
  return /^(~|\.{1,2})([\\/]|$)/.test(query.trim());
}

/**
 * The second line of each row: the path, cut from the left to fit — and where
 * two projects share a name, cut no further than the folders that tell them
 * apart ("…/personal/ccdeck" and "…/work/ccdeck").
 */
export function projectPaths(projects: ProjectChoice[], max = 40): Map<string, string> {
  const out = new Map<string, string>();
  const byName = new Map<string, ProjectChoice[]>();
  for (const p of projects) {
    const k = p.name.toLowerCase();
    byName.set(k, [...(byName.get(k) ?? []), p]);
  }
  for (const group of byName.values()) {
    if (group.length < 2) {
      out.set(group[0].cwd, elidePath(group[0].cwd, max));
      continue;
    }
    const parts = group.map(p => p.cwd.split(/[\\/]+/).filter(Boolean));
    let keep = 2;
    const longest = Math.max(...parts.map(s => s.length));
    while (keep < longest && new Set(parts.map(s => s.slice(-keep).join("/"))).size < group.length) keep += 1;
    group.forEach((p, i) => {
      const tail = parts[i].slice(-keep).join("/");
      out.set(p.cwd, keep >= parts[i].length ? p.cwd : tail.length + 2 <= Math.max(max, 24) ? `…/${tail}` : `…/${tail.slice(-(max - 2))}`);
    });
  }
  return out;
}
