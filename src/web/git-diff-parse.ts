// One file's unified diff, as the git view's diff pane reads it: the answer
// /api/git/diff and /api/git/commit give for a file, the patch in it parsed into
// hunks of numbered lines, and the few decisions the pane makes before it
// draws anything — what kind of answer it is, which files are collapsed until
// asked for, how much of a long diff is shown first, and which lines are new
// since the version the reader last saw.

/**
 * What the server answers for one file's diff (src/server/git-reads.mjs):
 * a text patch with its counts, a binary file, a diff over the server's size
 * cap with the two sizes, an untracked folder, or a read that failed. Sizes are
 * in bytes, null where there is no such side.
 */
export interface DiffResult {
  ok?: boolean;
  reason?: string;
  binary?: boolean;
  patch?: string;
  added?: number;
  removed?: number;
  tooLarge?: boolean;
  limit?: number;
  oldSize?: number | null;
  newSize?: number | null;
  directory?: boolean;
}

export type DiffState = "error" | "binary" | "too-large" | "directory" | "text";

export function diffState(d: DiffResult): DiffState {
  if (d.ok === false) return "error";
  if (d.directory) return "directory";
  if (d.tooLarge) return "too-large";
  if (d.binary) return "binary";
  return typeof d.patch === "string" ? "text" : "error";
}

export type LineKind = "add" | "del" | "ctx";

export interface DiffLine {
  kind: LineKind;
  /** The line's number in the old file, or null on an added line. */
  old: number | null;
  /** The line's number in the new file, or null on a removed line. */
  new: number | null;
  text: string;
  /** git's "\ No newline at end of file" came after this line. */
  noEol?: boolean;
}

export interface Hunk {
  /** `@@ -22,5 +22,5 @@` */
  range: string;
  /** What git printed after the range: the enclosing function, if it found one. */
  section: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface ParsedDiff {
  hunks: Hunk[];
  /** The path a rename or copy started at. */
  from?: string;
  /** `similarity index` of a rename or copy, 0–100. */
  similarity?: number;
  renamed: boolean;
  copied: boolean;
  created: boolean;
  deleted: boolean;
  /** Set when the file's mode changed: `100644` → `100755`. */
  oldMode?: string;
  newMode?: string;
  binary: boolean;
  /** Every added, removed and context line in the patch. */
  lineCount: number;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** A unified diff of one file as hunks of numbered lines, plus what its
 *  header said: rename, copy, new, deleted, mode change, binary. */
export function parsePatch(patch: string): ParsedDiff {
  const out: ParsedDiff = { hunks: [], renamed: false, copied: false, created: false, deleted: false, binary: false, lineCount: 0 };
  const rows = patch.split("\n");
  let hunk: Hunk | null = null;
  let oldLeft = 0, newLeft = 0, oldNo = 0, newNo = 0;
  for (const raw of rows) {
    const row = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const h = HUNK.exec(row);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[3]);
      oldLeft = h[2] === undefined ? 1 : Number(h[2]);
      newLeft = h[4] === undefined ? 1 : Number(h[4]);
      hunk = { range: row.slice(0, row.indexOf("@@", 2) + 2), section: h[5] ?? "", oldStart: oldNo, newStart: newNo, lines: [] };
      out.hunks.push(hunk);
      continue;
    }
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const sign = row[0];
      // An empty row inside a hunk is an empty context line whose leading
      // space something stripped on the way.
      if (sign === " " || row === "") {
        hunk.lines.push({ kind: "ctx", old: oldNo++, new: newNo++, text: row.slice(1) });
        oldLeft--; newLeft--;
        continue;
      }
      if (sign === "-") { hunk.lines.push({ kind: "del", old: oldNo++, new: null, text: row.slice(1) }); oldLeft--; continue; }
      if (sign === "+") { hunk.lines.push({ kind: "add", old: null, new: newNo++, text: row.slice(1) }); newLeft--; continue; }
    }
    if (row.startsWith("\\")) {
      const last = hunk?.lines[hunk.lines.length - 1];
      if (last) last.noEol = true;
      continue;
    }
    if (hunk && oldLeft <= 0 && newLeft <= 0) hunk = null;
    if (hunk) continue;
    let m: RegExpExecArray | null;
    if ((m = /^similarity index (\d+)%$/.exec(row))) out.similarity = Number(m[1]);
    else if ((m = /^rename from (.+)$/.exec(row))) { out.renamed = true; out.from = m[1]; }
    else if ((m = /^copy from (.+)$/.exec(row))) { out.copied = true; out.from = m[1]; }
    else if (/^new file mode /.test(row)) out.created = true;
    else if (/^deleted file mode /.test(row)) out.deleted = true;
    else if ((m = /^old mode (\d+)$/.exec(row))) out.oldMode = m[1];
    else if ((m = /^new mode (\d+)$/.exec(row))) out.newMode = m[1];
    else if (/^Binary files .* differ$/.test(row) || row === "GIT binary patch") out.binary = true;
  }
  out.lineCount = out.hunks.reduce((n, x) => n + x.lines.length, 0);
  return out;
}

/** How much of a long diff is drawn before the reader asks for more —
 *  GitHub's numbers: 400 lines or 20 KB, whichever comes first. */
export const DIFF_BUDGET = { lines: 400, bytes: 20 * 1024 } as const;

export interface Budgeted {
  hunks: Hunk[];
  /** Lines drawn. */
  shown: number;
  /** Lines in the whole diff. */
  total: number;
}

/**
 * The first `steps` budgets' worth of a diff — `steps` × 400 lines or 20 KB —
 * cut at a line, inside a hunk if it has to be. `Infinity` draws it all.
 */
export function budgetHunks(hunks: Hunk[], steps: number): Budgeted {
  const total = hunks.reduce((n, h) => n + h.lines.length, 0);
  const maxLines = DIFF_BUDGET.lines * steps;
  const maxBytes = DIFF_BUDGET.bytes * steps;
  const out: Hunk[] = [];
  let shown = 0, bytes = 0;
  for (const h of hunks) {
    if (shown >= maxLines || bytes >= maxBytes) break;
    const lines: DiffLine[] = [];
    for (const l of h.lines) {
      if (shown >= maxLines || bytes >= maxBytes) break;
      lines.push(l);
      shown++;
      bytes += l.text.length + 1;
    }
    out.push(lines.length === h.lines.length ? h : { ...h, lines });
  }
  return { hunks: out, shown, total };
}

/** Lock files by name, and the tool that writes each — the collapsed
 *  placeholder says who generated it. */
const LOCKS: Array<[RegExp, string]> = [
  [/^(package-lock|npm-shrinkwrap)\.json$/, "npm"],
  [/^yarn\.lock$/, "Yarn"],
  [/^pnpm-lock\.yaml$/, "pnpm"],
  [/^bun\.lockb?$/, "Bun"],
  [/^deno\.lock$/, "Deno"],
  [/^Cargo\.lock$/, "Cargo"],
  [/^Gemfile\.lock$/, "Bundler"],
  [/^composer\.lock$/, "Composer"],
  [/^poetry\.lock$/, "Poetry"],
  [/^Pipfile\.lock$/, "Pipenv"],
  [/^uv\.lock$/, "uv"],
  [/^go\.sum$/, "Go"],
  [/^flake\.lock$/, "Nix"],
  [/^packages\.lock\.json$/, "NuGet"],
  [/^mix\.lock$/, "Mix"],
  [/^Podfile\.lock$/, "CocoaPods"],
  [/^pubspec\.lock$/, "pub"],
  [/^Package\.resolved$/, "SwiftPM"],
];

/** Paths that are generated by their look alone. */
const GENERATED_PATH = /(^|\/)(__generated__|generated)\/|\.(generated|gen|g|pb|min)\.[a-z0-9]+$|_pb2\.py$|\.pb\.go$|\.map$/i;
/** The marks generators leave in a file's first lines. */
const GENERATED_MARK = /@generated|\bDO NOT EDIT\b|\bauto-?generated\b|\bCode generated by\b/i;

export type Collapsed = "lock" | "generated";

/** The tool that wrote a lock file, or null when `path` is not one. */
export function lockOwner(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  for (const [re, who] of LOCKS) if (re.test(name)) return who;
  return null;
}

/**
 * Whether a file's diff starts collapsed behind "Show diff": a lock file, or a
 * generated one — by its path, or, when the diff is at hand, by the mark a
 * generator leaves in its first lines.
 */
export function collapsedKind(path: string, parsed?: ParsedDiff | null): Collapsed | null {
  if (lockOwner(path)) return "lock";
  if (GENERATED_PATH.test(path)) return "generated";
  const first = parsed?.hunks[0];
  if (first && first.oldStart <= 1 && first.newStart <= 1 && first.lines.slice(0, 5).some(l => GENERATED_MARK.test(l.text))) return "generated";
  return null;
}

/** A count with its thousands grouped by commas — `1,240` — written out by
 *  hand rather than by the host's locale, which would change a column's width
 *  with the machine it runs on. */
export function groupDigits(n: number): string {
  const s = String(Math.trunc(Math.abs(n)));
  return (n < 0 ? "-" : "") + s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * The lines of `next` that were not in `prev` — what glows once when the
 * reader asks for the latest version of a diff they were reading. A line
 * counts as old when an identical line (same kind, same text) is in `prev`,
 * each old line used once. Keys are `hunk:line` indexes into `next`.
 */
export function freshLines(prev: ParsedDiff, next: ParsedDiff): Set<string> {
  const seen = new Map<string, number>();
  for (const h of prev.hunks) for (const l of h.lines) {
    const k = `${l.kind}\0${l.text}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const out = new Set<string>();
  next.hunks.forEach((h, hi) => h.lines.forEach((l, li) => {
    const k = `${l.kind}\0${l.text}`;
    const left = seen.get(k) ?? 0;
    if (left > 0) seen.set(k, left - 1);
    else out.add(`${hi}:${li}`);
  }));
  return out;
}
