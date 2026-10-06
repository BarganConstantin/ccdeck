// Stand-ins for the git view's panes, with the props the real parts take, so
// the view can be opened, walked from the keyboard and measured before those
// parts are in. Each is a plain list of what its part will draw. GitView.tsx
// swaps each one for its part as it lands; the history's (GitGraph) has.
import { useEffect, useRef, type KeyboardEvent } from "react";

import type { CommitFile, DiffResult, Edit, GitFileRef, GraphFocus, StatusEntry } from "../git-view-types";

/** ↑ ↓ Home End move a listbox's selection; the list answers them itself. */
function listMove(e: KeyboardEvent, ids: string[], selected: string | null, pick: (id: string) => void): boolean {
  const at = selected == null ? -1 : ids.indexOf(selected);
  let next = -1;
  if (e.key === "ArrowDown") next = Math.min(ids.length - 1, at + 1);
  else if (e.key === "ArrowUp") next = Math.max(0, at - 1);
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = ids.length - 1;
  else return false;
  e.preventDefault();
  if (next >= 0 && ids[next] !== selected) pick(ids[next]);
  return true;
}

/** Keeps keyboard focus on the selected row when the selection moves under it. */
function useFollowFocus(listRef: React.RefObject<HTMLElement>, key: string | null) {
  useEffect(() => {
    const list = listRef.current;
    if (!list || !list.contains(document.activeElement)) return;
    const row = list.querySelector<HTMLElement>('[aria-selected="true"]');
    if (row && row !== document.activeElement) { row.focus({ preventScroll: true }); row.scrollIntoView?.({ block: "nearest" }); }
  }, [key]);
}

export function GitFilesStandIn({ entries, selected, onSelect, onOpen }: {
  entries: StatusEntry[] | CommitFile[];
  mode: "uncommitted" | "commit";
  edits: Edit[];
  focus: GraphFocus;
  selected: GitFileRef | null;
  onSelect: (f: GitFileRef) => void;
  onOpen: (f: GitFileRef) => void;
  collisions: { path: string; with: string }[];
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const refs: GitFileRef[] = entries.map(e => ({ path: e.path, area: "area" in e ? e.area : "commit", ...(e.from ? { from: e.from } : {}) }));
  const id = (f: GitFileRef) => `${f.area}:${f.path}`;
  const selId = selected ? id(selected) : null;
  useFollowFocus(listRef, selId);
  if (!refs.length) return null;
  return (
    <div
      ref={listRef} className="gv-pane-list" role="listbox" aria-label="Files"
      onKeyDown={e => {
        if (listMove(e, refs.map(id), selId, k => onSelect(refs.find(f => id(f) === k)!))) return;
        if (e.key === "Enter" && selected) { e.preventDefault(); onOpen(selected); }
      }}
    >
      {refs.map(f => (
        <div
          key={id(f)} className="gv-stand-row" role="option" data-file={f.path} aria-selected={id(f) === selId}
          tabIndex={id(f) === selId || (selId == null && f === refs[0]) ? 0 : -1} onClick={() => onSelect(f)}
        >
          <span title={f.path}>{f.path}</span><span className="gv-mono">{f.area}</span>
        </div>
      ))}
    </div>
  );
}

export function GitDiffStandIn({ file, diff, loading, stale, onShowLatest }: {
  file: GitFileRef | null;
  diff: DiffResult | null;
  loading: boolean;
  stale: boolean;
  onShowLatest: () => void;
  wrap: boolean;
  onToggleWrap: () => void;
  collision: { with: string } | null;
}) {
  return (
    <>
      <div className="gv-pane-head">
        <span className="gv-pane-title">{file ? <span className="gv-mono" title={file.path}>{file.path}</span> : "Diff"}</span>
        {stale && <button type="button" className="btn" onClick={onShowLatest}>Show latest <kbd>n</kbd></button>}
      </div>
      {!file ? <div className="gv-pane-empty"><b>No file selected.</b><span>Pick a file on the left.</span></div>
        : (
          <div className="gv-pane-list" role="region" tabIndex={-1} aria-label={`Diff of ${file.path}`} data-diff-scroll="">
            {loading || !diff ? null
              : "patch" in diff ? <pre className="gv-mono">{diff.patch}</pre>
              : <div className="gv-pane-empty"><b>{"binary" in diff ? "Binary file, not shown." : "tooLarge" in diff ? "Too large to show." : "A folder."}</b></div>}
          </div>
        )}
    </>
  );
}

