import React, { forwardRef, useCallback, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { copyText } from "../copy-text";
import { failureLasts, failureLine, groupDigits } from "../git-diff-parse";
import {
  commitRows, fileKey, rowOrder, uncommittedList,
  type CardNamer, type CommitFile, type ElsewhereRow, type FileRef, type FileRow, type GitEdit, type GraphFocus, type StatusEntry,
} from "../git-files-model";
import { shownPath } from "../git-hidden-chars";
import { fitShared, monoMeasure, nameFits, type Measure, type PathCut } from "../git-path-fit";
import { sessionHue } from "../session-hue";
import { CheckGlyph, ChevronGlyph, ClashGlyph, CopyGlyph, InfoGlyph } from "./GitDiffIcons";

export type { CommitFile, ElsewhereRow, FileRef, GitEdit, GraphFocus, StatusEntry } from "../git-files-model";

export interface GitFilesProps {
  entries: StatusEntry[] | CommitFile[];
  mode: "uncommitted" | "commit";
  /** The files the session's agents edited, from /api/git/edits. */
  edits: GitEdit[];
  focus: GraphFocus;
  selected: { path: string; area: string } | null;
  onSelect: (f: FileRef) => void;
  /** Enter or → on a row, or a double click: into the diff. */
  onOpen: (f: FileRef) => void;
  /** Sharp collisions: a file this agent edited that another live agent also
   *  edited since it was last committed. */
  collisions: { path: string; with: string }[];
  /** What the focused card is called — the session, or the subagent. */
  name?: string;
  /** Commit mode: the commit's full SHA, for its header and Copy SHA. */
  sha?: string | null;
  /** Commit mode: who made it, as the header says it ("made by api-fix"). */
  commitBy?: string;
  /** A clean working tree: the line under "Working tree clean." */
  cleanNote?: string;
  /** Names the session's agents the way their cards do, by key (null for the
   *  main thread). Kept stable by the caller: the list is worked out again
   *  when it changes. */
  cardName?: CardNamer;
  /** Uncommitted mode: the session's subagents that work in another folder,
   *  named under its own files. */
  elsewhere?: ElsewhereRow[];
  /** One of them activated (click, Enter, →): narrow the view to it. */
  onElsewhere?: (agentId: string) => void;
  /** Commit mode: its files are still being read, or the read failed and why.
   *  Either way `entries` is empty, and the list never calls the commit empty. */
  reading?: "loading" | { error: string } | null;
  /** Read the commit's files again, after a failed read. */
  onRetry?: () => void;
}

/** A stop in the list's keyboard walk: a file, or a line naming a subagent
 *  that works in another folder. */
type WalkItem = { key: string; row: FileRow; away?: undefined } | { key: string; away: ElsewhereRow; row?: undefined };

const NO_ELSEWHERE: ElsewhereRow[] = [];

/** What the view does to the list from outside: give it the keyboard. */
export interface GitFilesHandle {
  focus(): void;
}

/** Slack between the canvas's measure and the box the browser lays out, for
 *  sub-pixel rounding. */
const SLACK = 2;
/** The path's and a subagent tag's type size (`.gvf-path`, `.gvf-who`):
 *  stated rather than read off the computed style, which nothing on a render
 *  may ask for (render-path-cost-612-613.test.ts); git-files-view.test.ts
 *  holds both to the sheet. */
export const PATH_PX = 11;
export const WHO_PX = 10;
/** The widest a subagent's tag gets (`.gvf-who`, max-width). */
const WHO_MAX = 120;

const SHELL_NOTE = "Marked from the agent's edit tools (Edit, Write, MultiEdit, NotebookEdit, apply_patch). Changes made from a shell are not marked.";

/**
 * The files of the selected history row: the folder's uncommitted changes, the
 * focused agent's first, or one commit's files. A listbox with one tab stop —
 * the selected row — walked with ↑ ↓ Home End; Enter or → opens the diff.
 *
 * Paths are cut by measuring the room each row leaves them (git-path-fit.ts):
 * the file name whole, the folder cut in its middle; a subagent's tag folds to
 * `↳` before a file name is cut; a file listed twice is cut the same in both.
 */
const GitFiles = forwardRef<GitFilesHandle, GitFilesProps>(function GitFiles(props, ref) {
  const { entries, mode, edits, focus, selected, onSelect, onOpen, collisions, name, sha, commitBy, cleanNote, cardName, onElsewhere, reading, onRetry } = props;
  const elsewhere = mode === "uncommitted" ? props.elsewhere ?? NO_ELSEWHERE : NO_ELSEWHERE;
  const listRef = useRef<HTMLDivElement>(null);
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  const groupId = useId();

  // The focus and the collisions arrive as fresh objects on every render of
  // the view; what they say is what the list depends on.
  const focusKey = `${focus.sessionId}\0${focus.agentIds?.join("\0") ?? "*"}`;
  const clashKey = collisions.map(c => `${c.path}\0${c.with}`).join("\n");
  const list = useMemo(
    () => (mode === "commit" ? commitRows(entries as CommitFile[]) : uncommittedList(entries as StatusEntry[], edits, focus, collisions, name, cardName)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, mode, edits, focusKey, clashKey, name, cardName],
  );
  const rows = useMemo(() => rowOrder(list), [list]);
  // The keyboard walks the files and, between the agent's own and the rest,
  // the lines naming its subagents elsewhere.
  const walk = useMemo<WalkItem[]>(() => {
    const item = (row: FileRow): WalkItem => ({ key: row.key, row });
    if (Array.isArray(list)) return list.map(item);
    return [...list.mine.map(item), ...elsewhere.map(away => ({ key: away.key, away })), ...list.other.map(item)];
  }, [list, elsewhere]);
  const counted = !Array.isArray(list) && list.counted;
  const selectedKey = selected ? fileKey(selected) : null;
  const tabKey = rows.some(r => r.key === selectedKey) ? selectedKey : (rows[0] ?? walk[0])?.key ?? null;

  const [cuts, setCuts] = useState<Map<string, PathCut>>(new Map());
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(Math.round(el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [rows.length === 0]);

  // Measure what each row leaves its path, then cut. The path is the one part
  // of a row that shrinks, so its box is the room left — and that box does not
  // depend on the text in it, so one pass settles.
  useLayoutEffect(() => {
    if (!rows.length) return;
    const measure: Measure = monoMeasure(PATH_PX);
    const whoMeasure: Measure = monoMeasure(WHO_PX);
    const nextFolded = new Set<string>();
    const rooms: Array<{ key: string; path: string; room: number }> = [];
    for (const row of rows) {
      const el = rowEls.current.get(row.key);
      const box = el?.querySelector<HTMLElement>(".gvf-path");
      if (!el || !box) continue;
      // A folder's trailing slash is drawn after the path, out of its room.
      let room = box.getBoundingClientRect().width - SLACK - (row.directory ? measure("/") : 0);
      const nameEl = row.sub ? el.querySelector<HTMLElement>(".gvf-who-name") : null;
      // A tag the sheet already folded (a narrow panel) has nothing to give.
      if (nameEl && (folded.has(row.key) || nameEl.offsetWidth > 0)) {
        const nameW = Math.min(whoMeasure(` ${row.sub}`), WHO_MAX - whoMeasure("↳"));
        const withName = folded.has(row.key) ? room - nameW : room;
        if (!nameFits(shownPath(row.path), withName, measure)) { nextFolded.add(row.key); room = withName + nameW; }
        else room = withName;
      }
      rooms.push({ key: row.key, path: shownPath(row.path), room });
    }
    const next = fitShared(rooms, measure);
    setCuts(prev => (sameCuts(prev, next) ? prev : next));
    setFolded(prev => (sameSet(prev, nextFolded) ? prev : nextFolded));
    // `folded` is read, not watched: it is this pass's own output.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, width]);

  // The selected row stays in view when the selection moves from outside
  // (the view opens on a file far down the list), without taking focus.
  useLayoutEffect(() => {
    const list = listRef.current;
    const row = selectedKey ? rowEls.current.get(selectedKey) : null;
    if (!list || !row) return;
    const l = list.getBoundingClientRect(), r = row.getBoundingClientRect();
    if (r.top < l.top) list.scrollTop -= l.top - r.top;
    else if (r.bottom > l.bottom) list.scrollTop += r.bottom - l.bottom;
  }, [selectedKey, rows]);

  useImperativeHandle(ref, () => ({
    focus() {
      const key = tabKey;
      (key ? rowEls.current.get(key) : null)?.focus();
    },
  }), [tabKey]);

  const move = useCallback((to: WalkItem | undefined) => {
    if (!to) return;
    // A line naming a subagent elsewhere takes the keyboard and leaves the
    // selected file — and its diff — as they are.
    if (to.away) { rowEls.current.get(to.key)?.focus(); return; }
    onSelect(refOf(to.row));
    rowEls.current.get(to.key)?.focus();
  }, [onSelect]);

  /** Enter, → or a click: a file opens its diff, a subagent's line narrows
   *  the view to it when its folder has a repository to show. */
  const activate = (item: WalkItem | undefined) => {
    if (!item) return;
    if (item.away) { if (item.away.opens) onElsewhere?.(item.away.agentId); return; }
    onOpen(refOf(item.row));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const at = (e.target as HTMLElement).closest<HTMLElement>("[data-file]")?.dataset.file;
    const i = walk.findIndex(r => r.key === at);
    if (i < 0) return;
    let handled = true;
    switch (e.key) {
      case "ArrowDown": move(walk[i + 1]); break;
      case "ArrowUp": move(walk[i - 1]); break;
      case "Home": move(walk[0]); break;
      case "End": move(walk[walk.length - 1]); break;
      case "Enter":
      case "ArrowRight": activate(walk[i]); break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  const renderRow = (row: FileRow) => {
    const sel = row.key === selectedKey;
    const cut = cuts.get(row.key);
    // Drawn with any hidden character as its code point; read and copied as it is.
    const shown = shownPath(row.path);
    const dir = cut ? cut.dir : shown.slice(0, shown.lastIndexOf("/") + 1);
    const base = cut ? cut.base : shown.slice(shown.lastIndexOf("/") + 1);
    return (
      <div
        key={row.key}
        ref={el => { if (el) rowEls.current.set(row.key, el); else rowEls.current.delete(row.key); }}
        role="option"
        aria-selected={sel}
        tabIndex={row.key === tabKey ? 0 : -1}
        data-file={row.key}
        className={`gvf-row${sel ? " is-sel" : ""}${row.marked || mode === "commit" ? "" : " is-quiet"}${folded.has(row.key) ? " is-folded" : ""}`}
        title={tooltip(row)}
        onClick={() => { if (!sel) onSelect(refOf(row)); }}
        onDoubleClick={() => onOpen(refOf(row))}
      >
        <i className={row.marked ? "gvf-pip" : "gvf-pip is-none"} aria-hidden="true" />
        <span className="gvf-st" data-st={row.letter}>
          <span aria-hidden="true">{row.letter}</span>
          <span className="vis-hidden">{row.word} </span>
        </span>
        <span className="vis-hidden">{row.path}</span>
        <span className="gvf-path" data-change={row.change} aria-hidden="true">
          <span className="gvf-dir">{dir}</span><span className="gvf-base">{base}</span>
          {row.directory && <span className="gvf-dir">/</span>}
        </span>
        {row.clash && (
          <span className="gvf-clash" role="img" aria-label={`also edited by ${row.clash}`} title={`${row.clash} edited this file too, since it was last committed`}>
            <ClashGlyph />
          </span>
        )}
        {row.sub && (
          <span className="gvf-who" title={`edited by ${row.sub}`}>
            <span aria-hidden="true">↳<span className="gvf-who-name"> {row.sub}</span></span>
            <span className="vis-hidden">, edited by {row.sub}</span>
          </span>
        )}
        {row.other && (
          <span className="gvf-who is-other" title={`${row.other} edited this`}>
            <span aria-hidden="true">{row.other}</span>
            <span className="vis-hidden">, edited by {row.other}</span>
          </span>
        )}
        {row.stage && (
          <span className="gvf-stage" data-stage={row.stage} title={row.stage}>
            <span className="gvf-stage-long" aria-hidden="true">{row.stage}</span>
            <span className="gvf-stage-short" aria-hidden="true">{row.stage === "staged" ? "S" : "U"}</span>
            <span className="vis-hidden">, {row.stage}</span>
          </span>
        )}
        {row.collapsed && (
          <span className="gvf-collapsed" title={row.collapsed === "lock" ? "Lock file: its diff starts collapsed" : "Generated file: its diff starts collapsed"}>
            <ChevronGlyph />
            <span className="vis-hidden">, {row.collapsed === "lock" ? "lock file" : "generated file"}</span>
          </span>
        )}
        {row.counts ? <Counts {...row.counts} /> : counted && <span className="gvf-counts" />}
      </div>
    );
  };

  const renderAway = (away: ElsewhereRow) => {
    const item: WalkItem = { key: away.key, away };
    return (
      <div
        key={away.key}
        ref={el => { if (el) rowEls.current.set(away.key, el); else rowEls.current.delete(away.key); }}
        role="option"
        aria-selected={false}
        aria-disabled={away.opens ? undefined : true}
        aria-label={away.said}
        tabIndex={away.key === tabKey ? 0 : -1}
        data-file={away.key}
        className="gvf-elsewhere"
        title={away.title}
        onClick={() => activate(item)}
      >
        <span className="gvf-elsewhere-arrow" aria-hidden="true">↳</span>
        {/* "works" folds away in a narrow pane before the folder's name is cut. */}
        <span className="gvf-elsewhere-lead">{away.name}<span className="gvf-elsewhere-verb"> works</span> in {away.folderName}</span>
        {(away.tail || away.opens) && (
          <span className="gvf-elsewhere-tail">
            {away.tail && <span>{away.tail}</span>}
            {away.opens && <span className="gvf-elsewhere-go" aria-hidden="true">›</span>}
          </span>
        )}
      </div>
    );
  };

  const head = mode === "commit" ? (
    <CommitHead sha={sha ?? null} count={reading ? null : rows.length} by={commitBy} />
  ) : (
    <div className="gvf-head">
      <span className="gvf-title">Uncommitted</span>
      <span className="gvf-count">{groupDigits((list as ReturnType<typeof uncommittedList>).files)}</span>
    </div>
  );

  if (!rows.length) {
    return (
      <div className="gvf" data-mode={mode}>
        {head}
        <div className="gvf-empty" role={reading === "loading" ? "status" : undefined}>
          {mode === "commit" && reading === "loading" ? <span>Reading the commit's files…</span>
            : mode === "commit" && reading && reading !== "loading" ? (
              <>
                <b>Couldn't read this commit's files.</b>
                <span>{failureLine(reading.error)}</span>
                {onRetry && !failureLasts(reading.error) && <button type="button" className="btn gvf-retry" onClick={onRetry}>Try again</button>}
              </>
            )
            : mode === "commit"
              ? <><b>No files in this commit.</b><span>It changes nothing in the tree, like an empty or merge-only commit.</span></>
              : <><b>Working tree clean.</b><span>{cleanNote ?? "Nothing to commit."}</span></>}
        </div>
        {/* A teammate in another folder is named even when this one is clean. */}
        {elsewhere.length > 0 && (
          <div ref={listRef} className="gvf-list is-elsewhere" role="listbox" aria-label="Subagents working in another folder" data-pane="files" onKeyDown={onKeyDown}>
            {elsewhere.map(renderAway)}
          </div>
        )}
      </div>
    );
  }

  const listLabel = mode === "commit" ? `Files in ${sha ? sha.slice(0, 7) : "this commit"}` : "Uncommitted files";
  let body: React.ReactNode;
  if (mode === "commit") {
    body = rows.map(renderRow);
  } else {
    const { mine, other, label } = list as ReturnType<typeof uncommittedList>;
    body = (
      <>
        {mine.length > 0 && (
          <div role="group" aria-labelledby={`${groupId}-mine`}>
            <div role="presentation" id={`${groupId}-mine`} className="gvf-group" title={label}>
              <i className="gvf-swatch" aria-hidden="true" />
              <span className="gvf-group-name">{label}</span>
              <span className="gvf-hint" title={SHELL_NOTE}>
                <InfoGlyph /><span>from its edits</span>
              </span>
            </div>
            {mine.map(renderRow)}
          </div>
        )}
        {elsewhere.map(renderAway)}
        {other.length > 0 && (
          <div role="group" aria-labelledby={`${groupId}-other`}>
            <div role="presentation" id={`${groupId}-other`} className="gvf-group is-quiet">
              <span className="gvf-group-name">{mine.length ? "Other changes in this folder" : "Changes in this folder"}</span>
            </div>
            {other.map(renderRow)}
          </div>
        )}
      </>
    );
  }

  return (
    <div className="gvf" data-mode={mode} style={{ "--session-hue": sessionHue(focus.sessionId) } as React.CSSProperties}>
      {head}
      <div ref={listRef} className="gvf-list" role="listbox" aria-label={listLabel} data-pane="files" onKeyDown={onKeyDown}>
        {body}
      </div>
    </div>
  );
});

export default GitFiles;

function refOf(row: FileRow): FileRef {
  return row.from !== undefined ? { path: row.path, area: row.area, from: row.from } : { path: row.path, area: row.area };
}

function tooltip(row: FileRow): string {
  const lines = [row.path];
  if (row.from) lines.push(`${row.change === "copied" ? "copied" : "renamed"} from ${row.from}`);
  if (row.directory) lines.push("a new folder: git lists it as one entry until something in it is added");
  if (row.editors.length) lines.push(`edited by ${row.editors.join(" and ")} (from its edit tools)`);
  if (row.clash) lines.push(`${row.clash} edited this file too, since it was last committed`);
  if (row.collapsed) lines.push(row.collapsed === "lock" ? "lock file: its diff starts collapsed" : "generated file: its diff starts collapsed");
  return lines.join("\n");
}

function Counts({ added, removed, binary }: { added: number; removed: number; binary: boolean }) {
  if (binary) return <span className="gvf-counts"><span className="gvf-bin" title="binary file"><span aria-hidden="true">bin</span><span className="vis-hidden">binary file</span></span></span>;
  return (
    <span className="gvf-counts">
      {added > 0 && <span className="gvf-add">+{groupDigits(added)}<span className="vis-hidden"> added</span></span>}
      {removed > 0 && <span className="gvf-del">−{groupDigits(removed)}<span className="vis-hidden"> removed</span></span>}
    </span>
  );
}

function CommitHead({ sha, count, by }: { sha: string | null; count: number | null; by?: string }) {
  const [copied, setCopied] = useState(false);
  const short = sha ? sha.slice(0, 7) : "";
  const copy = async () => {
    if (!sha) return;
    if (await copyText(sha)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <div className="gvf-head">
      <span className="gvf-title gvf-sha">{short}</span>
      {count !== null && <span className="gvf-count">{groupDigits(count)}</span>}
      {by && <span className="gvf-sub" title={by}>{by}</span>}
      {sha && (
        <button type="button" className="glyph-btn gvf-copy" onClick={copy} title={`Copy ${sha}`} aria-label={`Copy commit SHA ${short}`}>
          {copied ? <CheckGlyph /> : <CopyGlyph />}
          <span>{copied ? "Copied" : "Copy SHA"}</span>
        </button>
      )}
      <span className="vis-hidden" aria-live="polite">{copied ? "Commit SHA copied" : ""}</span>
    </div>
  );
}

function sameCuts(a: Map<string, PathCut>, b: Map<string, PathCut>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of b) {
    const w = a.get(k);
    if (!w || w.dir !== v.dir || w.base !== v.base) return false;
  }
  return true;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const k of b) if (!a.has(k)) return false;
  return true;
}
