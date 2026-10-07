// Stand-ins for the Fork look's sidebar, Commit tab and Changes tab, with the
// props the real parts take, so the layout around them can be drawn and used
// before they arrive. Each one is replaced by its own module as it lands; none
// of them adds anything the deck look lacks.
import { useRef, type KeyboardEvent } from "react";

import type { CommitDetail, CommitFile, DiffResult, Edit, GitFileRef, GraphFocus, LogCommit, Repo, StatusEntry } from "../git-view-types";
import GitDiff from "./GitDiff";

export interface FkSidebarProps {
  sessionId: string;
  agent: string | null;
  repo: Repo | null;
  /** The repository's stale counter: a move reads the refs again. */
  stale: number;
  view: "all" | "local";
  onView: (v: "all" | "local") => void;
  /** How many files Local Changes lists. */
  localCount: number;
  selectedSha: string | null;
  /** A ref's tip commit: the view selects it when the history lists it. */
  onJump: (sha: string) => void;
  /** Whether focus is in the sidebar. */
  focused: boolean;
}

export interface FkCommitTabProps {
  commit: LogCommit | null;
  detail: CommitDetail | null;
  loading: boolean;
  onJump: (sha: string) => void;
  onOpenFile: (f: GitFileRef) => void;
}

export interface FkChangesProps {
  mode: "commit" | "local";
  entries: StatusEntry[] | CommitFile[];
  edits: Edit[];
  focus: GraphFocus;
  selected: GitFileRef | null;
  onSelect: (f: GitFileRef) => void;
  onOpen: () => void;
  collisions: { path: string; with: string }[];
  file: GitFileRef | null;
  diff: DiffResult | null;
  loading: boolean;
  stale: boolean;
  onShowLatest: () => void;
  wrap: boolean;
  onToggleWrap: () => void;
}

/** The sidebar's two views, and nothing else yet. */
export function FkSidebar({ repo, view, onView, localCount }: FkSidebarProps) {
  const rows: { v: "all" | "local"; label: string }[] = [
    { v: "local", label: localCount > 0 ? `Local Changes (${localCount})` : "Local Changes" },
    { v: "all", label: "All Commits" },
  ];
  return (
    <div className="fk-ph-side">
      <div className="fk-ph-repo" title={repo?.topLevel}>{repo?.name ?? ""}</div>
      {rows.map(r => (
        <button key={r.v} type="button" className="fk-ph-nav" aria-current={view === r.v ? "true" : undefined} onClick={() => onView(r.v)}>
          {r.label}
        </button>
      ))}
    </div>
  );
}

/** The selected commit's subject and files, plainly. */
export function FkCommitTab({ commit, detail, loading, onOpenFile }: FkCommitTabProps) {
  if (!commit) return <p className="fk-ph-note">Select a commit.</p>;
  return (
    <div className="fk-ph-commit">
      <p className="fk-ph-subject">{commit.subject}</p>
      <p className="fk-ph-note">{commit.author.name} · {commit.sha}</p>
      {loading && !detail ? <p className="fk-ph-note">Reading the commit…</p> : (
        <ul className="fk-ph-files">
          {(detail?.files ?? []).map(f => (
            <li key={f.path}>
              <button type="button" className="fk-ph-file" title={f.path} onClick={() => onOpenFile({ path: f.path, area: "commit", ...(f.from ? { from: f.from } : {}) })}>
                {f.path}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const refOf = (e: StatusEntry | CommitFile, mode: "commit" | "local"): GitFileRef =>
  ({ path: e.path, area: mode === "commit" ? "commit" : (e as StatusEntry).area, ...(e.from ? { from: e.from } : {}) });

/** The files as a flat list beside the deck's diff. */
export function FkChanges(p: FkChangesProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const refs = p.entries.map(e => refOf(e, p.mode));
  const at = refs.findIndex(r => p.selected != null && r.path === p.selected.path && r.area === p.selected.area);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const next = refs[Math.min(refs.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))];
    if (!next) return;
    p.onSelect(next);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus({ preventScroll: true }));
  };
  return (
    <div className="fk-ph-changes">
      <div className="fk-ph-list" role="listbox" aria-label="Changed files" data-gv-pane="files" tabIndex={-1} ref={listRef} onKeyDown={onKey}>
        {refs.length === 0 && <p className="fk-ph-note">No changes</p>}
        {refs.map((r, i) => (
          <div
            key={`${r.area}:${r.path}`} role="option" className="fk-ph-file" aria-selected={i === at} title={r.path}
            tabIndex={i === Math.max(0, at) ? 0 : -1}
            onClick={() => p.onSelect(r)} onDoubleClick={p.onOpen}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); p.onOpen(); } }}
          >
            {r.path}
          </div>
        ))}
      </div>
      <div className="fk-ph-diff" data-gv-pane="diff" tabIndex={-1}>
        <GitDiff
          file={p.file} diff={p.diff} loading={p.loading} stale={p.stale} onShowLatest={p.onShowLatest}
          wrap={p.wrap} onToggleWrap={p.onToggleWrap} collision={null}
          emptyReason={p.mode === "local" && !p.entries.length ? "clean" : "unselected"}
        />
      </div>
    </div>
  );
}
