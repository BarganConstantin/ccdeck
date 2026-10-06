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

/** A failed read's reasons, as the routes and the page name them, in words. */
const REASON: Record<string, string> = {
  timeout: "git took too long to answer.",
  gone: "The file is no longer there.",
  outside: "The file is outside this repository.",
  error: "git could not read it.",
  "too-large": "The answer was too large.",
  "not-downloaded": "This partial clone has not downloaded it, and the deck never fetches.",
  unsafe: "git would run a filter program from this repository's settings to read it, and the deck never runs one.",
  off: "Git is switched off in Settings.",
  "the deck did not answer": "The deck did not answer.",
};

/** The failures reading again cannot mend: the deck will not fetch, run a
 *  filter, or read past its cap, and a file outside the repository or gone
 *  stays so. Only the others get a Try again. */
const LASTING = new Set(["not-downloaded", "unsafe", "too-large", "outside", "gone", "off"]);
export const failureLasts = (error: string) => LASTING.has(error);

/** A failed read's words: the known reasons in a sentence, anything else as
 *  the route said it. */
export function failureLine(error: string): string {
  if (REASON[error]) return REASON[error];
  if (!error || error.length > 100) return REASON.error;
  return `${error[0].toUpperCase()}${error.slice(1)}.`;
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
  /** The line ended in a carriage return (CRLF), which its text leaves out. */
  cr?: boolean;
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
  /** git printed an unmerged path its own way — a combined diff of both sides
   *  of a merge, or only "Unmerged path" — rather than a patch. */
  unmerged: boolean;
  /** Every added, removed and context line in the patch. */
  lineCount: number;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** A unified diff of one file as hunks of numbered lines, plus what its
 *  header said: rename, copy, new, deleted, mode change, binary. */
export function parsePatch(patch: string): ParsedDiff {
  const out: ParsedDiff = { hunks: [], renamed: false, copied: false, created: false, deleted: false, binary: false, unmerged: false, lineCount: 0 };
  const rows = patch.split("\n");
  let hunk: Hunk | null = null;
  let oldLeft = 0, newLeft = 0, oldNo = 0, newNo = 0;
  for (const raw of rows) {
    const cr = raw.endsWith("\r");
    const row = cr ? raw.slice(0, -1) : raw;
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
      const eol = cr ? { cr: true } : {};
      if (sign === " " || row === "") {
        hunk.lines.push({ kind: "ctx", old: oldNo++, new: newNo++, text: row.slice(1), ...eol });
        oldLeft--; newLeft--;
        continue;
      }
      if (sign === "-") { hunk.lines.push({ kind: "del", old: oldNo++, new: null, text: row.slice(1), ...eol }); oldLeft--; continue; }
      if (sign === "+") { hunk.lines.push({ kind: "add", old: null, new: newNo++, text: row.slice(1), ...eol }); newLeft--; continue; }
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
    else if ((m = /^rename from (.+)$/.exec(row))) { out.renamed = true; out.from = unquotePath(m[1]); }
    else if ((m = /^copy from (.+)$/.exec(row))) { out.copied = true; out.from = unquotePath(m[1]); }
    else if (/^new file mode /.test(row)) out.created = true;
    else if (/^deleted file mode /.test(row)) out.deleted = true;
    else if ((m = /^old mode (\d+)$/.exec(row))) out.oldMode = m[1];
    else if ((m = /^new mode (\d+)$/.exec(row))) out.newMode = m[1];
    else if (/^Binary files .* differ$/.test(row) || row === "GIT binary patch") out.binary = true;
    else if (/^diff --(?:cc|combined) /.test(row) || row.startsWith("* Unmerged path ")) out.unmerged = true;
  }
  out.lineCount = out.hunks.reduce((n, x) => n + x.lines.length, 0);
  return out;
}

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/**
 * A path as git wrote it in a patch header, unquoted: git puts a path that
 * holds a quote, a backslash, a tab, a newline or another control character
 * in double quotes with C escapes (`"we\"ird\303\251.txt"`), whatever
 * core.quotePath says, and octal escapes are the UTF-8 bytes of the name.
 */
export function unquotePath(raw: string): string {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return raw;
  const bytes: number[] = [];
  const enc = new TextEncoder();
  // By code point, so a name's emoji is never split in two.
  const body = Array.from(raw.slice(1, -1));
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") { bytes.push(...enc.encode(ch)); continue; }
    const next = body[i + 1];
    const oct = /^[0-3][0-7]{2}$/.exec(body.slice(i + 1, i + 4).join(""));
    if (oct) { bytes.push(parseInt(oct[0], 8)); i += 3; continue; }
    if (next !== undefined && next in C_ESCAPES) { bytes.push(C_ESCAPES[next]); i++; continue; }
    bytes.push(92);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
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
/** The header a generator leaves in a file's first lines: a comment (`//`,
 *  `#`, `/*`, `*`, `<!--`, `--`, `;`) that opens with `@generated`, "Code
 *  generated … DO NOT EDIT", "auto-generated" or "DO NOT EDIT". Prose that
 *  only mentions generated things is not one. */
const GENERATED_MARK = /^\s*(?:\/\/+|#+|\/\*+|\*+|<!--|--|;+)\s*(?:@generated\b|Code generated\b.*\bDO NOT EDIT\b|(?:This file (?:is|was|has been) )?auto-?generated\b|DO NOT EDIT\b)/i;
/** Files written for people to read: a generator's mark in one is prose. */
const PROSE = /\.(?:md|markdown|mdx|txt|rst|adoc|asciidoc|org)$/i;

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
  if (PROSE.test(path)) return null;
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

/**
 * The changed lines whose only change is their line ending — a removed line
 * and the added line that replaced it, the same text, one ending in a carriage
 * return and one not — paired as hunkWordMarks pairs them. Their text alone
 * reads identical, so the pane marks the ending.
 */
export function endingOnly(lines: readonly DiffLine[]): Set<number> {
  const out = new Set<number>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== "del") { i++; continue; }
    const delStart = i;
    while (i < lines.length && lines[i].kind === "del") i++;
    const addStart = i;
    while (i < lines.length && lines[i].kind === "add") i++;
    const pairs = Math.min(addStart - delStart, i - addStart);
    for (let k = 0; k < pairs; k++) {
      const d = lines[delStart + k], a = lines[addStart + k];
      if (d.text === a.text && !d.cr !== !a.cr) { out.add(delStart + k); out.add(addStart + k); }
    }
  }
  return out;
}

/** "CRLF → LF" (or the other way) when every changed line of a diff changed
 *  only its line ending, else null. */
export function endingsChange(p: ParsedDiff): string | null {
  let changed = 0, toLf = 0, toCrlf = 0;
  for (const h of p.hunks) {
    const only = endingOnly(h.lines);
    for (let i = 0; i < h.lines.length; i++) {
      const l = h.lines[i];
      if (l.kind === "ctx") continue;
      changed++;
      if (!only.has(i)) return null;
      if (l.kind === "del") { if (l.cr) toLf++; else toCrlf++; }
    }
  }
  if (!changed) return null;
  return toLf && !toCrlf ? "CRLF → LF" : toCrlf && !toLf ? "LF → CRLF" : "CRLF and LF";
}
