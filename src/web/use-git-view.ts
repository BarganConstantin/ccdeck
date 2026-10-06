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
  CommitFile, DiffResult, Edit, GitFileRef, GitReadState, GraphFocus, LogCommit, Repo, StatusCounts, StatusEntry, SubagentElsewhere,
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
  /** The session's subagents that work in another folder (a whole session's
   *  read only; a read narrowed to one subagent lists none). */
  subagents: SubagentElsewhere[] | null;
  /** Why a read inside a repository failed, when one did. */
  reason: string | null;
  /** Commits that appeared in the history since the read before. */
  newShas: string[];
  /** Bumped by each answer about the working tree, so a reader can tell the
   *  folder moved. */
  treeSeq: number;
  /** When the last read was asked for. */
  at: number;
}

export const EMPTY_GIT_DATA: GitData = {
  state: "loading", repo: null, entries: null, counts: null, commits: null, edits: null, subagents: null, reason: null,
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
  subagents?: SubagentElsewhere[];
}

/** The query a read names its session by: never a folder (git-routes.mjs). */
export function gitQuery(sessionId: string, agent: string | null, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({ session: sessionId, ...(agent ? { agent } : {}), ...extra });
  return q.toString();
}

/**
 * The commits `next` lists that `prev` did not, wherever they landed: at the
 * top, or further down under branches dated later (a fetch, another machine's
 * clock). What fills the window's foot because commits left it is not new:
 * only the commits above the last one both reads list count.
 */
export function newInHistory(prev: LogCommit[] | null, next: LogCommit[]): string[] {
  if (!prev || prev.length === 0) return [];
  const known = new Set(prev.map(c => c.sha));
  let last = -1;
  next.forEach((c, i) => { if (!c.outsideWindow && known.has(c.sha)) last = i; });
  const out: string[] = [];
  for (let i = 0; i < last; i++) {
    const c = next[i];
    if (!c.outsideWindow && !known.has(c.sha)) out.push(c.sha);
  }
  return out;
}

/** Fold one route's answer into the data. A route answering "not a repo",
 *  "gone" and the like answers for the whole read. */
export function foldAnswer(data: GitData, kind: "status" | "log" | "edits" | "repo", a: Answer, status: number): GitData {
  if (status === 409) return { ...data, state: "off" };
  if (status >= 400 || a.error) return { ...data, state: data.state === "loading" ? "error" : data.state, reason: a.error ?? `HTTP ${status}` };
  if (a.state && a.state !== "repo") return { ...data, state: a.state, repo: null };
  const next: GitData = { ...data, state: "repo", repo: a.repo ?? data.repo };
  if (a.ok === false) return { ...next, reason: a.reason ?? "error" };
  if (kind === "status") return { ...next, entries: a.entries ?? [], counts: a.counts ?? null, treeSeq: data.treeSeq + 1, reason: null };
  if (kind === "edits") return { ...next, edits: a.edits ?? [] };
  if (kind === "repo") return { ...next, subagents: a.subagents ?? [] };
  const commits = a.commits ?? [];
  return { ...next, commits, newShas: newInHistory(data.commits, commits) };
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

/** One read per session or subagent, and per scope of its edits: a subagent
 *  in a folder of its own has them read there, otherwise they are the whole
 *  team's — two answers that must never stand in for one another. */
export const keyOf = (sessionId: string, agent: string | null, ownFolder = false) =>
  `${sessionId}|${agent ?? ""}|${ownFolder && agent ? "own" : "team"}`;

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

/** The reads every view of a repository asks for. */
const READS = ["status", "edits", "log"] as const;

/** Ask the reads of one repository; each answer lands as it arrives, the
 *  working tree first, and an older read's late answers are dropped. A whole
 *  session's read also asks the repository route where its subagents work. */
function read(key: string, sessionId: string, agent: string | null, stale: number, editsAgent: string | null): void {
  const e = entryFor(key);
  const generation = ++e.generation;
  e.seen = stale;
  e.data = { ...e.data, at: Date.now() };
  const kinds = agent ? READS : [...READS, "repo"] as const;
  for (const kind of kinds) {
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
  const key = sessionId && enabled ? keyOf(sessionId, agent, ownFolder) : null;
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
  /** What is waiting is that git no longer lists the change (committed,
   *  staged, or put back as it was). */
  gone?: boolean;
  /** Why the diff could not be read: the route's reason, "unlisted" when git
   *  no longer lists the change, "the deck did not answer". */
  error: string | null;
}

/** A failed read of a commit's files, and why. */
export interface ReadFailure { error: string }

/** What a failed read answered, in a few words: the route's reason or error,
 *  else its status. */
const failureOf = (a: DiffAnswer, status: number) => a.reason ?? a.error ?? (status === 409 ? "off" : status >= 400 ? `HTTP ${status}` : "error");

/** Stands in for the latest diff when git no longer lists the change. */
const GONE = { directory: true } as DiffResult;

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

  // The commit's files, read once per commit while the view is open. A read
  // that failed is kept only until that commit is chosen again, asked for
  // again, or the folder moves: it is never shown as an empty commit.
  const [commitFiles, setCommitFiles] = useState<Map<string, CommitFile[] | ReadFailure>>(() => new Map());
  const [commitAgain, setCommitAgain] = useState(0);
  useEffect(() => {
    if (!active || sel === UNCOMMITTED || commitFiles.has(sel)) return;
    let gone = false;
    fetch(`/api/git/commit?${gitQuery(sessionId, agent, { sha: sel })}`)
      .then(async r => ({ status: r.status, a: (await r.json().catch(() => ({}))) as DiffAnswer }))
      .then(({ status, a }) => { if (!gone) setCommitFiles(m => new Map(m).set(sel, a.ok && a.files ? a.files : { error: failureOf(a, status) })); })
      .catch(() => { if (!gone) setCommitFiles(m => new Map(m).set(sel, { error: "the deck did not answer" })); });
    return () => { gone = true; };
  }, [active, sel, sessionId, agent, commitAgain]);
  const dropFailures = (only?: string) => setCommitFiles(m => {
    const failed = [...m].filter(([id, f]) => !Array.isArray(f) && (only === undefined || id === only));
    if (!failed.length) return m;
    const n = new Map(m);
    for (const [id] of failed) n.delete(id);
    return n;
  });
  useEffect(() => { dropFailures(); }, [data.treeSeq]);
  const retryCommit = useCallback(() => { dropFailures(); setCommitAgain(n => n + 1); }, []);
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
    dropFailures(id);
    setSelRaw(id);
    setFile(null);
    picked.current = false;
  }, []);
  const pickFile = useCallback((f: GitFileRef) => { picked.current = true; setFile(f); }, []);

  // ── the diff ──
  const [diff, setDiff] = useState<DiffState>({ file: null, diff: null, loading: false, stale: false, error: null });
  // Bumped to read the open file's diff again.
  const [again, setAgain] = useState(0);
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
        .then(async r => ({ status: r.status, a: (await r.json().catch(() => ({}))) as DiffAnswer }))
        .then(({ status, a }) => {
          if (gone) return;
          if (a.ok && a.diff) setDiff({ file, diff: a.diff, loading: false, stale: false, error: null });
          else setDiff({ file, diff: null, loading: false, stale: false, error: failureOf(a, status) });
        })
        .catch(() => { if (!gone) setDiff({ file, diff: null, loading: false, stale: false, error: "the deck did not answer" }); });
    });
    return () => { gone = true; cancelAnimationFrame(raf); };
  }, [active, fileKey, again]);

  // The working tree moved: read the open file's diff again, and keep a
  // changed one aside. A read of another folder (the view narrowed or
  // widened) is not the tree moving: its selection starts over instead, and
  // the file still selected here belongs to the folder before.
  const treeSeen = useRef<{ seq: number; of: string } | null>(null);
  useEffect(() => {
    const of = `${sessionId}|${agent ?? ""}`;
    const was = treeSeen.current;
    treeSeen.current = { seq: data.treeSeq, of };
    if (!was || (data.treeSeq === was.seq && of === was.of)) return;
    const sameRead = of === was.of;
    if (!sameRead || !active || !file || sel !== UNCOMMITTED || diff.loading) return;
    // A change git no longer lists has no diff to read: the header says so,
    // and the diff on screen stays until the reader asks for the latest.
    const unlisted = () => {
      latest.current = GONE;
      setDiff(d => (d.file === file && d.diff ? { ...d, stale: true, gone: true } : d));
    };
    if (data.entries && !data.entries.some(e => e.path === file.path && e.area === file.area)) { unlisted(); return; }
    let gone = false;
    fetch(urlFor(file))
      .then(async r => ({ status: r.status, a: (await r.json().catch(() => ({}))) as DiffAnswer }))
      .then(({ status, a }) => {
        if (gone) return;
        if (status === 404) { unlisted(); return; }
        if (!a.ok || !a.diff) return;
        if (sameDiff(a.diff, diff.diff)) {
          // Changed and changed back since: nothing is waiting any more.
          if (latest.current) { latest.current = null; setDiff(d => (d.file === file ? { ...d, stale: false, gone: false } : d)); }
          return;
        }
        latest.current = a.diff;
        setDiff(d => (d.file === file ? { ...d, stale: true, gone: false } : d));
      })
      .catch(() => {});
    return () => { gone = true; };
  }, [data.treeSeq, sessionId, agent]);

  /** `n`, the pill and the header's reload: the latest diff when one is
   *  waiting, else the open file's diff read again. */
  const showLatest = useCallback(() => {
    const next = latest.current;
    latest.current = null;
    if (next === GONE) { setDiff(d => ({ ...d, diff: null, stale: false, gone: false, error: "unlisted" })); return; }
    if (next) { setDiff(d => ({ ...d, diff: next, stale: false, gone: false })); return; }
    setAgain(n => n + 1);
  }, []);

  return { sel, setSel, file, pickFile, commitFiles: files ?? null, diff, showLatest, retryCommit };
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
  // Whether the folder holds a repository does not depend on whose edits were read.
  for (const own of [false, true]) {
    const e = cache.get(keyOf(sessionId, agent, own));
    if (e && e.data.at > 0) return e.data.state;
  }
  return null;
}

/** The states in which a folder has no repository to open a view on. */
export const UNREADABLE = new Set<GitData["state"]>(["not-a-repo", "gone", "no-git", "bare", "unsafe"]);
