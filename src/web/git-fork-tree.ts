// A flat file list as the folder tree the git view's Fork look draws: every
// folder level its own row (Fork never folds a single-child chain into one),
// folders before files, each by name, and the rows a filter or a closed
// folder leaves on screen, in order — what the virtualised tree draws and
// what its keys walk.

/** A file the tree lists: a commit's file or a working-tree change, with the
 *  marks the files model worked out for it. */
export interface FkTreeFile {
  /** The row's key and `data-file`: `area:path`. */
  key: string;
  path: string;
  area: string;
  from?: string;
  change: string;
  /** git's untracked folder, listed as one entry. */
  directory?: boolean;
  /** Edited by the focused agent (or one of its subagents). */
  marked?: boolean;
  /** The subagent that edited a marked row. */
  sub?: string | null;
  /** Another agent of the session that edited it, outside the focus. */
  other?: string | null;
  /** A sharp collision on this file: who else edited it. */
  clash?: string | null;
  /** Every agent that edited it, for the tooltip. */
  editors?: string[];
  /** Drawn quieter: the focused agent edited other files here, not this one,
   *  so its own stand out as they do in the deck look. */
  quiet?: boolean;
}

export interface FkTreeRow {
  /** `d:<folder path>` for a folder, the file's key for a file. */
  key: string;
  kind: "dir" | "file";
  name: string;
  depth: number;
  /** A folder's path from the top, without a trailing slash. */
  dir?: string;
  file?: FkTreeFile;
  /** A folder is open (always, while a filter is on). */
  open?: boolean;
  /** Where the row sits among its siblings, for a screen reader. */
  posinset: number;
  setsize: number;
}

interface Node {
  dirs: Map<string, Node>;
  files: FkTreeFile[];
  path: string;
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }) || (a < b ? -1 : a > b ? 1 : 0);
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirKey = (path: string) => `d:${path}`;

function build(files: readonly FkTreeFile[]): Node {
  const root: Node = { dirs: new Map(), files: [], path: "" };
  for (const f of files) {
    const parts = f.path.replace(/\/+$/, "").split("/");
    let at = root;
    for (const seg of parts.slice(0, -1)) {
      let next = at.dirs.get(seg);
      if (!next) { next = { dirs: new Map(), files: [], path: at.path ? `${at.path}/${seg}` : seg }; at.dirs.set(seg, next); }
      at = next;
    }
    at.files.push(f);
  }
  return root;
}

/** Whether `f` matches a filter: a case-insensitive substring of its path
 *  (or the path it was renamed from). */
export function matchesFilter(f: FkTreeFile, filter: string): boolean {
  const q = filter.trim().toLowerCase();
  if (!q) return true;
  return f.path.toLowerCase().includes(q) || (f.from?.toLowerCase().includes(q) ?? false);
}

/**
 * The rows on screen: `closed` holds the folders shut (their paths), ignored
 * while `filter` holds anything, when every folder with a match is open and
 * every folder without one is left out.
 */
export function treeRows(files: readonly FkTreeFile[], closed: ReadonlySet<string>, filter = ""): FkTreeRow[] {
  const filtering = filter.trim() !== "";
  const shown = filtering ? files.filter(f => matchesFilter(f, filter)) : files;
  const out: FkTreeRow[] = [];
  const walk = (node: Node, depth: number) => {
    const dirs = [...node.dirs.entries()].sort(([a], [b]) => byName(a, b));
    const leaves = [...node.files].sort((a, b) => byName(baseName(a.path), baseName(b.path)));
    const setsize = dirs.length + leaves.length;
    let pos = 0;
    for (const [name, child] of dirs) {
      const open = filtering || !closed.has(child.path);
      out.push({ key: dirKey(child.path), kind: "dir", name, depth, dir: child.path, open, posinset: ++pos, setsize });
      if (open) walk(child, depth + 1);
    }
    for (const f of leaves) {
      out.push({ key: f.key, kind: "file", name: baseName(f.path.replace(/\/+$/, "")), depth, file: f, posinset: ++pos, setsize });
    }
  };
  walk(build(shown), 0);
  return out;
}

/** Every file in the order the tree lists it, every folder open: what ▲ and
 *  ▼ step through. */
export function fileOrder(files: readonly FkTreeFile[], filter = ""): FkTreeFile[] {
  return treeRows(files, new Set(), filter).flatMap(r => (r.file ? [r.file] : []));
}

/** The folders a path sits in, outermost first: what opens to reveal it. */
export function foldersOf(path: string): string[] {
  const parts = path.replace(/\/+$/, "").split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}
