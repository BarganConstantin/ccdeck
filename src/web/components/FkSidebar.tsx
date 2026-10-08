// The git view's sidebar in the Fork look: a floating panel down the left of
// the view, as Fork draws it on macOS — the repository's name, the two views
// (Local Changes, All Commits), a filter, and the repository's refs in
// disclosure sections: Worktrees, Branches, Remotes, Tags, Stashes,
// Submodules.
//
// Read-only like the whole view. A click or Enter on a ref selects its commit
// in the history — a stash, a submodule's commit and a tag of a tree are not
// in it, and are copied only; nothing here checks out, creates, deletes or
// fetches, and the one menu it has, a ref's, only copies its name or its SHA.
// Opening the repository in an app and copying its path are the toolbar's,
// once.
//
// Which sections and folders are open is remembered per repository. The
// refs come from GET /api/git/refs (use-git-refs.ts), read again when the
// view's stale counter moves, when the view follows the session to another
// worktree, and when the panel is shown over an old read.
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { copyText } from "../copy-text";
import { failureLasts, failureLine } from "../git-diff-parse";
import { isEscapeKey } from "../modal-dismiss";
import { sidebarRows, withOpen, type OpenState, type SbRow } from "../fk-sidebar-model";
import type { Repo } from "../git-view-types";
import { readStored, writeStored } from "../storage";
import { useGitRefs, type GitRefsData } from "../use-git-refs";
import { FkSidebarTree } from "./FkSidebarTree";

export interface FkSidebarProps {
  sessionId: string;
  agent: string | null;
  repo: Repo | null;
  /** The worktree the view reads now. Known from the start of a move to
   *  another worktree, while the history's own answer (`repo`) is still empty. */
  top: string | null;
  /** The view's stale counter: the refs are read again when it moves. */
  stale: number;
  /** The view on show; null while the git view has not decided where it opens. */
  view: "all" | "local" | null;
  onView: (v: "all" | "local") => void;
  /** How many files the working tree has changed: `Local Changes (N)`. */
  localCount: number;
  /** The commit selected in the history: Tab into the tree lands on a ref there. */
  selectedSha: string | null;
  /** Select a commit in the history (the view says so when it is not loaded). */
  onJump: (sha: string) => void;
  /** The sidebar has focus in a focused window: its selection is drawn in the focused colour. */
  focused: boolean;
}

// ── open sections, per repository ────────────────────────────────────────

export const SIDEBAR_STORE_KEY = "agent-dag.gitSidebar";
const KEEP_REPOS = 24;

type Stored = Record<string, { open: OpenState; at: number }>;

function readAll(): Stored {
  try {
    const v = JSON.parse(readStored(SIDEBAR_STORE_KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v as Stored : {};
  } catch { return {}; }
}

/** The open sections and folders last left for a repository. */
export function readOpenState(repoKey: string | null): OpenState {
  if (!repoKey) return {};
  const open = readAll()[repoKey]?.open;
  if (!open || typeof open !== "object") return {};
  return Object.fromEntries(Object.entries(open).filter(([, v]) => typeof v === "boolean"));
}

function writeOpenState(repoKey: string, open: OpenState): void {
  const all = readAll();
  all[repoKey] = { open, at: Date.now() };
  const keys = Object.keys(all).sort((a, b) => (all[b].at ?? 0) - (all[a].at ?? 0));
  for (const k of keys.slice(KEEP_REPOS)) delete all[k];
  writeStored(SIDEBAR_STORE_KEY, JSON.stringify(all));
}

// ── glyphs of the panel's head ───────────────────────────────────────────

const LocalChangesGlyph = () => (
  <svg className="fk-sb-nav-icon" width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="currentColor" strokeWidth="1.6"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M10.2 2.2H4.6c-.6 0-1 .4-1 1v10.6c0 .6.4 1 1 1h7.8c.6 0 1-.4 1-1V5.4Z" />
    <path d="M10.2 2.2v3.2h3.2M8.5 6.6v3.4M6.8 8.3h3.4M6.8 12.1h3.4" />
  </svg>
);
const AllCommitsGlyph = () => (
  <svg className="fk-sb-nav-icon" width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="currentColor" strokeWidth="1.6"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M2.4 9.6V13c0 .6.4 1 1 1h10.2c.6 0 1-.4 1-1V9.6L12.4 3.6c-.1-.4-.5-.6-.9-.6H5.5c-.4 0-.8.2-.9.6Z" />
    <path d="M2.4 9.6h3.4l.9 1.6h3.6l.9-1.6h3.4M5.8 5.6h5.4M5.3 7.6h6.4" />
  </svg>
);
const LensGlyph = () => (
  <svg className="fk-sb-lens" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" aria-hidden="true" focusable="false">
    <circle cx="5" cy="5" r="3.6" /><path d="m7.7 7.7 3 3" />
  </svg>
);
// ── a ref's menu: copies only ────────────────────────────────────────

interface MenuItem { id: string; label: string; act: () => void }
interface MenuState { items: MenuItem[]; x: number; y: number; label: string; back: HTMLElement | null }

function SbMenu({ menu, onClose }: { menu: MenuState; onClose: (refocus: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // Under the pointer or the row, kept inside the git view (its key scope)
  // with 8px to spare, and placed before it is painted. It is fixed, so the
  // sidebar's rounded panel does not clip it; where it actually landed is
  // measured and corrected, whatever box an ancestor makes it relative to.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const scope = el.closest('[data-key-scope="git"]')?.getBoundingClientRect();
    const clip = scope ?? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    const w = el.offsetWidth, h = el.offsetHeight;
    const left = Math.max(clip.left + 8, Math.min(menu.x, clip.right - w - 8));
    const top = menu.y + h > clip.bottom - 8 ? Math.max(clip.top + 8, menu.y - h) : menu.y;
    el.style.left = "0px";
    el.style.top = "0px";
    const at = el.getBoundingClientRect();
    el.style.left = `${Math.round(left - at.left)}px`;
    el.style.top = `${Math.round(top - at.top)}px`;
    el.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [menu]);
  useEffect(() => {
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(false); };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [onClose]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (isEscapeKey(e.key)) { e.preventDefault(); e.stopPropagation(); onClose(true); return; }
    if (e.key === "Tab") { onClose(false); return; }
    const to = e.key === "ArrowDown" ? (at + 1) % items.length : e.key === "ArrowUp" ? (at - 1 + items.length) % items.length
      : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : -1;
    if (to >= 0) { e.preventDefault(); items[to]?.focus(); return; }
    if (e.key !== "Enter" && e.key !== " ") e.preventDefault();
  };
  return (
    <div className="fk-sb-menu" role="menu" aria-label={menu.label} ref={ref} onKeyDown={onKeyDown}>
      {menu.items.map(item => (
        <button key={item.id} type="button" role="menuitem" className="fk-sb-menu-item"
          onClick={() => { onClose(true); item.act(); }}>
          {item.label}
        </button>
      ))}
    </div>
  );
}

/**
 * What the panel says over its tree when it has no refs to list: a first read
 * that failed, and why, with Try again unless reading again cannot mend it
 * (git timing out or erring on the folder is such a read, not a folder with
 * no repository); a folder with none; the last refs kept through a failed
 * refresh; branches listed without the ahead and behind counts git took too
 * long to work out. Nothing while the first read is on its way or git is
 * switched off.
 */
export function RefsNote({ refs, onRetry }: { refs: GitRefsData; onRetry: () => void }) {
  if (refs.refs) {
    if (refs.reason) return <p className="fk-sb-msg" title={refs.reason}>Showing the last branches read.</p>;
    return refs.refs.unread.includes("counts") ? <p className="fk-sb-msg is-note">Ahead and behind counts are not shown: git took too long to count them.</p> : null;
  }
  const why = refs.reason ?? (refs.state === "timeout" || refs.state === "error" ? refs.state : null);
  if (why) {
    return (
      <div className="fk-sb-msg is-failed">
        <b>Could not read the branches.</b>
        <span>{failureLine(why)}</span>
        {!failureLasts(why) && <button type="button" className="btn fk-sb-retry" onClick={onRetry}>Try again</button>}
      </div>
    );
  }
  if (refs.state === "loading" || refs.state === "off" || refs.state === "repo") return null;
  return <p className="fk-sb-msg">No repository here.</p>;
}

export default function FkSidebar({ sessionId, agent, repo, top, stale, view, onView, localCount, selectedSha, onJump, focused }: FkSidebarProps) {
  // The worktree the view reads now, and a panel just shown: both read the
  // refs again, as the history is read again for them.
  const refs = useGitRefs({ sessionId, agent, stale, top, fresh: true });
  const repoKey = repo ? repo.commonDir || repo.topLevel : null;
  const [open, setOpen] = useState<OpenState>(() => readOpenState(repoKey));
  const [openFor, setOpenFor] = useState(repoKey);
  const [query, setQuery] = useState("");
  const [selKey, setSelKey] = useState<string | null>(null);
  if (openFor !== repoKey) {
    setOpenFor(repoKey);
    setOpen(readOpenState(repoKey));
    setSelKey(null);
    setQuery("");
  }
  const rows = useMemo(() => sidebarRows({
    refs: refs.refs, topLevel: repo?.topLevel ?? null, defaultBranch: repo?.defaultBranch ?? null, open, query,
  }), [refs.refs, repo?.topLevel, repo?.defaultBranch, open, query]);

  const setRowOpen = useCallback((key: string, value: boolean) => {
    if (query.trim()) return;
    setOpen(prev => {
      const next = withOpen(prev, key, value);
      if (next !== prev && repoKey) writeOpenState(repoKey, next);
      return next;
    });
  }, [repoKey, query]);

  // The row Tab lands on: the one chosen, else a ref at the selected commit,
  // else the checked-out branch, else the first row.
  const stopKey = useMemo(() => {
    if (selKey && rows.some(r => r.key === selKey)) return selKey;
    const at = selectedSha ? rows.find(r => r.sha === selectedSha && r.kind !== "section") : null;
    return at?.key ?? rows.find(r => r.current && r.kind === "branch")?.key ?? rows[0]?.key ?? null;
  }, [rows, selKey, selectedSha]);

  const filterRef = useRef<HTMLInputElement>(null);
  const [focusSeq, setFocusSeq] = useState(0);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [said, setSaid] = useState("");
  const uid = useId();

  const copy = (value: string, what: string) => {
    void copyText(value).then(ok => setSaid(ok ? `Copied ${what}` : `Could not copy ${what}; it is ${value}`));
  };

  const closeMenu = useCallback((refocus: boolean) => {
    setMenu(m => {
      if (refocus && m?.back?.isConnected) requestAnimationFrame(() => m.back?.focus({ preventScroll: true }));
      return null;
    });
  }, []);

  const rowMenu = useCallback((row: SbRow, at: { x: number; y: number }) => {
    const items: MenuItem[] = [];
    if (row.copy) items.push({ id: "name", label: row.kind === "worktree" ? "Copy path" : "Copy name", act: () => copy(row.copy!, row.kind === "worktree" ? "the path" : "the name") });
    if (row.copySha) items.push({ id: "sha", label: "Copy SHA", act: () => copy(row.copySha!, "the SHA") });
    if (!items.length) return;
    setMenu({ items, x: at.x, y: at.y, label: row.label, back: document.activeElement as HTMLElement | null });
  }, []);

  const onType = useCallback((text: string) => {
    setQuery(q => q + text);
    const input = filterRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    requestAnimationFrame(() => { const n = input.value.length; input.setSelectionRange(n, n); });
  }, []);

  const onFilterKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isEscapeKey(e.key) && query) { e.preventDefault(); e.stopPropagation(); setQuery(""); return; }
    if ((e.key === "ArrowDown" || e.key === "Enter") && rows.length) {
      e.preventDefault();
      // To the first ref the filter left, else the tree's own stop.
      const firstRef = rows.find(r => r.copySha);
      if (firstRef && query.trim()) setSelKey(firstRef.key);
      setFocusSeq(n => n + 1);
    }
  };

  const onNavKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const btns = [...(e.currentTarget.querySelectorAll<HTMLButtonElement>("button"))];
    const at = btns.indexOf(e.target as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    if (e.key === "ArrowDown" && at === btns.length - 1) { filterRef.current?.focus(); return; }
    btns[Math.max(0, Math.min(btns.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };

  const name = repo?.name ?? "";

  return (
    <div className="fk-sb" role="group" aria-label={name ? `${name}: views, branches and refs` : "Views, branches and refs"} data-focused={focused ? "" : undefined}>
      <div className="fk-sb-repo">
        <span className="fk-sb-repo-name" title={repo?.topLevel ?? undefined}>{name}</span>
      </div>
      <div className="fk-sb-nav" onKeyDown={onNavKey}>
        <button type="button" className="fk-sb-nav-item" aria-pressed={view === "local"} onClick={() => onView("local")}>
          <LocalChangesGlyph />
          <span className="fk-sb-nav-label">Local Changes{localCount > 0 ? ` (${localCount})` : ""}</span>
        </button>
        <button type="button" className="fk-sb-nav-item" aria-pressed={view === "all"} onClick={() => onView("all")}>
          <AllCommitsGlyph />
          <span className="fk-sb-nav-label">All Commits</span>
        </button>
      </div>
      <div className="fk-sb-filter">
        <LensGlyph />
        <input
          ref={filterRef} className="fk-sb-filter-input" type="text" placeholder="Filter" aria-label="Filter branches, tags and more"
          aria-controls={`${uid}-tree`} spellCheck={false} autoComplete="off" value={query}
          onChange={e => setQuery(e.target.value)} onKeyDown={onFilterKey}
        />
      </div>
      <RefsNote refs={refs} onRetry={refs.retry} />
      <div className="fk-sb-body" id={`${uid}-tree`}>
        <FkSidebarTree
          rows={rows} selKey={selKey} stopKey={stopKey} label={name ? `${name}: branches, tags and more` : "Branches, tags and more"}
          onCursor={setSelKey} onToggle={setRowOpen} onJump={row => row.sha && onJump(row.sha)} onMenu={rowMenu} onType={onType}
          focusSeq={focusSeq} filtering={query.trim() !== ""}
        />
      </div>
      <span className="vis-hidden" role="status" aria-live="polite">{said}</span>
      {menu && <SbMenu menu={menu} onClose={closeMenu} />}
    </div>
  );
}
