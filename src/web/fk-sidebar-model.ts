// What the git view's Fork-look sidebar lists, as rows: the sections
// (Worktrees, Branches, Remotes, Tags, Stashes, Submodules), the folders a
// slash in a name makes (`feature/…`), and the refs themselves — flattened in
// the order they are drawn, so the tree can draw only the rows in sight and
// the keys can walk them. Pure functions of the refs, the open folders and
// the filter; nothing here touches the page.
import { TRUNK_NAMES } from "./git-graph-layout";
import type { GitRefs, RefsList } from "./git-view-types";
import { isBrowserChord, type ChordModifiers } from "./shortcuts";

export type SbSection = "worktrees" | "branches" | "remotes" | "tags" | "stashes" | "submodules";

/** The sections in the order they are drawn. Starred is not one of them. */
export const SECTIONS: ReadonlyArray<{ id: SbSection; title: string }> = [
  { id: "worktrees", title: "Worktrees" },
  { id: "branches", title: "Branches" },
  { id: "remotes", title: "Remotes" },
  { id: "tags", title: "Tags" },
  { id: "stashes", title: "Stashes" },
  { id: "submodules", title: "Submodules" },
];

export type SbKind = "section" | "folder" | "remote" | "branch" | "remote-branch" | "tag" | "stash" | "worktree" | "submodule" | "note";

export interface SbRow {
  /** Stable across reads: what the open state and the cursor are kept by. */
  key: string;
  kind: SbKind;
  section: SbSection;
  /** Folders above it inside its section: 6px of indent each. */
  depth: number;
  /** The tree's aria-level: 1 for a section. */
  level: number;
  label: string;
  /** The whole name and what the row's marks say, for the tooltip. */
  title: string;
  /** The commit a click selects in the history; null for a folder, a note,
   *  and a ref whose commit the history never lists: a stash, a submodule's
   *  (its own repository's), a tag of a tree or a blob. */
  sha: string | null;
  /** What "Copy SHA" copies: the ref's object, a history commit or not. */
  copySha?: string;
  parent: string | null;
  /** A section, folder or remote: whether it is open, and whether it holds anything. */
  open?: boolean;
  hasChildren?: boolean;
  /** The branch checked out in the session's worktree, or that worktree. */
  current?: boolean;
  ahead?: number;
  behind?: number;
  /** A branch whose upstream the remote no longer has. */
  gone?: boolean;
  /** A branch another worktree has checked out: that worktree's folder. */
  heldBy?: string | null;
  /** A worktree's branch (or short SHA when detached), drawn at the right. */
  detail?: string | null;
  missing?: boolean;
  locked?: boolean;
  /** What "Copy name" copies: the whole ref name, a path. */
  copy?: string;
  setSize: number;
  posInSet: number;
}

/** Which sections and folders the reader opened or shut, by row key. A key
 *  not in it is at its default. */
export type OpenState = Readonly<Record<string, boolean>>;

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);

/** A stash's words as the sidebar shows them: git's `On <branch>: ` dropped,
 *  `WIP on …` kept whole. */
export const stashLabel = (subject: string) => subject.replace(/^On [^:]+: /, "") || subject;

/** `60↓`, `3↑`, `13↓1↑` — behind first — in words for a tooltip. */
export function aheadBehindWords(ahead: number, behind: number): string {
  const parts: string[] = [];
  if (behind > 0) parts.push(`${behind} behind`);
  if (ahead > 0) parts.push(`${ahead} ahead`);
  return parts.join(", ");
}

interface Leaf {
  kind: SbKind;
  /** The name a slash splits into folders, or the label when it is not split. */
  name: string;
  /** What the filter matches, lower-cased. */
  match: string;
  /** `sha` selects that commit in the history; `copySha`, when the row's
   *  object is not one of the history's commits, is copied only. */
  row: Partial<SbRow> & { sha: string | null };
}

interface Node { folders: Map<string, Node>; leaves: Leaf[] }
const node = (): Node => ({ folders: new Map(), leaves: [] });

function treeOf(leaves: Leaf[], split: boolean): Node {
  const root = node();
  for (const leaf of leaves) {
    const parts = split ? leaf.name.split("/").filter(Boolean) : [leaf.name];
    let at = root;
    for (const seg of parts.slice(0, -1)) {
      if (!at.folders.has(seg)) at.folders.set(seg, node());
      at = at.folders.get(seg)!;
    }
    at.leaves.push(leaf);
  }
  return root;
}

/** Whether a folder holds the leaf `want` (by full name) anywhere below it. */
function holds(n: Node, want: (l: Leaf) => boolean): boolean {
  return n.leaves.some(want) || [...n.folders.values()].some(f => holds(f, want));
}

export interface SidebarInput {
  refs: GitRefs | null;
  /** The session's worktree, to tell a branch another worktree holds. */
  topLevel: string | null;
  /** The branch the remote calls its default, listed first with the trunks. */
  defaultBranch?: string | null;
  open: OpenState;
  query: string;
}

/** The sections a repository shows: Worktrees only with a linked worktree,
 *  Submodules only when there is one. */
export function visibleSections(refs: GitRefs | null): SbSection[] {
  return SECTIONS.map(s => s.id).filter(id => {
    if (id === "worktrees") return (refs?.worktrees.length ?? 0) > 1;
    if (id === "submodules") return (refs?.submodules.length ?? 0) > 0;
    return true;
  });
}

const unreadOf = (section: SbSection): RefsList | null =>
  section === "stashes" || section === "worktrees" || section === "submodules" ? section : null;

/**
 * The rows the sidebar draws, top to bottom. With a filter, only the refs
 * whose name holds it (any case) are listed, every folder and section on the
 * way to one is open, and a section with none is left out; with no match at
 * all, one note says so.
 */
export function sidebarRows({ refs, topLevel, defaultBranch = null, open, query }: SidebarInput): SbRow[] {
  const q = query.trim().toLowerCase();
  const filtering = q !== "";
  const rows: SbRow[] = [];
  if (!refs) return rows;
  const trunks = defaultBranch && !TRUNK_NAMES.includes(defaultBranch) ? [defaultBranch, ...TRUNK_NAMES] : TRUNK_NAMES;
  const currentBranch = refs.branches.find(b => b.current)?.name ?? null;

  const leavesFor = (section: SbSection): { leaves: Leaf[]; split: boolean; remotes?: Array<{ name: string; leaves: Leaf[] }> } => {
    switch (section) {
      case "worktrees":
        return {
          split: false,
          leaves: [...refs.worktrees].sort((a, b) => natural(a.name, b.name)).map(w => ({
            kind: "worktree", name: w.name, match: `${w.name} ${w.branch ?? ""} ${w.path}`.toLowerCase(),
            row: {
              key: `worktrees:${w.path}`,
              sha: w.sha, current: w.current, missing: w.missing, locked: w.locked, copy: w.path,
              detail: w.branch ?? (w.sha ? w.sha.slice(0, 7) : null),
              title: [w.path, w.branch ? `on ${w.branch}` : w.sha ? `detached at ${w.sha.slice(0, 7)}` : "",
                w.current ? "this session's worktree" : "", w.locked ? "locked" : "", w.missing ? "its folder is gone" : ""].filter(Boolean).join(" · "),
            },
          })),
        };
      case "branches":
        return {
          split: true,
          leaves: refs.branches.map(b => {
            const heldBy = b.worktree && !b.current && b.worktree !== topLevel ? b.worktree : null;
            const counts = aheadBehindWords(b.ahead, b.behind);
            return {
              kind: "branch", name: b.name, match: b.name.toLowerCase(),
              row: {
                sha: b.sha, current: b.current, ahead: b.ahead, behind: b.behind, gone: b.gone, heldBy, copy: b.name,
                title: [b.name, b.current ? "checked out" : "",
                  b.gone ? `its upstream ${b.upstream} is gone` : b.upstream ? `tracks ${b.upstream}${counts ? `, ${counts}` : ""}` : "no upstream",
                  heldBy ? `checked out in ${heldBy}` : "", b.sha ? "" : "no commits yet"].filter(Boolean).join(" · "),
              },
            };
          }),
        };
      case "remotes":
        return {
          split: true,
          leaves: [],
          remotes: refs.remotes.map(r => ({
            name: r.name,
            leaves: r.branches.map(b => ({
              kind: "remote-branch" as const, name: b.name, match: `${r.name}/${b.name}`.toLowerCase(),
              row: { sha: b.sha, copy: `${r.name}/${b.name}`, title: `${r.name}/${b.name}` },
            })),
          })),
        };
      case "tags":
        return {
          split: true,
          leaves: refs.tags.map(t => ({
            kind: "tag", name: t.name, match: t.name.toLowerCase(),
            row: t.target
              ? { sha: null, copySha: t.sha, copy: t.name, title: `${t.name}${t.annotated ? " · annotated" : ""} · names a ${t.target}, not a commit` }
              : { sha: t.sha, copy: t.name, title: `${t.name}${t.annotated ? " · annotated" : ""}` },
          })),
        };
      case "stashes":
        return {
          split: false,
          leaves: refs.stashes.map(s => ({
            kind: "stash", name: stashLabel(s.subject), match: s.subject.toLowerCase(),
            row: { sha: null, copySha: s.sha, copy: `stash@{${s.index}}`, title: `stash@{${s.index}}: ${s.subject} · a stash is not in the history`, key: `stashes:${s.sha}` },
          })),
        };
      case "submodules":
        return {
          split: false,
          leaves: [...refs.submodules].sort((a, b) => natural(a.path, b.path)).map(m => ({
            kind: "submodule", name: m.path, match: `${m.path} ${m.name}`.toLowerCase(),
            row: { key: `submodules:${m.path}`, sha: null, copySha: m.sha, copy: m.path, title: `${m.path} · at ${m.sha.slice(0, 7)}, a commit of its own repository` },
          })),
        };
    }
  };

  const keep = (l: Leaf) => !filtering || l.match.includes(q);

  /** The children of a node as rows, folders first, then leaves; at a
   *  section's root, the trunk branches come before both. */
  const emit = (section: SbSection, n: Node, depth: number, level: number, parent: string, path: string, trunkFirst: boolean, out: SbRow[]) => {
    const folders = [...n.folders].filter(([, f]) => holds(f, keep)).sort((a, b) => natural(a[0], b[0]));
    const leaves = n.leaves.filter(keep).sort((a, b) => natural(a.name, b.name));
    const trunk = trunkFirst ? leaves.filter(l => trunks.includes(l.name)).sort((a, b) => trunks.indexOf(a.name) - trunks.indexOf(b.name)) : [];
    const rest = leaves.filter(l => !trunk.includes(l));
    const size = trunk.length + folders.length + rest.length;
    let pos = 0;
    const leafRow = (l: Leaf) => {
      const label = l.kind === "stash" || l.kind === "worktree" || l.kind === "submodule" ? l.name : l.name.split("/").filter(Boolean).pop() ?? l.name;
      out.push({
        ...l.row,
        copySha: l.row.copySha ?? l.row.sha ?? undefined,
        key: l.row.key ?? `${section}:${path}${label}`,
        kind: l.kind, section, depth, level, label, title: l.row.title ?? label, parent,
        setSize: size, posInSet: ++pos,
      });
    };
    for (const l of trunk) leafRow(l);
    for (const [seg, f] of folders) {
      const key = `${section}:${path}${seg}/`;
      const isOpen = filtering || (open[key] ?? (section === "branches" && currentBranch != null && holds(f, l => l.name === currentBranch)));
      out.push({ key, kind: "folder", section, depth, level, label: seg, title: `${path}${seg}`, sha: null, parent, open: isOpen, hasChildren: true, setSize: size, posInSet: ++pos });
      if (isOpen) emit(section, f, depth + 1, level + 1, key, `${path}${seg}/`, false, out);
    }
    for (const l of rest) leafRow(l);
  };

  for (const section of visibleSections(refs)) {
    const title = SECTIONS.find(s => s.id === section)!.title;
    const { leaves, split, remotes } = leavesFor(section);
    const body: SbRow[] = [];
    const key = `section:${section}`;
    if (remotes) {
      const shown = remotes.filter(r => !filtering || r.leaves.some(keep));
      shown.forEach((r, i) => {
        const rkey = `remotes:${r.name}/`;
        const isOpen = filtering || (open[rkey] ?? false);
        body.push({ key: rkey, kind: "remote", section, depth: 0, level: 2, label: r.name, title: r.name, sha: null, parent: key, open: isOpen, hasChildren: r.leaves.length > 0, copy: r.name, setSize: shown.length, posInSet: i + 1 });
        if (isOpen) emit(section, treeOf(r.leaves, true), 1, 3, rkey, `${r.name}/`, true, body);
      });
    } else {
      emit(section, treeOf(leaves, split), 0, 2, key, "", section === "branches", body);
    }
    const count = remotes ? remotes.length : leaves.length;
    if (filtering && body.length === 0) continue;
    const isOpen = filtering || (open[key] ?? section === "branches");
    rows.push({ key, kind: "section", section, depth: 0, level: 1, label: title, title, sha: null, parent: null, open: isOpen, hasChildren: count > 0, setSize: 0, posInSet: 0 });
    if (!isOpen) continue;
    if (body.length) rows.push(...body);
    else {
      const unread = unreadOf(section);
      const why = unread && refs.unread.includes(unread) ? "Could not be read" : "None";
      rows.push({ key: `${key}:none`, kind: "note", section, depth: 0, level: 2, label: why, title: why, sha: null, parent: key, setSize: 1, posInSet: 1 });
    }
    // A list cut at its cap says so where it ends.
    const cut = section === "tags" ? refs.clipped.includes("refs") : (unreadOf(section) && refs.clipped.includes(unreadOf(section)!));
    if (cut && !filtering) {
      const words = section === "tags" ? "Only the first 2,000 branches and tags are listed" : `Only the first ${section === "submodules" ? 500 : 200} are listed`;
      rows.push({ key: `${key}:clipped`, kind: "note", section, depth: 0, level: 2, label: words, title: words, sha: null, parent: key, setSize: 1, posInSet: 1 });
    }
  }
  const sections = rows.filter(r => r.kind === "section");
  sections.forEach((r, i) => { r.setSize = sections.length; r.posInSet = i + 1; });
  if (filtering && rows.length === 0) {
    rows.push({ key: "filter:none", kind: "note", section: "branches", depth: 0, level: 1, label: "No refs match", title: `Nothing here holds “${query.trim()}”`, sha: null, parent: null, setSize: 1, posInSet: 1 });
  }
  return rows;
}

/** Whether a row opens and shuts. An empty section does too: open, it says "None". */
export const expandable = (r: SbRow) => r.kind === "section" || r.kind === "folder" || r.kind === "remote";

export interface SidebarKey extends ChordModifiers {
  key: string;
  shiftKey?: boolean;
}

export type SidebarMove =
  /** Not the tree's: let it travel (Tab, Escape, the browser's chords). */
  | { kind: "pass" }
  /** The tree's, with nothing to do (→ on a leaf): stopped here. */
  | { kind: "stay" }
  | { kind: "cursor"; index: number }
  | { kind: "toggle"; index: number; open: boolean }
  /** Select the row's commit in the history. */
  | { kind: "jump"; index: number }
  /** The row's menu: Copy name, Copy SHA. */
  | { kind: "menu"; index: number }
  /** A letter typed on the tree goes to the filter. */
  | { kind: "type"; text: string };

/**
 * What a key does on the tree, with the cursor on `rows[at]`. ↑ ↓ Home End
 * and the page keys move; → opens a shut folder, then steps into it; ← shuts
 * an open one, then steps out to its parent; Enter and Space open a folder or
 * select a ref's commit; the menu key (or Shift+F10) opens the row's menu; a
 * printable character goes to the filter. Nothing here animates.
 *
 * While `filtering`, every folder is held open, so none opens or shuts: ←
 * steps out to the parent at once and Enter on a folder stays.
 */
export function sidebarKey(e: SidebarKey, rows: readonly SbRow[], at: number, page: number, filtering = false): SidebarMove {
  if (isBrowserChord(e)) return { kind: "pass" };
  const count = rows.length;
  if (count === 0) return e.key.length === 1 && e.key !== " " ? { kind: "type", text: e.key } : { kind: "pass" };
  const last = count - 1;
  const here = at >= 0 && at < count ? at : -1;
  const row = here >= 0 ? rows[here] : null;
  const step = Math.max(1, page);
  switch (e.key) {
    case "ArrowDown": return { kind: "cursor", index: here < 0 ? 0 : Math.min(last, here + 1) };
    case "ArrowUp": return { kind: "cursor", index: here < 0 ? 0 : Math.max(0, here - 1) };
    case "Home": return { kind: "cursor", index: 0 };
    case "End": return { kind: "cursor", index: last };
    case "PageDown": return { kind: "cursor", index: here < 0 ? 0 : Math.min(last, here + step) };
    case "PageUp": return { kind: "cursor", index: here < 0 ? 0 : Math.max(0, here - step) };
    case "ArrowRight": {
      if (!row) return { kind: "cursor", index: 0 };
      if (expandable(row) && !row.open) return { kind: "toggle", index: here, open: true };
      if (expandable(row) && row.open && here < last && rows[here + 1].parent === row.key) return { kind: "cursor", index: here + 1 };
      return { kind: "stay" };
    }
    case "ArrowLeft": {
      if (!row) return { kind: "cursor", index: 0 };
      if (expandable(row) && row.open && !filtering) return { kind: "toggle", index: here, open: false };
      const up = row.parent ? rows.findIndex(r => r.key === row.parent) : -1;
      return up >= 0 ? { kind: "cursor", index: up } : { kind: "stay" };
    }
    case "Enter":
    case " ": {
      if (!row) return { kind: "stay" };
      if (expandable(row)) return filtering ? { kind: "stay" } : { kind: "toggle", index: here, open: !row.open };
      return row.sha ? { kind: "jump", index: here } : { kind: "stay" };
    }
    case "ContextMenu": return row?.copy ? { kind: "menu", index: here } : { kind: "stay" };
    case "F10": return e.shiftKey && row?.copy ? { kind: "menu", index: here } : { kind: "pass" };
    default:
      return e.key.length === 1 && e.key !== " " ? { kind: "type", text: e.key } : { kind: "pass" };
  }
}

/** The open state with one section or folder opened or shut. */
export function withOpen(open: OpenState, key: string, value: boolean): OpenState {
  return open[key] === value ? open : { ...open, [key]: value };
}
