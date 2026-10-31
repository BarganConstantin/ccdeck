// What the Jira panel has read of one board (#2178), and how it reads it.
//
// LOADED ON OPEN, NOT POLLED. A board is read when the panel opens on it and
// what it has is more than five minutes old, and when the reader presses
// Refresh — never on a timer. What was read is kept per connection, board and
// server-side filter (module memory, for as long as the page is open), so
// closing and reopening the panel, or turning "Only my issues" off and on
// again, draws at once.
//
// PROGRESSIVE. The board's overview first (its sprints, its quick filters),
// then every active sprint at once, then the rest a few at a time, so the
// sprint the reader opened the panel for is drawn before the backlog is read.
// Closed sprints are read only when asked for, and each one's issues only when
// it is opened.
//
// STALE STAYS ON SCREEN. A failed refresh keeps everything already drawn and
// says what went wrong above it; a refused token or Jira's rate limit stops
// the refresh outright, since every further read would fail the same way.

import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "./i18n";
import { IntegrationFailure } from "./integrations/client";
import {
  readBoard, readClosedSprints, readIssues, readSubtasks, readIssue,
  type IssueQuery, type JiraApi, type JiraBoardOverview, type JiraIssue, type JiraIssueDetail, type JiraSprint,
} from "./jira-api";
import { groupsFor, type GroupDef } from "./jira-board";

/** How old a board may be when the panel opens before it is read again. */
export const STALE_MS = 5 * 60_000;
const DETAIL_STALE_MS = 2 * 60_000;
const MAX_SNAPSHOTS = 24;

export interface GroupData {
  status: "idle" | "loading" | "ready" | "error";
  issues: JiraIssue[];
  /** The backlog's next page, "" when there is none. */
  next: string;
  total: number | null;
  capped: boolean;
  error: IntegrationFailure | null;
  /** A further backlog page is being read. */
  more: boolean;
}

export interface SubtaskData {
  status: "loading" | "ready" | "error";
  issues: JiraIssue[];
  error: IntegrationFailure | null;
}

export interface ClosedData {
  shown: boolean;
  sprints: JiraSprint[];
  total: number;
  isLast: boolean;
  loading: boolean;
  error: IntegrationFailure | null;
}

export interface BoardSnapshot {
  overview: JiraBoardOverview | null;
  groups: Record<string, GroupData>;
  subtasks: Record<string, SubtaskData>;
  closed: ClosedData;
  /** When the last full read finished; 0 for never. */
  loadedAt: number;
}

export interface BoardFilters {
  mine: boolean;
  /** Quick filter ids, in the board's order. */
  quick: string[];
}

const EMPTY_CLOSED: ClosedData = { shown: false, sprints: [], total: 0, isLast: false, loading: false, error: null };
const EMPTY_GROUP: GroupData = { status: "idle", issues: [], next: "", total: null, capped: false, error: null, more: false };

const snapshots = new Map<string, BoardSnapshot>();
const detailInvalidations = new Set<(connId: string) => void>();
const boardInvalidations = new Set<(connId: string) => Promise<void> | undefined>();

/** A rank/sprint change affects other boards and saved filter views too. */
export function invalidateJiraConnection(connId: string, refreshBoards = false) {
  for (const [key, snap] of snapshots) {
    if (key.startsWith(`${connId}|`)) snapshots.set(key, { ...snap, loadedAt: 0 });
  }
  for (const key of details.keys()) if (key.startsWith(`${connId}|`)) details.delete(key);
  for (const notify of detailInvalidations) notify(connId);
  return refreshBoards ? Promise.all([...boardInvalidations].map(notify => notify(connId))).then(() => {}) : Promise.resolve();
}

const snapshotKey = (connId: string, boardId: string, f: BoardFilters) =>
  `${connId}|${boardId}|${f.mine ? "mine" : "all"}|${f.quick.join(",")}`;

function keep(key: string, snap: BoardSnapshot) {
  snapshots.delete(key);
  snapshots.set(key, snap);
  while (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!);
}

/** A board read under other filters lends its overview, so changing a filter
 *  redraws the sprint headers at once and only the issues are read again. */
function seed(connId: string, boardId: string): BoardSnapshot {
  for (const [key, snap] of [...snapshots.entries()].reverse()) {
    if (key.startsWith(`${connId}|${boardId}|`) && snap.overview) {
      return { overview: snap.overview, groups: {}, subtasks: {}, closed: { ...EMPTY_CLOSED, shown: snap.closed.shown, loading: snap.closed.loading, sprints: snap.closed.sprints, total: snap.closed.total, isLast: snap.closed.isLast }, loadedAt: 0 };
    }
  }
  return { overview: null, groups: {}, subtasks: {}, closed: EMPTY_CLOSED, loadedAt: 0 };
}

/** A panel can close while a group or page is loading. Those requests cannot
 * finish into the next mount, so reopen them as retryable and stale. */
function recoverInterrupted(snap: BoardSnapshot): BoardSnapshot {
  if (!snap.closed.loading && !Object.values(snap.groups).some(g => g.status === "loading" || g.more)
    && !Object.values(snap.subtasks).some(s => s.status === "loading")) return snap;
  const groups = Object.fromEntries(Object.entries(snap.groups).map(([id, group]) => [id, {
    ...group, status: group.status === "loading" ? "idle" : group.status, more: false,
  }]));
  const subtasks = Object.fromEntries(Object.entries(snap.subtasks).filter(([, data]) => data.status !== "loading"));
  return { ...snap, groups, subtasks, closed: { ...snap.closed, loading: false }, loadedAt: 0 };
}

export function failureOf(err: unknown): IntegrationFailure {
  if (err instanceof IntegrationFailure) return err;
  return new IntegrationFailure("upstream", err instanceof Error && err.message ? err.message : t("integrations.error.jiraRead"));
}

const isAbort = (err: unknown) => err instanceof DOMException && err.name === "AbortError";

/** The kinds that end a refresh: every further read would fail the same way. */
export const FATAL_KINDS = new Set(["auth", "expired", "rate-limit", "tls", "unreachable", "incompatible", "network", "unavailable"]);

function queryFor(group: GroupDef, filters: BoardFilters, overview: JiraBoardOverview, cursor = ""): IssueQuery {
  const base = { mine: filters.mine, quick: filters.quick };
  if (group.kind === "backlog") return { ...base, source: "backlog", cursor };
  if (group.kind === "column") return { ...base, source: "kanban", column: group.column, backlog: overview.hasBacklog };
  return { ...base, source: "sprint", sprint: group.sprint!.id };
}

/** Run `work` over `items`, `limit` at a time, in order. */
async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  });
  await Promise.all(lanes);
}

export interface JiraBoardApi {
  snap: BoardSnapshot;
  groups: GroupDef[];
  /** A refresh is reading. */
  loading: boolean;
  /** What stopped the last refresh, if anything did. */
  error: IntegrationFailure | null;
  refresh: () => Promise<void>;
  /** Read a group that has not been read — a closed sprint just opened — or,
   *  with `force`, read one again after it failed. */
  ensureGroup: (group: GroupDef, force?: boolean) => void;
  /** The backlog's next page. */
  loadMore: (group: GroupDef) => void;
  showClosed: (shown: boolean) => void;
  moreClosed: () => void;
  loadSubtasks: (key: string) => void;
}

export function useJiraBoard(api: JiraApi, connId: string, boardId: string | null, filters: BoardFilters): JiraBoardApi {
  const key = boardId ? snapshotKey(connId, boardId, filters) : "";
  const [snap, setSnap] = useState<BoardSnapshot>(() => (key && snapshots.get(key)) || seed(connId, boardId ?? ""));
  const snapRef = useRef(snap);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<IntegrationFailure | null>(null);
  const gen = useRef(0);
  const subtaskEpoch = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const keyRef = useRef(key);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; abort.current?.abort(); };
  }, []);
  const readSignal = useCallback(() => {
    if (!abort.current || abort.current.signal.aborted) abort.current = new AbortController();
    return abort.current.signal;
  }, []);

  const update = useCallback((forKey: string, change: (s: BoardSnapshot) => BoardSnapshot) => {
    if (!mounted.current || forKey !== keyRef.current) return;
    const next = change(snapRef.current);
    snapRef.current = next;
    if (forKey) keep(forKey, next);
    setSnap(next);
  }, []);

  const setGroup = useCallback((forKey: string, id: string, change: (g: GroupData) => GroupData) => {
    update(forKey, s => ({ ...s, groups: { ...s.groups, [id]: change(s.groups[id] ?? EMPTY_GROUP) } }));
  }, [update]);

  const loadGroup = useCallback(async (forKey: string, group: GroupDef, overview: JiraBoardOverview, signal: AbortSignal) => {
    if (!boardId) return;
    setGroup(forKey, group.id, g => ({ ...g, status: "loading", error: null }));
    try {
      const page = await readIssues(api, boardId, queryFor(group, filtersRef.current, overview), signal);
      if (signal.aborted) return;
      setGroup(forKey, group.id, () => ({ status: "ready", issues: page.issues, next: page.next, total: page.total, capped: page.capped, error: null, more: false }));
    } catch (err) {
      if (isAbort(err) || signal.aborted) return;
      const failure = failureOf(err);
      setGroup(forKey, group.id, g => ({ ...g, status: "error", error: failure, more: false }));
      if (FATAL_KINDS.has(failure.kind)) throw failure;
    }
  }, [boardId, api, setGroup]);

  const refresh = useCallback(async () => {
    if (!mounted.current || !boardId || keyRef.current !== key) return;
    const forKey = keyRef.current;
    const mine = ++gen.current;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const { signal } = controller;
    const interruptedClosed = snapRef.current.closed.loading ? snapRef.current.closed.sprints.length : null;
    // A partial or interrupted refresh must never make its old snapshot look fresh.
    update(forKey, s => {
      const recovered = recoverInterrupted(s);
      return { ...recovered, closed: interruptedClosed === null ? recovered.closed : { ...recovered.closed, loading: true }, loadedAt: 0 };
    });
    setLoading(true);
    setError(null);
    await (async () => {
      try {
        const overview = await readBoard(api, boardId, signal);
        if (signal.aborted || !mounted.current || mine !== gen.current) return;
        subtaskEpoch.current++;
        update(forKey, s => ({ ...s, overview, subtasks: {} }));
        const closed = snapRef.current.closed;
        const defs = groupsFor(overview, closed.shown ? closed.sprints : []);
        const first = defs.filter(d => d.kind === "active" || (d.kind === "column" && d.column !== "done"));
        // Closed sprints are read when opened; one already read and open is
        // read again with the rest.
        const rest = defs.filter(d => !first.includes(d) && (d.kind !== "closed" || snapRef.current.groups[d.id]));
        await Promise.all(first.map(d => loadGroup(forKey, d, overview, signal)));
        await pool(rest, 3, d => (signal.aborted ? Promise.resolve() : loadGroup(forKey, d, overview, signal)));
        if (interruptedClosed !== null && !signal.aborted && mine === gen.current) {
          update(forKey, s => ({ ...s, closed: { ...s.closed, loading: true, error: null } }));
          try {
            const page = await readClosedSprints(api, boardId, interruptedClosed, signal);
            if (!signal.aborted && mine === gen.current) update(forKey, s => {
              const have = new Set(s.closed.sprints.map(x => x.id));
              const sprints = interruptedClosed === 0 ? page.sprints : [...s.closed.sprints, ...page.sprints.filter(x => !have.has(x.id))];
              return { ...s, closed: { ...s.closed, sprints, total: page.total, isLast: page.isLast, loading: false, error: null } };
            });
          } catch (err) {
            if (!signal.aborted && mine === gen.current) update(forKey, s => ({ ...s, closed: { ...s.closed, loading: false, error: failureOf(err) } }));
          }
        }
        if (mine === gen.current) update(forKey, s => ({ ...s, loadedAt: [...first, ...rest].some(d => s.groups[d.id]?.status === "error") || (interruptedClosed !== null && s.closed.error) ? 0 : Date.now() }));
      } catch (err) {
        if (isAbort(err) || signal.aborted || mine !== gen.current) return;
        controller.abort();
        const failure = failureOf(err);
        update(forKey, s => {
          const recovered = recoverInterrupted(s);
          return s.closed.loading ? { ...recovered, closed: { ...recovered.closed, error: failure } } : recovered;
        });
        setError(failure);
      } finally {
        if (mine === gen.current) setLoading(false);
      }
    })();
  }, [boardId, api, key, loadGroup, update]);

  useEffect(() => {
    const invalidated = (id: string) => id === connId ? refresh() : undefined;
    boardInvalidations.add(invalidated);
    return () => { boardInvalidations.delete(invalidated); };
  }, [connId, refresh]);

  // A new board or new filters: what was read before, at once, and a read if
  // it is older than five minutes.
  useEffect(() => {
    abort.current?.abort();
    gen.current++;
    keyRef.current = key;
    const cached = key ? snapshots.get(key) : undefined;
    const recovered = cached ? recoverInterrupted(cached) : undefined;
    const base = recovered ?? seed(connId, boardId ?? "");
    const recoveredClosed = Boolean((cached ?? base).closed.loading);
    const start = recoveredClosed ? { ...base, closed: { ...base.closed, loading: true } } : base;
    if (key && recovered && start !== cached) keep(key, start);
    snapRef.current = start;
    setSnap(start);
    setLoading(false);
    setError(null);
    if (!boardId) { abort.current?.abort(); setLoading(false); return; }
    if (!recovered || Date.now() - recovered.loadedAt > STALE_MS) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const ensureGroup = useCallback((group: GroupDef, force = false) => {
    const overview = snapRef.current.overview;
    const at = snapRef.current.groups[group.id];
    if (!overview || (at && at.status !== "idle" && !(force && at.status === "error"))) return;
    const signal = readSignal();
    const forKey = keyRef.current;
    void loadGroup(forKey, group, overview, signal).catch(err => setError(failureOf(err)));
  }, [loadGroup, readSignal]);

  const loadMore = useCallback((group: GroupDef) => {
    const overview = snapRef.current.overview;
    const at = snapRef.current.groups[group.id];
    if (!boardId || !overview || !at || !at.next || at.more) return;
    const forKey = keyRef.current;
    const generation = gen.current;
    const signal = readSignal();
    setGroup(forKey, group.id, g => ({ ...g, more: true, error: null }));
    void (async () => {
      try {
        const page = await readIssues(api, boardId, queryFor(group, filtersRef.current, overview, at.next), signal);
        if (signal?.aborted || generation !== gen.current || !mounted.current) return;
        setGroup(forKey, group.id, g => {
          const have = new Set(g.issues.map(i => i.key));
          return { ...g, issues: [...g.issues, ...page.issues.filter(i => !have.has(i.key))], next: page.next, total: page.total ?? g.total, capped: page.capped, more: false };
        });
      } catch (err) {
        if (signal?.aborted || generation !== gen.current || !mounted.current) return;
        const failure = failureOf(err);
        setGroup(forKey, group.id, g => ({ ...g, more: false, error: failure }));
      }
    })();
  }, [boardId, api, setGroup, readSignal]);

  const readClosed = useCallback((startAt: number) => {
    if (!boardId) return;
    const forKey = keyRef.current;
    const generation = gen.current;
    const signal = readSignal();
    update(forKey, s => ({ ...s, closed: { ...s.closed, shown: true, loading: true, error: null } }));
    void (async () => {
      try {
        const page = await readClosedSprints(api, boardId, startAt, signal);
        if (signal?.aborted || generation !== gen.current || !mounted.current) return;
        update(forKey, s => {
          const have = new Set(s.closed.sprints.map(x => x.id));
          const sprints = startAt === 0 ? page.sprints : [...s.closed.sprints, ...page.sprints.filter(x => !have.has(x.id))];
          // A reader may have hidden the groups while this page was pending.
          return { ...s, closed: { ...s.closed, sprints, total: page.total, isLast: page.isLast, loading: false, error: null } };
        });
      } catch (err) {
        if (signal?.aborted || generation !== gen.current || !mounted.current) return;
        const failure = failureOf(err);
        update(forKey, s => ({ ...s, closed: { ...s.closed, loading: false, error: failure } }));
      }
    })();
  }, [boardId, api, update, readSignal]);

  const showClosed = useCallback((shown: boolean) => {
    const forKey = keyRef.current;
    if (!shown) { update(forKey, s => ({ ...s, closed: { ...s.closed, shown: false } })); return; }
    const closed = snapRef.current.closed;
    if (closed.sprints.length || closed.loading) update(forKey, s => ({ ...s, closed: { ...s.closed, shown: true } }));
    else readClosed(0);
  }, [readClosed, update]);

  const moreClosed = useCallback(() => {
    const closed = snapRef.current.closed;
    if (closed.loading || closed.isLast) return;
    readClosed(closed.sprints.length);
  }, [readClosed]);

  const loadSubtasks = useCallback((parentKey: string) => {
    const at = snapRef.current.subtasks[parentKey];
    if (at && at.status !== "error") return;
    const forKey = keyRef.current;
    const generation = gen.current;
    const epoch = subtaskEpoch.current;
    const signal = readSignal();
    const set = (data: SubtaskData) => update(forKey, s => ({ ...s, subtasks: { ...s.subtasks, [parentKey]: data } }));
    set({ status: "loading", issues: at?.issues ?? [], error: null });
    void readSubtasks(api, parentKey, signal)
      .then(answer => { if (!signal?.aborted && generation === gen.current && epoch === subtaskEpoch.current && mounted.current) set({ status: "ready", issues: answer.issues, error: null }); })
      .catch(err => { if (!signal?.aborted && generation === gen.current && epoch === subtaskEpoch.current && mounted.current) set({ status: "error", issues: [], error: failureOf(err) }); });
  }, [api, update, readSignal]);

  const closed = snap.closed;
  const groups = snap.overview ? groupsFor(snap.overview, closed.shown ? closed.sprints : []) : [];
  return { snap, groups, loading, error, refresh, ensureGroup, loadMore, showClosed, moreClosed, loadSubtasks };
}

// ── one issue ───────────────────────────────────────────────────────────────

const details = new Map<string, { at: number; data: JiraIssueDetail }>();

export interface IssueDetailState {
  data: JiraIssueDetail | null;
  loading: boolean;
  error: IntegrationFailure | null;
  reload: () => void;
}

/** One issue in full, for the detail pane: shown at once from memory when it
 *  was read in the last two minutes, read again otherwise. */
export function useJiraIssue(api: JiraApi, connId: string, key: string | null): IssueDetailState {
  const cacheKey = key ? `${connId}|${key}` : "";
  const [data, setData] = useState<JiraIssueDetail | null>(() => (cacheKey ? details.get(cacheKey)?.data ?? null : null));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<IntegrationFailure | null>(null);
  const [nonce, setNonce] = useState(0);
  const forced = useRef(false);
  const dataKey = useRef(cacheKey);

  useEffect(() => {
    const invalidated = (id: string) => {
      if (id === connId && key) { forced.current = true; setNonce(n => n + 1); }
    };
    detailInvalidations.add(invalidated);
    return () => { detailInvalidations.delete(invalidated); };
  }, [connId, key]);

  useEffect(() => {
    const sameIssue = dataKey.current === cacheKey;
    dataKey.current = cacheKey;
    if (!key) { setData(null); setError(null); return; }
    const hit = details.get(cacheKey);
    setData(previous => hit?.data ?? (sameIssue ? previous : null));
    setError(null);
    if (hit && !forced.current && Date.now() - hit.at < DETAIL_STALE_MS) { setLoading(false); return; }
    forced.current = false;
    const controller = new AbortController();
    setLoading(true);
    readIssue(api, key, controller.signal)
      .then(answer => {
        if (controller.signal.aborted) return;
        details.set(cacheKey, { at: Date.now(), data: answer });
        if (details.size > 60) details.delete(details.keys().next().value!);
        setData(answer);
      })
      .catch(err => { if (!isAbort(err) && !controller.signal.aborted) setError(failureOf(err)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [cacheKey, api, key, nonce]);

  const reload = useCallback(() => { forced.current = true; setNonce(n => n + 1); }, []);
  return { data, loading, error, reload };
}
