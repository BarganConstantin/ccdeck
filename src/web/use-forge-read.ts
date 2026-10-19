// A GitHub or GitLab panel's reads, as React state (#2179).
//
// forge-panel.ts keeps every answer for the page's life, keyed by the
// connection and the read's path; these hooks are how a component asks. They
// draw what was kept at once, ask again only when it is older than FRESH_MS
// (or the panel's Refresh bumps `refresh`), cancel a read the component no
// longer wants, and keep the last answer on screen when a refresh fails.
//
// A LIST IS ITS PAGES. useForgePages keeps the pages already loaded together,
// so "Load more" appends and re-opening the panel shows everything that was
// loaded; a refresh asks for the first page again and starts over from it,
// because a list that has moved under the reader is not continued from an old
// cursor.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ForgeErrorInfo, Page } from "./forge-types";
import {
  fetchForge, forgeReadPath, ForgeReadError, isStale, keepRead, keptRead, readDue, type ForgeApi, type Kept,
} from "./forge-panel";

export interface ForgeReadState<T> {
  data: T | null;
  error: ForgeErrorInfo | null;
  loading: boolean;
  loadedAt: number | null;
  /** Drawn from an answer whose latest refresh failed. */
  stale: boolean;
}

type Params = Record<string, string | number | null | undefined>;

function errorInfo(err: unknown): ForgeErrorInfo {
  return err instanceof ForgeReadError ? err.info : { kind: "upstream", message: "the read failed" };
}

/**
 * One read. `read` null asks nothing (a detail with nothing selected).
 * `scope` is the connection (`kind:connId`), so two connections never share
 * an answer; `refresh` is the panel's Refresh counter.
 */
export function useForgeRead<T>(api: ForgeApi, scope: string, read: string | null, params: Params = {}, refresh = 0): ForgeReadState<T> & { reload: () => void } {
  const path = read ? forgeReadPath(read, params) : null;
  const key = path ? `${scope}\n${path}` : null;
  const [state, setState] = useState<ForgeReadState<T>>(() => view<T>(key ? keptRead<T>(key) : null, false));
  const [forced, setForced] = useState(0);
  const lastRefresh = useRef(refresh);

  useEffect(() => {
    if (!key || !path) {
      setState(view<T>(null, false));
      return;
    }
    const entry = keptRead<T>(key);
    const force = forced > 0 || refresh !== lastRefresh.current;
    lastRefresh.current = refresh;
    if (!readDue(entry, Date.now(), force)) {
      setState(view(entry, false));
      return;
    }
    setState(view(entry, true));
    const controller = new AbortController();
    fetchForge<T>(api, path, controller.signal).then(
      data => {
        const next: Kept<T> = { data, loadedAt: Date.now(), error: null };
        keepRead(key, next);
        if (!controller.signal.aborted) setState(view(next, false));
      },
      err => {
        if (controller.signal.aborted || (err as Error)?.name === "AbortError") return;
        const next: Kept<T> = { ...keptRead<T>(key), error: errorInfo(err) };
        keepRead(key, next);
        setState(view(next, false));
      },
    );
    return () => controller.abort();
  }, [api, key, path, refresh, forced]);

  const reload = useCallback(() => setForced(n => n + 1), []);
  return { ...state, reload };
}

function view<T>(entry: Kept<T> | null, loading: boolean): ForgeReadState<T> {
  return {
    data: entry?.data ?? null,
    error: entry?.error ?? null,
    loading,
    loadedAt: entry?.loadedAt ?? null,
    stale: entry ? isStale(entry) : false,
  };
}

export interface ForgePagesState<T> extends ForgeReadState<Page<T>> {
  /** Asking for the next page right now. */
  loadingMore: boolean;
  /** The next page failed; the loaded ones stay. */
  moreError: ForgeErrorInfo | null;
  loadMore: () => void;
  reload: () => void;
}

/**
 * A paged list: the first page through useForgeRead (kept, refreshed), and
 * every page after it appended on "Load more" and kept with it.
 */
export function useForgePages<T>(api: ForgeApi, scope: string, read: string | null, params: Params = {}, refresh = 0): ForgePagesState<T> {
  const first = useForgeRead<Page<T>>(api, scope, read, params, refresh);
  const path = read ? forgeReadPath(read, params) : null;
  const key = path ? `${scope}\n${path}\nmore` : null;
  const [more, setMore] = useState<{ key: string | null; items: T[]; next: string | null | undefined; base: number | null }>(
    () => ({ key, ...restoreMore<T>(key) }),
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<ForgeErrorInfo | null>(null);

  // A new first page (a refresh, or another list) starts the pages over —
  // unless it is the same answer the appended pages were loaded after.
  const firstAt = first.loadedAt;
  useEffect(() => {
    setMoreError(null);
    const saved = restoreMore<T>(key);
    setMore(saved.base != null && saved.base === firstAt ? { key, ...saved } : { key, items: [], next: undefined, base: firstAt });
  }, [key, firstAt]);

  const next = more.next !== undefined ? more.next : first.data?.next ?? null;
  const loadMore = useCallback(() => {
    if (!read || !next || loadingMore || !key) return;
    setLoadingMore(true);
    setMoreError(null);
    fetchForge<Page<T>>(api, forgeReadPath(read, { ...params, cursor: next })).then(
      page => {
        setMore(m => {
          const updated = { key, items: [...m.items, ...page.items], next: page.next, base: m.base ?? firstAt };
          keepRead(key, { data: updated, loadedAt: Date.now(), error: null });
          return updated;
        });
      },
      err => setMoreError(errorInfo(err)),
    ).finally(() => setLoadingMore(false));
  }, [api, read, next, loadingMore, key, params, firstAt]);

  const data: Page<T> | null = first.data
    ? { items: [...first.data.items, ...(more.key === key ? more.items : [])], next, total: first.data.total }
    : null;
  return { ...first, data, loadingMore, moreError, loadMore, reload: first.reload };
}

function restoreMore<T>(key: string | null): { items: T[]; next: string | null | undefined; base: number | null } {
  const saved = key ? keptRead<{ items: T[]; next: string | null; base: number | null }>(key).data : null;
  return saved ? { items: saved.items, next: saved.next, base: saved.base } : { items: [], next: undefined, base: null };
}
