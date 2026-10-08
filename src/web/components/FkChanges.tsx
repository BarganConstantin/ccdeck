import React, { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { failureLasts, failureLine } from "../git-diff-parse";
import { commitRows, fileKey, uncommittedList, type CardNamer, type CommitFile, type FileRow, type StatusEntry } from "../git-files-model";
import { fileOrder, type FkTreeFile } from "../git-fork-tree";
import type { DiffResult, Edit, GitFileRef, GraphFocus } from "../git-view-types";
import { splitterMove } from "../git-view-keys";
import { isEscapeKey } from "../modal-dismiss";
import { clampTo, splitterTarget } from "../git-view-sizes";
import { sessionHue } from "../session-hue";
import { readStored, writeStored } from "../storage";
import FkCommitStrip, { type StripCommit } from "./FkCommitStrip";
import FkFileTree, { type FkFileTreeHandle } from "./FkFileTree";
import GitDiff, { type GitDiffHandle } from "./GitDiff";

export interface FkChangesProps {
  /** A commit's files (the Changes tab) or the working tree (Local Changes). */
  mode: "commit" | "local";
  entries: StatusEntry[] | CommitFile[];
  /** The files the session's agents edited, from /api/git/edits. */
  edits: Edit[];
  focus: GraphFocus;
  selected: GitFileRef | null;
  onSelect: (f: GitFileRef) => void;
  /** Enter or → on a file, or a double click: the diff takes the keyboard. */
  onOpen: (f: GitFileRef) => void;
  /** Sharp collisions: a file the focused agent edited that another live
   *  agent also edited since it was last committed. */
  collisions: { path: string; with: string }[];
  /** The file the diff is of, and the diff. */
  file: GitFileRef | null;
  diff: DiffResult | null;
  loading: boolean;
  stale: boolean;
  onShowLatest: () => void;
  wrap: boolean;
  onToggleWrap: () => void;
  /** Commit mode: the commit, for the strip over the tree and the diff. */
  commit?: StripCommit | null;
  /** Commit mode: its files are still being read, or the read failed and why. */
  reading?: "loading" | { error: string } | null;
  onRetryFiles?: () => void;
  /** What the focused card is called, and how the session's agents are. */
  name?: string;
  cardName?: CardNamer;
  /** The diff's read failed, or git no longer lists the change. */
  error?: string | null;
  gone?: boolean;
  onRetry?: () => void;
  diffKey?: string;
  onReload?: () => void;
  editorFor?: { sessionId: string; agentId: string | null } | null;
  emptyReason?: "clean" | "unselected";
  /** The tree's width in px, remembered by the caller; the default fits the
   *  pane (Fork's 21.5% of the inspector, 25% for Local Changes). */
  treeW?: number;
  onTreeW?: (px: number) => void;
}

/** What the inspector does from outside: give the tree or the diff the keyboard. */
export interface FkChangesHandle {
  focusTree(): void;
  focusDiff(): void;
}

/** The tree's bounds and its share of the pane by default, per mode. Fork's
 *  21.5% is of a whole window; beside the canvas the pane is half that, so a
 *  commit's tree keeps at least 240px — a file two folders deep still reads. */
const TREE = {
  commit: { min: 240, max: 420, share: 0.215 },
  local: { min: 260, max: 480, share: 0.25 },
} as const;
/** The least a diff keeps beside the tree. */
const DIFF_MIN = 240;
/** The least each side of Local Changes keeps: its header and two rows. */
const GROUP_MIN = 75;
/** The Unstaged side's share of the column, by default. */
const UNSTAGED_SHARE = 0.55;

/** The trees' sizes as the reader left them, in this browser: the tree's
 *  width in each mode (px), and Unstaged's share of Local Changes' column. */
interface FkTreeSizes { commit?: number; local?: number; unstaged?: number }
export const TREE_SIZES_KEY = "agent-dag.gitForkTrees";

export function parseTreeSizes(raw: string | null): FkTreeSizes {
  let o: Record<string, unknown> = {};
  try { const v = raw ? JSON.parse(raw) : null; if (v && typeof v === "object") o = v as Record<string, unknown>; } catch { /* a broken store is a default */ }
  const px = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 100 && v <= 2000 ? Math.round(v) : undefined);
  const share = typeof o.unstaged === "number" && o.unstaged > 0 && o.unstaged < 1 ? o.unstaged : undefined;
  return { commit: px(o.commit), local: px(o.local), unstaged: share };
}
const readTreeSizes = (): FkTreeSizes => parseTreeSizes(readStored(TREE_SIZES_KEY));
const writeTreeSizes = (s: FkTreeSizes): void => writeStored(TREE_SIZES_KEY, JSON.stringify(s));

const toRef = (f: { path: string; area: string; from?: string }): GitFileRef =>
  (f.from !== undefined ? { path: f.path, area: f.area, from: f.from } : { path: f.path, area: f.area });

function treeFile(r: FileRow): FkTreeFile {
  return {
    key: r.key, path: r.path, area: r.area, ...(r.from !== undefined ? { from: r.from } : {}), change: r.change,
    directory: r.directory, marked: r.marked, sub: r.sub, other: r.other, clash: r.clash, editors: r.editors,
  };
}

/**
 * The Fork look's Changes tab, and its Local Changes view: a filter and the
 * changed files as a folder tree on the left, the path bar and the diff on
 * the right, the two lined up on one band. A commit's files are one tree
 * under the commit's strip; the working tree is two — Unstaged (with the
 * untracked and the conflicted) and Staged, a file in both listed in both, as
 * git has it. There is no Stage, Unstage or Discard: the deck only reads.
 *
 * In Local Changes a file the focused agent edited carries its swatch (and
 * `↳ name` for a subagent) at the row's end, a funnel narrows both trees to
 * those files, and a sharp collision keeps its mark.
 */
const FkChanges = forwardRef<FkChangesHandle, FkChangesProps>(function FkChanges(props, ref) {
  const { mode, entries, edits, focus, selected, onSelect, onOpen, collisions, name, cardName } = props;
  const local = mode === "local";
  const [filter, setFilter] = useState("");
  const [onlyMine, setOnlyMine] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const sideRef = useRef<HTMLDivElement>(null);
  const treeRefs = useRef<Array<FkFileTreeHandle | null>>([]);
  const diffRef = useRef<GitDiffHandle>(null);

  // The focus and the collisions arrive as fresh objects on every render;
  // what they say is what the trees depend on.
  const focusKey = `${focus.sessionId}\0${focus.agentIds?.join("\0") ?? "*"}`;
  const clashKey = collisions.map(c => `${c.path}\0${c.with}`).join("\n");
  const groups = useMemo<FkTreeFile[][]>(() => {
    if (!local) return [commitRows(entries as CommitFile[]).map(treeFile)];
    const list = uncommittedList(entries as StatusEntry[], edits, focus, collisions, name, cardName);
    // The agent's own files stay as easy to find as in the deck look, where
    // they come first: here every other file is drawn quieter.
    const some = list.mine.length > 0;
    const all = [...list.mine, ...list.other].map(r => ({ ...treeFile(r), quiet: some && !r.marked }));
    return [all.filter(f => f.area !== "staged"), all.filter(f => f.area === "staged")];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, local, edits, focusKey, clashKey, name, cardName]);
  const anyMine = local && groups.some(g => g.some(f => f.marked));
  const narrowed = anyMine && onlyMine;
  const shownGroups = useMemo(() => (narrowed ? groups.map(g => g.filter(f => f.marked)) : groups), [groups, narrowed]);

  // ▲ ▼ step through every file the trees list, in their order.
  const order = useMemo(() => shownGroups.flatMap(g => fileOrder(g, filter)), [shownGroups, filter]);
  const selKey = selected ? fileKey(selected) : null;
  const at = selKey ? order.findIndex(f => f.key === selKey) : -1;
  const step = (to: FkTreeFile | undefined) => (to ? () => onSelect(toRef(to)) : undefined);
  const onPrev = at > 0 ? step(order[at - 1]) : undefined;
  const onNext = at < 0 ? step(order[0]) : step(order[at + 1]);

  const open = useCallback((f: GitFileRef) => {
    diffRef.current?.focus();
    onOpen(f);
  }, [onOpen]);

  // Esc clears a filter that holds text and stays in it, as the sidebar's
  // filter does; an empty filter's Esc goes on to the view, one layer back.
  const onFilterKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (isEscapeKey(e.key) && filter) { e.preventDefault(); e.stopPropagation(); setFilter(""); }
  };

  useImperativeHandle(ref, () => ({
    focusTree() {
      const i = selKey ? Math.max(0, shownGroups.findIndex(g => g.some(f => f.key === selKey))) : 0;
      treeRefs.current[i]?.focus();
    },
    focusDiff() { diffRef.current?.focus(); },
  }), [selKey, shownGroups]);

  // ── the tree's width, and Local Changes' split between its two trees ──
  // The body's width (the tree's bounds) and the tree column's height (the
  // split between Unstaged and Staged): the column is the body's height
  // beside the diff, and less over it in a narrow pane.
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = bodyRef.current, side = sideRef.current;
    if (!el || !side || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setBox(b => (b.w === el.clientWidth && b.h === side.clientHeight ? b : { w: el.clientWidth, h: side.clientHeight })));
    ro.observe(el);
    ro.observe(side);
    return () => ro.disconnect();
  }, []);
  const t = TREE[mode];
  const treeBounds = { min: t.min, max: Math.max(t.min, Math.min(t.max, box.w - DIFF_MIN)) };
  const treeDefault = clampTo(Math.round(box.w * t.share), treeBounds);
  const [sizes, setSizes] = useState<FkTreeSizes>(readTreeSizes);
  const saveSizes = (next: FkTreeSizes) => { setSizes(next); writeTreeSizes(next); };
  const treeW = clampTo(props.treeW ?? sizes[mode] ?? treeDefault, treeBounds);
  const setTreeW = (px: number) => { saveSizes({ ...sizes, [mode]: Math.round(px) }); props.onTreeW?.(px); };
  // The Unstaged side's share of the column below the band.
  const upShare = sizes.unstaged ?? UNSTAGED_SHARE;
  const sideH = Math.max(0, box.h - BAND_PX);
  const upBounds = { min: GROUP_MIN, max: Math.max(GROUP_MIN, sideH - GROUP_MIN - SPLIT_PX) };
  const upH = clampTo(Math.round(sideH * upShare), upBounds);

  const hue = sessionHue(focus.sessionId);
  const diffCollision = local && props.file ? collisions.find(c => c.path === props.file!.path) ?? null : null;

  const renderTree = (files: FkTreeFile[], i: number, label: string, empty: string) => (
    <FkFileTree
      ref={el => { treeRefs.current[i] = el; }}
      files={files} selectedKey={selKey} filter={filter} label={label} emptyNote={empty}
      onSelect={f => onSelect(toRef(f))} onOpen={f => open(toRef(f))}
    />
  );

  let side: React.ReactNode;
  if (!local) {
    const r = props.reading;
    side = r === "loading" ? <p className="fkc-note is-wait" role="status">Reading the commit's files…</p>
      : r ? (
        <div className="fkc-note">
          <b>Couldn't read this commit's files.</b>
          <span>{failureLine(r.error)}</span>
          {props.onRetryFiles && !failureLasts(r.error) && <button type="button" className="btn fkc-retry" onClick={props.onRetryFiles}>Try again</button>}
        </div>
      )
        : renderTree(shownGroups[0], 0, `Files in ${props.commit ? props.commit.sha.slice(0, 7) : "this commit"}`, "No files in this commit");
  } else {
    side = (
      <>
        <div className="fkc-group" style={{ height: upH }}>
          <div className="fkc-group-head">Unstaged</div>
          {renderTree(shownGroups[0], 0, "Unstaged changes", narrowed ? "None of this agent's files" : "No changes")}
        </div>
        <Split
          orientation="horizontal" label="Resize the unstaged and staged files" className="fkc-split-h"
          size={upH} bounds={upBounds} resetTo={sideH * UNSTAGED_SHARE}
          onSize={px => saveSizes({ ...sizes, unstaged: sideH ? Math.round((px / sideH) * 1000) / 1000 : UNSTAGED_SHARE })}
        />
        <div className="fkc-group is-staged">
          <div className="fkc-group-head">Staged</div>
          {renderTree(shownGroups[1], 1, "Staged changes", narrowed ? "None of this agent's files" : "No changes")}
        </div>
      </>
    );
  }

  return (
    <div className="fkc" data-mode={mode} style={{ "--session-hue": hue } as React.CSSProperties}>
      {!local && <FkCommitStrip commit={props.commit ?? null} />}
      <div className="fkc-body" ref={bodyRef} style={{ "--fkc-tree-w": `${treeW}px` } as React.CSSProperties}>
        <div className="fkc-side" ref={sideRef}>
          <div className="fkc-band">
            <label className="fkc-filter">
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><circle cx="5" cy="5" r="3.6" /><path d="m7.7 7.7 3 3" /></svg>
              <input type="search" className="fkc-filter-input" placeholder="Filter" aria-label="Filter the files" value={filter}
                onChange={e => setFilter(e.target.value)} onKeyDown={onFilterKey} />
            </label>
            {anyMine && (
              <button type="button" className="fkc-funnel" aria-pressed={onlyMine} onClick={() => setOnlyMine(v => !v)}
                title={onlyMine ? "Show every changed file" : "Show only the files this agent edited (from its edit tools)"}
                aria-label="Only this agent's files">
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false"><path d="M2 3h10L8.2 7.6v3.6L5.8 12V7.6z" /></svg>
              </button>
            )}
          </div>
          {side}
        </div>
        <Split
          orientation="vertical" label="Resize the files and the diff" className="fkc-split-v"
          size={treeW} bounds={treeBounds} resetTo={treeDefault} onSize={setTreeW}
        />
        <div className="fkc-main" data-gv-pane="diff" tabIndex={-1}>
          <GitDiff
            ref={diffRef} look="fork"
            file={props.file} diff={props.diff} loading={props.loading}
            stale={props.stale} onShowLatest={props.onShowLatest}
            wrap={props.wrap} onToggleWrap={props.onToggleWrap}
            collision={diffCollision ? { with: diffCollision.with } : null}
            emptyReason={props.emptyReason} error={props.error} gone={props.gone} onRetry={props.onRetry}
            diffKey={props.diffKey} onReload={props.onReload} editorFor={props.editorFor}
            onPrevFile={onPrev} onNextFile={onNext}
          />
        </div>
      </div>
    </div>
  );
});

export default FkChanges;

/** The band over the trees (the filter) and the diff (the path bar), 18px
 *  and its 1px foot; and the band a split takes between the two trees. */
const BAND_PX = 19;
const SPLIT_PX = 1;

/**
 * A divider Fork's way: the visible line is the pane's own border, the handle
 * a 7px strip over it. Dragged, or moved with the arrows (16px), Page Up and
 * Page Down (64px), Home and End; Enter or a double click puts it back.
 */
function Split({ orientation, label, className, size, bounds, resetTo, onSize }: {
  orientation: "vertical" | "horizontal";
  label: string;
  className: string;
  size: number;
  bounds: { min: number; max: number };
  resetTo: number;
  onSize: (px: number) => void;
}) {
  const vertical = orientation === "vertical";
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const move = splitterMove(e.key, orientation);
    if (!move) return;
    e.preventDefault();
    e.stopPropagation();
    onSize(splitterTarget("files", move, size, bounds, resetTo));
  };
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const handle = e.currentTarget;
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer */ }
    const start = vertical ? e.clientX : e.clientY;
    const from = size;
    let raf = 0, last: PointerEvent | null = null;
    handle.classList.add("is-dragging");
    const apply = () => {
      raf = 0;
      if (last) onSize(clampTo(from + (vertical ? last.clientX : last.clientY) - start, bounds));
    };
    const move = (ev: PointerEvent) => { last = ev; if (!raf) raf = requestAnimationFrame(apply); };
    const up = () => {
      if (raf) { cancelAnimationFrame(raf); apply(); }
      handle.classList.remove("is-dragging");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  return (
    <div
      className={className} role="separator" tabIndex={0} aria-orientation={orientation} aria-label={label}
      aria-valuemin={Math.round(bounds.min)} aria-valuemax={Math.round(bounds.max)} aria-valuenow={Math.round(size)}
      onKeyDown={onKeyDown} onDoubleClick={() => onSize(clampTo(resetTo, bounds))} onPointerDown={onPointerDown}
    />
  );
}
