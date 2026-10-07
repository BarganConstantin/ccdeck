import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { foldersOf, treeRows, type FkTreeFile, type FkTreeRow } from "../git-fork-tree";
import FkFileTypeLabel, { FkFolderIcon } from "./FkFileTypeLabel";
import FkStatusBadge from "./FkStatusBadge";
import { ClashGlyph } from "./GitDiffIcons";

export type { FkTreeFile } from "../git-fork-tree";

export interface FkFileTreeProps {
  files: FkTreeFile[];
  selectedKey: string | null;
  /** A file chosen: by a click, or by the keys moving onto it. */
  onSelect: (f: FkTreeFile) => void;
  /** Enter or → on a file, or a double click: into the diff. */
  onOpen: (f: FkTreeFile) => void;
  /** The tree's accessible name. */
  label: string;
  /** The band's filter: a case-insensitive substring of the path. */
  filter?: string;
  /** What an empty tree says. */
  emptyNote?: string;
  /** The row height, in px: 22 in the Changes tab. */
  rowH?: number;
}

/** What the inspector does to the tree from outside: give it the keyboard. */
export interface FkFileTreeHandle {
  focus(): void;
}

/** Rows drawn beyond the ones on screen, each side. */
const OVERSCAN = 8;
/** Rows drawn before the tree knows its own height. */
const FIRST_ROWS = 40;

/**
 * A commit's files, or one side of the working tree, as Fork's folder tree:
 * twisty, status square or folder, the file's kind, its name; every level
 * 16px deeper. Only the rows near the screen are drawn, so a commit of
 * thousands of files scrolls as one of ten.
 *
 * One tab stop — the row the keys are on — walked with ↑ ↓ Home End Page Up
 * Page Down; → opens a folder or steps into it, and on a file opens its diff;
 * ← shuts a folder or steps out to the one above. The keys choose files as
 * they move, as Fork's do. Nothing here stages, discards or writes.
 */
const FkFileTree = forwardRef<FkFileTreeHandle, FkFileTreeProps>(function FkFileTree(props, ref) {
  const { files, selectedKey, onSelect, onOpen, label, filter = "", emptyNote = "No changes", rowH = 22 } = props;
  const boxRef = useRef<HTMLDivElement>(null);
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [scroll, setScroll] = useState({ top: 0, h: 0 });
  const [cursor, setCursor] = useState<string | null>(null);
  // A move made from the keys: the row it lands on takes focus once drawn.
  const focusNext = useRef<string | null>(null);
  // Fork greys the selection when the window loses focus, not only the tree.
  const [blurred, setBlurred] = useState(false);

  const rows = useMemo(() => treeRows(files, closed, filter), [files, closed, filter]);
  const index = useMemo(() => new Map(rows.map((r, i) => [r.key, i])), [rows]);
  const tabKey = cursor !== null && index.has(cursor) ? cursor
    : selectedKey !== null && index.has(selectedKey) ? selectedKey
      : rows[0]?.key ?? null;

  useEffect(() => {
    const off = () => setBlurred(true);
    const on = () => setBlurred(false);
    window.addEventListener("blur", off);
    window.addEventListener("focus", on);
    return () => { window.removeEventListener("blur", off); window.removeEventListener("focus", on); };
  }, []);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setScroll(s => (s.h === el.clientHeight ? s : { top: el.scrollTop, h: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, [rows.length === 0]);

  /** Scroll so the row at `i` is on screen, nearest edge. */
  const reveal = useCallback((i: number) => {
    const el = boxRef.current;
    if (!el || i < 0) return;
    const top = i * rowH, bottom = top + rowH;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    setScroll({ top: el.scrollTop, h: el.clientHeight });
  }, [rowH]);

  // A file chosen from outside (▲ ▼ in the path bar, the Commit tab's list):
  // its folders open and it scrolls into view, without taking focus.
  const lastSel = useRef<string | null>(null);
  const revealKey = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (selectedKey !== lastSel.current) {
      lastSel.current = selectedKey;
      const f = selectedKey ? files.find(x => x.key === selectedKey) : null;
      if (f) {
        const shut = foldersOf(f.path).filter(d => closed.has(d));
        if (shut.length) setClosed(c => { const n = new Set(c); for (const d of shut) n.delete(d); return n; });
        revealKey.current = f.key;
      }
    }
    // Once its folders are open, the row is there to scroll to.
    const k = revealKey.current;
    if (k !== null && index.has(k)) { revealKey.current = null; reveal(index.get(k)!); }
  }, [selectedKey, files, index]);

  useLayoutEffect(() => {
    const key = focusNext.current;
    if (!key) return;
    focusNext.current = null;
    rowEls.current.get(key)?.focus({ preventScroll: true });
  });

  useImperativeHandle(ref, () => ({
    focus() {
      const i = tabKey ? index.get(tabKey) ?? -1 : -1;
      if (i < 0) { boxRef.current?.focus(); return; }
      reveal(i);
      focusNext.current = tabKey;
      setCursor(tabKey);
    },
  }), [tabKey, index, reveal]);

  const toggle = (dir: string, open?: boolean) => setClosed(c => {
    const isOpen = !c.has(dir);
    const want = open ?? !isOpen;
    if (want === isOpen) return c;
    const n = new Set(c);
    if (want) n.delete(dir); else n.add(dir);
    return n;
  });

  /** The keys moved onto `row`: it holds the keyboard, and a file is chosen. */
  const moveTo = (row: FkTreeRow | undefined) => {
    if (!row) return;
    reveal(index.get(row.key) ?? -1);
    setCursor(row.key);
    focusNext.current = row.key;
    if (row.file && row.key !== selectedKey) onSelect(row.file);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const at = (e.target as HTMLElement).closest<HTMLElement>("[data-key]")?.dataset.key;
    const i = at ? index.get(at) ?? -1 : -1;
    if (i < 0) return;
    const row = rows[i];
    const page = Math.max(1, Math.floor((boxRef.current?.clientHeight ?? rowH * 10) / rowH) - 1);
    let handled = true;
    switch (e.key) {
      case "ArrowDown": moveTo(rows[i + 1]); break;
      case "ArrowUp": moveTo(rows[i - 1]); break;
      case "Home": moveTo(rows[0]); break;
      case "End": moveTo(rows[rows.length - 1]); break;
      case "PageDown": moveTo(rows[Math.min(rows.length - 1, i + page)]); break;
      case "PageUp": moveTo(rows[Math.max(0, i - page)]); break;
      case "ArrowRight":
        if (row.kind === "dir") { if (!row.open) toggle(row.dir!, true); else moveTo(rows[i + 1]?.depth === row.depth + 1 ? rows[i + 1] : undefined); }
        else onOpen(row.file!);
        break;
      case "ArrowLeft":
        if (row.kind === "dir" && row.open && !filter.trim()) toggle(row.dir!, false);
        else {
          for (let j = i - 1; j >= 0; j--) if (rows[j].kind === "dir" && rows[j].depth === row.depth - 1) { moveTo(rows[j]); break; }
        }
        break;
      case "Enter":
        if (row.kind === "dir") toggle(row.dir!);
        else onOpen(row.file!);
        break;
      case " ":
        if (row.kind === "dir") toggle(row.dir!);
        else handled = false;
        break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  if (!rows.length) {
    return (
      <div className="fkt is-empty">
        <p className="fkt-empty">{filter.trim() ? "No files match the filter" : emptyNote}</p>
      </div>
    );
  }

  const h = scroll.h || rowH * FIRST_ROWS;
  const start = Math.max(0, Math.floor(scroll.top / rowH) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scroll.top + h) / rowH) + OVERSCAN);
  const drawn = rows.slice(start, end).map((r, k) => [r, start + k] as const);
  // The row holding the keyboard stays drawn wherever the tree is scrolled,
  // so focus is never dropped by a row leaving the window.
  const keyAt = tabKey ? index.get(tabKey) ?? -1 : -1;
  if (keyAt >= 0 && (keyAt < start || keyAt >= end)) drawn.push([rows[keyAt], keyAt]);

  const renderRow = (row: FkTreeRow, i: number) => {
    const sel = row.kind === "file" && row.key === selectedKey;
    const f = row.file;
    return (
      <div
        key={row.key}
        ref={el => { if (el) rowEls.current.set(row.key, el); else rowEls.current.delete(row.key); }}
        role="treeitem"
        aria-level={row.depth + 1}
        aria-setsize={row.setsize}
        aria-posinset={row.posinset}
        aria-expanded={row.kind === "dir" ? row.open : undefined}
        aria-selected={row.kind === "file" ? sel : undefined}
        tabIndex={row.key === tabKey ? 0 : -1}
        data-key={row.key}
        className={`fkt-row${sel ? " is-sel" : ""}${f?.quiet ? " is-quiet" : ""}`}
        style={{ top: i * rowH, height: rowH, "--depth": row.depth } as React.CSSProperties}
        title={f ? tooltip(f) : row.dir}
        onClick={() => {
          setCursor(row.key);
          if (row.kind === "dir") toggle(row.dir!);
          else if (!sel) onSelect(f!);
        }}
        onDoubleClick={() => { if (f) onOpen(f); }}
      >
        <span className="fkt-twisty" aria-hidden="true">
          {row.kind === "dir" && (
            <svg width="8" height="5" viewBox="0 0 8 5" className={row.open ? "is-open" : undefined} focusable="false"><path d="M.9.9 4 4 7.1.9" /></svg>
          )}
        </span>
        {row.kind === "dir" ? <FkFolderIcon /> : <FkStatusBadge change={f!.change} />}
        {f && <FkFileTypeLabel path={f.path} />}
        <span className="fkt-name"><bdi>{row.name}{f?.directory ? "/" : ""}</bdi></span>
        {f && <Marks f={f} />}
      </div>
    );
  };

  return (
    <div className={`fkt${blurred ? " is-blurred" : ""}`}>
      <div
        ref={boxRef}
        className="fkt-scroll"
        role="tree"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onScroll={e => { const el = e.currentTarget; setScroll({ top: el.scrollTop, h: el.clientHeight }); }}
      >
        <div className="fkt-rows" style={{ height: rows.length * rowH }}>
          {drawn.map(([r, i]) => renderRow(r, i))}
        </div>
      </div>
    </div>
  );
});

export default FkFileTree;

/** At a row's end: the focused agent's mark (its swatch, and `↳ name` for a
 *  subagent), another agent's name, and a sharp collision's glyph. */
function Marks({ f }: { f: FkTreeFile }) {
  if (!f.marked && !f.other && !f.clash) return null;
  return (
    <span className="fkt-marks">
      {f.marked && (
        <span className="fkt-agent" title={f.sub ? `edited by ${f.sub} (from its edit tools)` : "edited by this agent (from its edit tools)"}>
          <i className="fkt-swatch" aria-hidden="true" />
          {f.sub && <span className="fkt-agent-name" aria-hidden="true">↳ {f.sub}</span>}
          <span className="vis-hidden">, edited by {f.sub ?? "this agent"}</span>
        </span>
      )}
      {f.other && (
        <span className="fkt-other" title={`${f.other} edited this`}>
          <span aria-hidden="true">{f.other}</span>
          <span className="vis-hidden">, edited by {f.other}</span>
        </span>
      )}
      {f.clash && (
        <span className="fkt-clash" role="img" aria-label={`also edited by ${f.clash}`} title={`${f.clash} edited this file too, since it was last committed`}>
          <ClashGlyph />
        </span>
      )}
    </span>
  );
}

function tooltip(f: FkTreeFile): string {
  const lines = [f.path];
  if (f.from) lines.push(`${f.change === "copied" ? "copied" : "renamed"} from ${f.from}`);
  if (f.directory) lines.push("a new folder: git lists it as one entry until something in it is added");
  if (f.editors?.length) lines.push(`edited by ${f.editors.join(" and ")} (from its edit tools)`);
  if (f.clash) lines.push(`${f.clash} edited this file too, since it was last committed`);
  return lines.join("\n");
}
