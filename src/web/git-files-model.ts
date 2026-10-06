// The git view's file list as rows, before anything is drawn: what git
// reports for the folder (or for one commit), joined with the files the
// focused agent edited through its edit tools.
//
// Every change git reports is listed — nothing is hidden. The agent's own
// files come first under its name; everything else sits below, quieter,
// under "Other changes in this folder". The mark is inferred from edit-tool
// calls (Edit, Write, MultiEdit, NotebookEdit, Codex's apply_patch), so a file
// changed from a shell stays unmarked, and the list says so beside the mark.
import { collapsedKind, groupDigits, type Collapsed } from "./git-diff-parse";
import type { SubagentElsewhere } from "./git-view-types";

export type { SubagentElsewhere } from "./git-view-types";

/** One change in `git status`, as /api/git/status lists it. A file staged
 *  and changed again is two entries. The counts are there only when the
 *  server sends them. */
export interface StatusEntry {
  path: string;
  area: string;
  change: string;
  from?: string;
  submodule?: boolean;
  directory?: boolean;
  added?: number;
  removed?: number;
  binary?: boolean;
}

/** One file of a commit, as /api/git/commit lists it. */
export interface CommitFile {
  path: string;
  from?: string;
  change: string;
  added: number;
  removed: number;
  binary: boolean;
  submodule?: boolean;
}

/** One file an agent edited, as /api/git/edits lists it: `agentId` null for
 *  the session's main thread. */
export interface GitEdit {
  path: string;
  agentId: string | null;
  label: string | null;
  at: number;
}

/** Who the view is about: a whole session (`agentIds` null) or some of its
 *  subagents. */
export interface GraphFocus {
  sessionId: string;
  agentIds: string[] | null;
}

/** A file as the panes pass it around. Commit files carry `area: "commit"`. */
export interface FileRef {
  path: string;
  area: string;
  from?: string;
}

/** A row's key, also its `data-file`: the area never holds a colon. */
export const fileKey = (f: { path: string; area: string }) => `${f.area}:${f.path}`;

/** The letter a change is marked with, and the word a screen reader hears. */
const CHANGES: Record<string, { letter: string; word: string }> = {
  modified: { letter: "M", word: "modified" },
  added: { letter: "A", word: "added" },
  deleted: { letter: "D", word: "deleted" },
  renamed: { letter: "R", word: "renamed" },
  copied: { letter: "C", word: "copied" },
  typechange: { letter: "T", word: "type changed" },
  untracked: { letter: "U", word: "untracked" },
  conflict: { letter: "!", word: "conflict" },
};

export function changeMark(change: string): { letter: string; word: string } {
  return CHANGES[change] ?? CHANGES.modified;
}

export interface FileRow extends FileRef {
  key: string;
  change: string;
  letter: string;
  word: string;
  /** The stage tag a row shows: always for a staged entry, and for an
   *  unstaged one when the same file is listed staged too. */
  stage: "staged" | "unstaged" | null;
  directory: boolean;
  /** Edited by the focused agent (or one of its subagents). */
  marked: boolean;
  /** The subagent that edited a marked row, shown `↳ name`. */
  sub: string | null;
  /** Another agent of the session that edited it, outside the focus. */
  other: string | null;
  /** Every agent that edited it, for the row's tooltip. */
  editors: string[];
  /** A sharp collision on this file: who else edited it. */
  clash: string | null;
  collapsed: Collapsed | null;
  counts: { added: number; removed: number; binary: boolean } | null;
}

export interface UncommittedList {
  mine: FileRow[];
  other: FileRow[];
  /** "Edited by api-fix and its subagents". */
  label: string;
  /** Distinct paths — a file staged and unstaged counts once. */
  files: number;
  /** Some row has counts: every row keeps the counts column then, empty where
   *  nothing is known, so the tags before it line up down the list. */
  counted: boolean;
}

/** What a session's main thread is called when nothing better is known. */
const SESSION = "this session";

function editsOf(entry: { path: string; from?: string; directory?: boolean }, edits: readonly GitEdit[]): GitEdit[] {
  const under = entry.directory ? `${entry.path}/` : null;
  return edits.filter(e => e.path === entry.path || (entry.from !== undefined && e.path === entry.from) || (under !== null && e.path.startsWith(under)));
}

const nameOf = (e: GitEdit, session: string) => e.label ?? (e.agentId === null ? session : "subagent");

/**
 * The uncommitted list for `focus`: its own files first, then the rest of the
 * folder. `name` is what the focused session (or subagent) is called on its
 * card.
 */
export function uncommittedList(
  entries: readonly StatusEntry[],
  edits: readonly GitEdit[],
  focus: GraphFocus,
  collisions: ReadonlyArray<{ path: string; with: string }>,
  name?: string,
): UncommittedList {
  const mainLabel = edits.find(e => e.agentId === null)?.label ?? null;
  // From a subagent, `name` is the subagent's; the session keeps its own.
  const sessionName = focus.agentIds === null ? name ?? mainLabel ?? SESSION : mainLabel ?? SESSION;
  const inFocus = (e: GitEdit) => focus.agentIds === null || (e.agentId !== null && focus.agentIds.includes(e.agentId));
  const twice = new Map<string, number>();
  for (const e of entries) twice.set(e.path, (twice.get(e.path) ?? 0) + 1);
  const mine: FileRow[] = [];
  const other: FileRow[] = [];
  for (const entry of entries) {
    const by = editsOf(entry, edits);
    const own = by.filter(inFocus);
    const outside = by.filter(e => !inFocus(e));
    const marked = own.length > 0;
    const sub = marked && focus.agentIds === null ? own.find(e => e.agentId !== null) : undefined;
    const row: FileRow = {
      ...baseRow(entry, entry.area),
      stage: entry.area === "staged" ? "staged" : entry.area === "unstaged" && (twice.get(entry.path) ?? 0) > 1 ? "unstaged" : null,
      marked,
      sub: sub ? nameOf(sub, sessionName) : null,
      other: !marked && outside.length ? nameOf(outside[0], sessionName) : null,
      editors: [...new Set(by.map(e => nameOf(e, sessionName)))],
      clash: collisions.find(c => c.path === entry.path || (entry.from !== undefined && c.path === entry.from))?.with ?? null,
      counts: typeof entry.added === "number" || entry.binary
        ? { added: entry.added ?? 0, removed: entry.removed ?? 0, binary: entry.binary === true }
        : null,
    };
    (marked ? mine : other).push(row);
  }
  let label: string;
  if (focus.agentIds !== null) {
    const subName = edits.find(e => e.agentId !== null && focus.agentIds!.includes(e.agentId))?.label;
    label = `Edited by ${name ?? subName ?? "this subagent"}`;
  } else {
    label = edits.some(e => e.agentId !== null) ? `Edited by ${sessionName} and its subagents` : `Edited by ${sessionName}`;
  }
  const counted = [...mine, ...other].some(r => r.counts !== null);
  return { mine, other, label, files: new Set(entries.map(e => e.path)).size, counted };
}

/** One file's counts across its entries — a file staged and changed again is
 *  one file changed, its two sides added together — or null when a side's
 *  counts are not known. Binary when either side is. */
export function pathCounts(entries: readonly StatusEntry[], path: string): { added: number; removed: number; binary: boolean } | null {
  const sides = entries.filter(e => e.path === path);
  if (!sides.length) return null;
  let added = 0, removed = 0, binary = false;
  for (const e of sides) {
    if (e.binary) { binary = true; continue; }
    if (typeof e.added !== "number" || typeof e.removed !== "number") return null;
    added += e.added;
    removed += e.removed;
  }
  return binary ? { added: 0, removed: 0, binary: true } : { added, removed, binary: false };
}

/** A subagent of the session working in another folder, as the files pane
 *  names it under the session's own files: "↳ docs-sync works in
 *  shop-api-docs · 1 file ›". */
export interface ElsewhereRow {
  /** Its `data-file`, beside the file rows' keys; no area is "elsewhere". */
  key: string;
  agentId: string;
  name: string;
  folderName: string;
  /** "docs-sync works in shop-api-docs"; the line draws `↳` before it. */
  lead: string;
  /** How much is changed there, or why there is nothing to show; "" when
   *  nothing is known. */
  tail: string;
  /** There is a repository to narrow the view to. */
  opens: boolean;
  /** The whole sentence, with the full folder. */
  title: string;
  /** What a screen reader hears for the line. */
  said: string;
}

/** Why a folder has nothing to open, in the fewest words. */
const ELSEWHERE_STATE: Record<string, { tail: string; why: string }> = {
  "not-a-repo": { tail: "not a repo", why: "which is not a git repository" },
  gone: { tail: "folder gone", why: "which no longer exists" },
  "no-git": { tail: "no git", why: "but git was not found on this machine" },
  bare: { tail: "bare repo", why: "a bare repository with no working tree" },
  unsafe: { tail: "other owner", why: "which belongs to another user, so git will not read it" },
  timeout: { tail: "git timed out", why: "but git took too long to answer" },
  error: { tail: "unreadable", why: "but git could not read it" },
};

/** The lines naming the session's subagents that work in another folder,
 *  each by its card's name (`cardName`, by its key), else the label the
 *  server sent, else as a subagent. */
export function elsewhereRows(subagents: readonly SubagentElsewhere[], cardName: (agentId: string) => string | null): ElsewhereRow[] {
  return subagents.map(s => {
    const name = cardName(s.agentId) ?? s.label ?? "subagent";
    // The words on the line, which the title opens with so a cut line keeps them.
    const lead = `${name} works in ${s.folderName}`;
    if (s.state !== "repo") {
      const words = ELSEWHERE_STATE[s.state] ?? ELSEWHERE_STATE.error;
      return {
        key: `elsewhere:${s.agentId}`, agentId: s.agentId, name, folderName: s.folderName, lead, tail: words.tail, opens: false,
        title: `${lead}: ${s.folder}, ${words.why}.`, said: `${lead}, ${words.why}.`,
      };
    }
    const tail = s.changed == null ? "" : s.changed === 0 ? "no changes" : `${groupDigits(s.changed)} file${s.changed === 1 ? "" : "s"}`;
    const where = s.sameRepo ? "another worktree of this repository" : "another repository";
    return {
      key: `elsewhere:${s.agentId}`, agentId: s.agentId, name, folderName: s.folderName, lead, tail, opens: true,
      title: `${lead}: ${s.folder}, ${where}. Show its changes.`,
      said: `${lead}${tail ? `, ${tail}` : ""}. Enter shows its changes.`,
    };
  });
}

/** A commit's files as rows, in the order git listed them. */
export function commitRows(files: readonly CommitFile[]): FileRow[] {
  return files.map(f => ({
    ...baseRow(f, "commit"),
    stage: null, marked: false, sub: null, other: null, editors: [], clash: null,
    counts: { added: f.added, removed: f.removed, binary: f.binary },
  }));
}

function baseRow(f: { path: string; change: string; from?: string; directory?: boolean }, area: string) {
  const { letter, word } = changeMark(f.change);
  return {
    key: fileKey({ path: f.path, area }),
    path: f.path,
    area,
    ...(f.from !== undefined ? { from: f.from } : {}),
    change: f.change,
    letter,
    word,
    directory: f.directory === true,
    collapsed: f.directory ? null : collapsedKind(f.path),
  };
}

/** The rows in the order the list shows them, for the keys that walk it. */
export function rowOrder(list: UncommittedList | FileRow[]): FileRow[] {
  return Array.isArray(list) ? list : [...list.mine, ...list.other];
}
