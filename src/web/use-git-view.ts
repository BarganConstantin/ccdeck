// The git view's data: what a session's repository says — its HEAD and
// upstream, its working tree, its history, the files its agents edited — and,
// for the open view, which row and file are selected and the selected file's
// diff.
//
// One read per session (and subagent, when the view is narrowed to one), kept
// in a small cache the detail panel's glance and the wide view share, so the
// view opens on what the glance already read. A read is asked for when the
// first reader arrives, and again only when the server says the repository
// moved: the GitObserved stale counter an agent's tool calls bump. Nothing
// here polls. A diff is read for the selected file a frame after the view
// first paints, and a diff the reader is looking at never changes under them:
// when the folder moves, the newer diff waits behind "Show latest" (D15).
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type {
  CommitFile, DiffResult, Edit, GitFileRef, GitReadState, GraphFocus, LogCommit, Repo, StatusCounts, StatusEntry,
} from "./git-view-types";
import { UNCOMMITTED } from "./git-view-types";

/** What the shared read of one session's repository holds. */
export interface GitData {
  /** "loading" before the first answer; otherwise the repository's state. */
  state: GitReadState | "loading" | "off";
  repo: Repo | null;
  entries: StatusEntry[] | null;
  counts: StatusCounts | null;
  commits: LogCommit[] | null;
  edits: Edit[] | null;
  /** Why a read inside a repository failed, when one did. */
  reason: string | null;
  /** Commits that appeared at the top of the history since the read before. */
  newShas: string[];
  /** Bumped by each answer about the working tree, so a reader can tell the
   *  folder moved. */
  treeSeq: number;
  /** When the last read was asked for. */
  at: number;
}

export const EMPTY_GIT_DATA: GitData = {
  state: "loading", repo: null, entries: null, counts: null, commits: null, edits: null, reason: null,
  newShas: [], treeSeq: 0, at: 0,
};

/** A read's answer, as the routes send it. */
interface Answer {
  ok?: boolean;
  state?: GitReadState;
  repo?: Repo | null;
  reason?: string;
  error?: string;
  entries?: StatusEntry[];
  counts?: StatusCounts;
  commits?: LogCommit[];
  edits?: Edit[];
}

/** The query a read names its session by: never a folder (git-routes.mjs). */
export function gitQuery(sessionId: string, agent: string | null, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({ session: sessionId, ...(agent ? { agent } : {}), ...extra });
  return q.toString();
}

/** The commits new at the top of `next` that `prev` did not hold. */
export function newAtTop(prev: LogCommit[] | null, next: LogCommit[]): string[] {
  if (!prev || prev.length === 0) return [];
  const known = new Set(prev.map(c => c.sha));
  const out: string[] = [];
  for (const c of next) {
    if (known.has(c.sha)) break;
    if (!c.outsideWindow) out.push(c.sha);
  }
  return out;
}

/** Fold one route's answer into the data. A route answering "not a repo",
 *  "gone" and the like answers for the whole read. */
export function foldAnswer(data: GitData, kind: "status" | "log" | "edits", a: Answer, status: number): GitData {
  if (status === 409) return { ...data, state: "off" };
  if (status >= 400 || a.error) return { ...data, state: data.state === "loading" ? "error" : data.state, reason: a.error ?? `HTTP ${status}` };
  if (a.state && a.state !== "repo") return { ...data, state: a.state, repo: null };
  const next: GitData = { ...data, state: "repo", repo: a.repo ?? data.repo };
  if (a.ok === false) return { ...next, reason: a.reason ?? "error" };
  if (kind === "status") return { ...next, entries: a.entries ?? [], counts: a.counts ?? null, treeSeq: data.treeSeq + 1, reason: null };
  if (kind === "edits") return { ...next, edits: a.edits ?? [] };
  const commits = a.commits ?? [];
  return { ...next, commits, newShas: newAtTop(data.commits, commits) };
}

// ── the shared cache ─────────────────────────────────────────────────────

interface Entry {
  data: GitData;
  readers: number;
  /** The stale counter the last read answered for. */
  seen: number;
  generation: number;
  listeners: Set<() => void>;
}

const cache = new Map<string, Entry>();
/** How many repositories' reads are kept once nobody is looking at them. */
const KEEP_UNREAD = 8;

const keyOf = (sessionId: string, agent: string | null) => `${sessionId}|${agent ?? ""}`;

function entryFor(key: string): Entry {
  let e = cache.get(key);
  if (!e) {
    e = { data: EMPTY_GIT_DATA, readers: 0, seen: -1, generation: 0, listeners: new Set() };
    cache.set(key, e);
  }
  return e;
}

function publish(e: Entry, data: GitData) {
  e.data = data;
  for (const l of e.listeners) l();
}

function trim() {
  const idle = [...cache].filter(([, e]) => e.readers === 0);
  for (const [k] of idle.slice(0, Math.max(0, idle.length - KEEP_UNREAD))) cache.delete(k);
}

/** Ask the three reads of one repository; each answer lands as it arrives,
 *  the working tree first, and an older read's late answers are dropped. */
function read(key: string, sessionId: string, agent: string | null, stale: number, editsAgent: string | null): void {
  const e = entryFor(key);
  const generation = ++e.generation;
  e.seen = stale;
  e.data = { ...e.data, at: Date.now() };
  for (const kind of ["status", "edits", "log"] as const) {
    fetch(`/api/git/${kind}?${gitQuery(sessionId, kind === "edits" ? editsAgent : agent)}`)
      .then(async r => ({ status: r.status, body: (await r.json().catch(() => ({}))) as Answer }))
      .catch(() => ({ status: 0, body: { error: "the deck did not answer" } as Answer }))
      .then(({ status, body }) => {
        if (e.generation !== generation) return;
        publish(e, foldAnswer(e.data, kind, body, status));
      });
  }
}

/**
 * The repository a session (or one of its subagents) works in, read once and
 * shared. `stale` is the agent's GitObserved counter: a higher one than the
 * last read answered for reads again. `fresh` asks a read older than ten
 * seconds to be repeated, for a view the reader has just opened.
 */
export function useGitData({ sessionId, agent, stale, enabled, fresh = false, ownFolder = false }: {
  sessionId: string | null;
  agent: string | null;
  stale: number;
  enabled: boolean;
  fresh?: boolean;
  /** The subagent works in a folder of its own: its edits are read there.
   *  Otherwise the session's whole team's edits are read, and the focus
   *  narrows them where they are drawn, so another agent's edit can be named. */
  ownFolder?: boolean;
}): GitData {
  const key = sessionId && enabled ? keyOf(sessionId, agent) : null;
  const subscribe = useCallback((l: () => void) => {
    if (!key) return () => {};
    const e = entryFor(key);
    e.listeners.add(l);
    e.readers++;
    return () => { e.listeners.delete(l); e.readers--; trim(); };
  }, [key]);
  const snapshot = useCallback(() => (key ? entryFor(key).data : EMPTY_GIT_DATA), [key]);
  const data = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (!key || !sessionId) return;
    const e = entryFor(key);
    const old = Date.now() - e.data.at > 10_000;
    if (e.seen < stale || e.data.at === 0 || (fresh && old)) read(key, sessionId, agent, stale, ownFolder ? agent : null);
  }, [key, stale, fresh]);
  return data;
}

// ── what the data says about whose work it is ────────────────────────────

/** Whether a commit was made by the focus: the session's team, or the one
 *  subagent the view is narrowed to. Trailer-only commits name no session. */
export function madeByFocus(c: LogCommit, focus: GraphFocus): boolean {
  const a = c.agent;
  if (!a || !("sessionId" in a) || a.sessionId !== focus.sessionId) return false;
  return focus.agentIds == null || (a.agentId != null && focus.agentIds.includes(a.agentId));
}

/** Whether an edit row belongs to the focus. */
export function editByFocus(e: Edit, focus: GraphFocus): boolean {
  return focus.agentIds == null || (e.agentId != null && focus.agentIds.includes(e.agentId));
}

/** The working tree's files, each path once (a file staged and unstaged is
 *  one file changed), with whether the focus edited it — the old name of a
 *  rename counts. Edited files first, in the order git lists them. */
export function changedFiles(entries: StatusEntry[] | null, edits: Edit[] | null, focus: GraphFocus):
  { path: string; mine: boolean; entry: StatusEntry }[] {
  if (!entries) return [];
  const touched = new Set((edits ?? []).filter(e => editByFocus(e, focus)).map(e => e.path));
  const seen = new Map<string, { path: string; mine: boolean; entry: StatusEntry }>();
  for (const entry of entries) {
    if (seen.has(entry.path)) continue;
    seen.set(entry.path, { path: entry.path, mine: touched.has(entry.path) || (entry.from != null && touched.has(entry.from)), entry });
  }
  const all = [...seen.values()];
  return [...all.filter(f => f.mine), ...all.filter(f => !f.mine)];
}

/** The file the view opens on: the first one the focus edited, else the first
 *  change git reports. */
export function firstFile(entries: StatusEntry[] | null, edits: Edit[] | null, focus: GraphFocus): GitFileRef | null {
  const f = changedFiles(entries, edits, focus)[0];
  return f ? { path: f.entry.path, area: f.entry.area, ...(f.entry.from ? { from: f.entry.from } : {}) } : null;
}

// ── the open view's selection and diff ───────────────────────────────────

export interface DiffState {
  file: GitFileRef | null;
  /** The diff on screen. */
  diff: DiffResult | null;
  loading: boolean;
  /** A newer diff of the same file is waiting behind "Show latest". */
  stale: boolean;
  /** Why the diff could not be read. */
  error: string | null;
}

type DiffAnswer = { ok?: boolean; diff?: DiffResult & { ok?: boolean }; reason?: string; error?: string; files?: CommitFile[] };

const sameDiff = (a: DiffResult | null, b: DiffResult | null) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Which history row and file are selected in the open view, the selected
 * commit's files, and the selected file's diff.
 *
 * Opens on the row and file a glance row named, else the working tree and the
 * first file the focus edited. Choosing a commit selects its first file.
 * The diff is read a frame after it is asked for, so the panel's first frame
 * never waits on it; when the working tree moves, the open file's diff is
 * read again and, if it changed, kept aside until the reader asks for it.
 */
export function useGitSelection({ data, sessionId, agent, focus, initial, seq, active }: {
  data: GitData;
  sessionId: string;
  agent: string | null;
  focus: GraphFocus;
  /** What a request named: a row and a file, or nothing. */
  initial: { sel?: string | null; file?: GitFileRef | null };
  /** The request it came with; a new one starts the selection over. */
  seq: number;
  /** The view is open (reads wait otherwise). */
  active: boolean;
}) {
  const [sel, setSelRaw] = useState<string>(initial.sel ?? UNCOMMITTED);
  const [file, setFile] = useState<GitFileRef | null>(initial.file ?? null);
  const picked = useRef(false);
  useEffect(() => {
    setSelRaw(initial.sel ?? UNCOMMITTED);
    setFile(initial.file ?? null);
    picked.current = initial.file != null;
  }, [seq, sessionId, agent]);

  // A detached HEAD has no working-tree row worth opening on when it is clean:
  // the history opens on HEAD instead.
  useEffect(() => {
    if (sel !== UNCOMMITTED || !data.repo?.head.detached || !data.entries || data.entries.length) return;
    const head = data.repo.head.sha;
    if (head) setSelRaw(head);
  }, [data.repo, data.entries, sel]);

  // The commit's files, read once per commit while the view is open.
  const [commitFiles, setCommitFiles] = useState<Map<string, CommitFile[] | "error">>(() => new Map());
  useEffect(() => {
    if (!active || sel === UNCOMMITTED || commitFiles.has(sel)) return;
    let gone = false;
    fetch(`/api/git/commit?${gitQuery(sessionId, agent, { sha: sel })}`)
      .then(r => r.json() as Promise<DiffAnswer>)
      .then(a => { if (!gone) setCommitFiles(m => new Map(m).set(sel, a.ok && a.files ? a.files : "error")); })
      .catch(() => { if (!gone) setCommitFiles(m => new Map(m).set(sel, "error")); });
    return () => { gone = true; };
  }, [active, sel, sessionId, agent]);
  const files = sel === UNCOMMITTED ? null : commitFiles.get(sel);

  // The file the view opens on, once there is something to open.
  useEffect(() => {
    if (picked.current || file) return;
    const first = sel === UNCOMMITTED
      ? firstFile(data.entries, data.edits, focus)
      : Array.isArray(files) && files[0] ? { path: files[0].path, area: "commit", ...(files[0].from ? { from: files[0].from } : {}) } : null;
    if (first) setFile(first);
  }, [sel, data.entries, data.edits, files, file]);

  const setSel = useCallback((id: string) => {
    setSelRaw(id);
    setFile(null);
    picked.current = false;
  }, []);
  const pickFile = useCallback((f: GitFileRef) => { picked.current = true; setFile(f); }, []);

  // ── the diff ──
  const [diff, setDiff] = useState<DiffState>({ file: null, diff: null, loading: false, stale: false, error: null });
  const latest = useRef<DiffResult | null>(null);
  const urlFor = (f: GitFileRef) => (sel === UNCOMMITTED
    ? `/api/git/diff?${gitQuery(sessionId, agent, { path: f.path, area: f.area })}`
    : `/api/git/commit?${gitQuery(sessionId, agent, { sha: sel, path: f.path })}`);
  const fileKey = file ? `${sel}|${file.area}|${file.path}` : null;

  // A newly chosen file: read its diff a frame from now.
  useEffect(() => {
    if (!active || !file) { setDiff(d => (d.file === null && !d.loading ? d : { file: null, diff: null, loading: false, stale: false, error: null })); return; }
    let gone = false;
    setDiff({ file, diff: null, loading: true, stale: false, error: null });
    latest.current = null;
    const raf = requestAnimationFrame(() => {
      fetch(urlFor(file))
        .then(r => r.json() as Promise<DiffAnswer>)
        .then(a => {
          if (gone) return;
          if (a.ok && a.diff) setDiff({ file, diff: a.diff, loading: false, stale: false, error: null });
          else setDiff({ file, diff: null, loading: false, stale: false, error: a.reason ?? a.error ?? "error" });
        })
        .catch(() => { if (!gone) setDiff({ file, diff: null, loading: false, stale: false, error: "the deck did not answer" }); });
    });
    return () => { gone = true; cancelAnimationFrame(raf); };
  }, [active, fileKey]);

  // The working tree moved: read the open file's diff again, and keep a
  // changed one aside.
  const treeSeen = useRef(data.treeSeq);
  useEffect(() => {
    if (data.treeSeq === treeSeen.current) return;
    treeSeen.current = data.treeSeq;
    if (!active || !file || sel !== UNCOMMITTED || diff.loading) return;
    let gone = false;
    fetch(urlFor(file))
      .then(r => r.json() as Promise<DiffAnswer>)
      .then(a => {
        if (gone || !a.ok || !a.diff) return;
        if (sameDiff(a.diff, diff.diff)) return;
        latest.current = a.diff;
        setDiff(d => (d.file === file ? { ...d, stale: true } : d));
      })
      .catch(() => {});
    return () => { gone = true; };
  }, [data.treeSeq]);

  const showLatest = useCallback(() => {
    const next = latest.current;
    if (!next) return;
    latest.current = null;
    setDiff(d => ({ ...d, diff: next, stale: false }));
  }, []);

  return { sel, setSel, file, pickFile, commitFiles: files ?? null, diff, showLatest };
}

/** Counts the header's scope chip and the Uncommitted row say: the focus's
 *  commits and the files it edited, of all the changed ones. */
export function focusCounts(data: GitData, focus: GraphFocus): { commits: number; files: number; changed: number } {
  const changed = changedFiles(data.entries, data.edits, focus);
  return {
    commits: (data.commits ?? []).filter(c => madeByFocus(c, focus)).length,
    files: changed.filter(f => f.mine).length,
    changed: changed.length,
  };
}

/** Memoised `focusCounts`. */
export function useFocusCounts(data: GitData, focus: GraphFocus) {
  return useMemo(() => focusCounts(data, focus), [data.entries, data.edits, data.commits, focus.sessionId, focus.agentIds?.join()]);
}

/** What the shared read last said about a repository, or null before any
 *  read: lets `g` know a folder git cannot read before asking again. */
export function cachedGitState(sessionId: string, agent: string | null): GitData["state"] | null {
  const e = cache.get(keyOf(sessionId, agent));
  return e && e.data.at > 0 ? e.data.state : null;
}

/** The states in which a folder has no repository to open a view on. */
export const UNREADABLE = new Set<GitData["state"]>(["not-a-repo", "gone", "no-git", "bare", "unsafe"]);
