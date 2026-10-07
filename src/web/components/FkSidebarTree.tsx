// The Fork-look sidebar's tree: sections, folders and refs as 24px rows,
// drawn only where the reader can see them, so a repository with thousands
// of branches and tags scrolls as lightly as one with ten.
//
// It is one tab stop (a roving tabindex on the cursor row, which is always
// drawn, even scrolled out of sight, so focus is never lost with it) and owns
// the tree's keys (fk-sidebar-model.ts sidebarKey). The rows carry their marks
// as glyphs and their words as text a screen reader reads: checked out, how
// far from the upstream, an upstream that is gone, a worktree holding it.
import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

import { aheadBehindWords, expandable, sidebarKey, type SbRow } from "../fk-sidebar-model";

/** One row's height, which is the whole of the tree's geometry. */
export const SB_ROW_H = 24;
/** Rows drawn past each edge of what is in sight. */
const OVERSCAN = 8;
/** Rows drawn before the scroller has been measured. */
const FIRST_ROWS = 48;

// ── glyphs (drawn here; nothing is Fork's own artwork) ───────────────────

const Svg = ({ size, view = 16, stroke = 1.75, className, children }: { size: number; view?: number; stroke?: number; className?: string; children: ReactNode }) => (
  <svg className={className} width={size} height={size} viewBox={`0 0 ${view} ${view}`} fill="none" stroke="currentColor" strokeWidth={stroke}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {children}
  </svg>
);

export const SbGlyph = {
  chevron: () => <Svg size={14} view={14} stroke={2} className="fk-sb-chev"><path d="M5.6 3.4 9.2 7l-3.6 3.6" /></Svg>,
  branch: () => (
    <Svg size={16}>
      <circle cx="4.8" cy="3.4" r="1.55" /><circle cx="11.2" cy="3.4" r="1.55" /><circle cx="4.8" cy="12.6" r="1.55" />
      <path d="M4.8 4.95v6.1M11.2 4.95v.9c0 2.6-6.4 2.3-6.4 4.9" />
    </Svg>
  ),
  check: () => <Svg size={16} stroke={2.75}><path d="M3.4 8.6 6.6 11.6 12.6 4.6" /></Svg>,
  folderOpen: () => (
    <Svg size={16} stroke={1.5}>
      <path d="M1.9 12.6V3.9c0-.5.4-.9.9-.9h3.3l1.5 1.6h4.9c.5 0 .9.4.9.9v1.3" />
      <path d="M1.9 12.6 3.7 7.3c.1-.4.5-.6.9-.6h9.2c.6 0 1 .6.8 1.1l-1.6 4.4c-.1.3-.4.4-.7.4H1.9Z" />
    </Svg>
  ),
  folder: () => (
    <Svg size={16} stroke={1.5}>
      <path d="M1.9 12.1V3.9c0-.5.4-.9.9-.9h3.3l1.5 1.6h5.6c.5 0 .9.4.9.9v6.6c0 .5-.4.9-.9.9H2.8c-.5 0-.9-.4-.9-.9Z" />
      <path d="M1.9 6.6h12.2" />
    </Svg>
  ),
  cloud: () => (
    <Svg size={16} stroke={1.5}>
      <path d="M4.6 12.4h7.2a2.9 2.9 0 0 0 .4-5.8 4.1 4.1 0 0 0-7.9-.6 3.2 3.2 0 0 0 .3 6.4Z" />
    </Svg>
  ),
  tag: () => (
    <Svg size={16} stroke={1.5}>
      <path d="M2.4 3.3v4.1c0 .3.1.5.3.7l5.6 5.6c.4.4 1 .4 1.4 0l3.8-3.8c.4-.4.4-1 0-1.4L7.9 2.9c-.2-.2-.4-.3-.7-.3H3.1c-.4 0-.7.3-.7.7Z" />
      <circle cx="5.3" cy="5.5" r=".9" />
    </Svg>
  ),
  tray: () => (
    <Svg size={16} stroke={1.5}>
      <rect x="1.9" y="2.6" width="12.2" height="3.4" rx=".8" />
      <path d="M2.9 6v6.5c0 .5.4.9.9.9h8.4c.5 0 .9-.4.9-.9V6M6.3 8.4h3.4" />
    </Svg>
  ),
  link: () => (
    <Svg size={14} view={16} stroke={1.75}>
      <path d="M6.9 9.1a2.9 2.9 0 0 0 4.1 0l2-2a2.9 2.9 0 0 0-4.1-4.1l-.9.9" />
      <path d="M9.1 6.9a2.9 2.9 0 0 0-4.1 0l-2 2a2.9 2.9 0 0 0 4.1 4.1l.9-.9" />
    </Svg>
  ),
  /** A branch held in another worktree: a folder with a branch in it. */
  held: () => (
    <Svg size={12} view={16} stroke={1.6} className="fk-sb-held">
      <path d="M1.9 12.1V3.9c0-.5.4-.9.9-.9h3.3l1.5 1.6h5.6c.5 0 .9.4.9.9v6.6c0 .5-.4.9-.9.9H2.8c-.5 0-.9-.4-.9-.9Z" />
      <path d="M6.6 7.4v3.4M9.6 7.4c0 1.6-3 1.4-3 3" />
    </Svg>
  ),
  arrowDown: () => (
    <svg className="fk-sb-arrow" width="8" height="10" viewBox="0 0 8 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M4 .9v8.2M1.2 6.3 4 9.1l2.8-2.8" />
    </svg>
  ),
  arrowUp: () => (
    <svg className="fk-sb-arrow" width="8" height="10" viewBox="0 0 8 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M4 9.1V.9M1.2 3.7 4 .9l2.8 2.8" />
    </svg>
  ),
};

/** The upstream-gone mark: a small triangle with a `!`, cut out of the row
 *  in its own surface colour, at the icon's lower right. */
const GoneMark = () => (
  <svg className="fk-sb-gone" width="9" height="9" viewBox="0 0 9 9" aria-hidden="true" focusable="false">
    <path className="fk-sb-gone-tri" d="M4.5.9 8.3 7.7H.7Z" />
    <path className="fk-sb-gone-bang" d="M4.5 3.4v2.2M4.5 6.6v.05" />
  </svg>
);

function iconOf(row: SbRow): ReactNode {
  switch (row.kind) {
    case "branch": return row.current ? <SbGlyph.check /> : <SbGlyph.branch />;
    case "remote-branch": return <SbGlyph.branch />;
    case "folder": return <SbGlyph.folderOpen />;
    case "remote": return <SbGlyph.cloud />;
    case "tag": return <SbGlyph.tag />;
    case "stash": return <SbGlyph.tray />;
    case "worktree": return row.current ? <SbGlyph.check /> : <SbGlyph.folder />;
    case "submodule": return <SbGlyph.link />;
    default: return null;
  }
}

/** Behind first, as Fork prints it: `60↓`, `3↑`, `13↓1↑`. */
function Counts({ ahead = 0, behind = 0 }: { ahead?: number; behind?: number }) {
  if (!ahead && !behind) return null;
  return (
    <span className="fk-sb-count" aria-hidden="true">
      {behind > 0 && <span>{behind}<SbGlyph.arrowDown /></span>}
      {ahead > 0 && <span>{ahead}<SbGlyph.arrowUp /></span>}
    </span>
  );
}

/** What the row's marks say, for a screen reader. */
function words(row: SbRow): string {
  const out: string[] = [];
  if (row.current) out.push(row.kind === "worktree" ? "this session's worktree" : "checked out");
  const counts = aheadBehindWords(row.ahead ?? 0, row.behind ?? 0);
  if (counts) out.push(counts);
  if (row.gone) out.push("upstream gone");
  if (row.heldBy) out.push(`checked out in ${row.heldBy}`);
  if (row.locked) out.push("locked");
  if (row.missing) out.push("folder gone");
  return out.length ? `, ${out.join(", ")}` : "";
}

const SbTreeRow = memo(function SbTreeRow({ row, index, id, selected, stop }: { row: SbRow; index: number; id: string; selected: boolean; stop: boolean }) {
  const style = { top: index * SB_ROW_H, "--fk-sb-depth": row.depth } as CSSProperties;
  if (row.kind === "note") {
    return (
      <div className="fk-sb-note" role="treeitem" aria-level={row.level} aria-setsize={row.setSize} aria-posinset={row.posInSet} aria-selected={selected}
        id={id} data-key={row.key} tabIndex={stop ? 0 : -1} style={style} title={row.title}>
        {row.label}
      </div>
    );
  }
  if (row.kind === "section") {
    return (
      <div className="fk-sb-head" role="treeitem" aria-level={1} aria-setsize={row.setSize} aria-posinset={row.posInSet}
        aria-expanded={row.open} aria-selected={selected} id={id} data-key={row.key} data-open={row.open ? "" : undefined}
        tabIndex={stop ? 0 : -1} style={style}>
        {row.hasChildren ? <SbGlyph.chevron /> : <span className="fk-sb-chev-gap" aria-hidden="true" />}
        <span className="fk-sb-head-title">{row.label}</span>
      </div>
    );
  }
  const folder = row.kind === "folder" || row.kind === "remote";
  return (
    <div
      className={folder ? "fk-sb-folder" : "fk-sb-row"} role="treeitem"
      aria-level={row.level} aria-setsize={row.setSize} aria-posinset={row.posInSet} aria-selected={selected}
      aria-expanded={folder ? row.open : undefined} id={id} data-key={row.key} data-kind={row.kind}
      data-open={folder && row.open ? "" : undefined} data-current={row.current ? "" : undefined} data-missing={row.missing ? "" : undefined}
      tabIndex={stop ? 0 : -1} style={style} title={row.title}
    >
      {folder && <SbGlyph.chevron />}
      <span className="fk-sb-icon">{iconOf(row)}{row.gone && <GoneMark />}</span>
      <span className="fk-sb-label">{row.label}</span>
      {row.heldBy && <SbGlyph.held />}
      <Counts ahead={row.ahead} behind={row.behind} />
      {row.detail && <span className="fk-sb-detail">{row.detail}</span>}
      {words(row) && <span className="vis-hidden">{words(row)}</span>}
    </div>
  );
});

export interface SbTreeProps {
  rows: SbRow[];
  /** The row the reader chose: drawn with the selection pill. */
  selKey: string | null;
  /** The row Tab lands on. */
  stopKey: string | null;
  /** The tree's accessible name. */
  label: string;
  onCursor: (key: string) => void;
  onToggle: (key: string, open: boolean) => void;
  onJump: (row: SbRow) => void;
  onMenu: (row: SbRow, at: { x: number; y: number }) => void;
  onType: (text: string) => void;
  /** Bumped to send focus to the tab-stop row (from the filter's ↓). */
  focusSeq: number;
  /** A filter is typed: every folder is held open (sidebarKey). */
  filtering?: boolean;
}

export function FkSidebarTree({ rows, selKey, stopKey, label, onCursor, onToggle, onJump, onMenu, onType, focusSeq, filtering = false }: SbTreeProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 0 });
  const uid = `fk-sb${useId().replace(/:/g, "")}`;
  const idOf = (key: string) => `${uid}-${key.replace(/[^A-Za-z0-9_-]/g, c => `_${c.charCodeAt(0).toString(16)}`)}`;

  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const measure = () => setView(v => (v.top === sc.scrollTop && v.height === sc.clientHeight ? v : { top: sc.scrollTop, height: sc.clientHeight }));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(sc);
    return () => ro.disconnect();
  }, []);
  const raf = useRef(0);
  const onScroll = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const sc = scrollRef.current;
      if (sc) setView(v => (v.top === sc.scrollTop && v.height === sc.clientHeight ? v : { top: sc.scrollTop, height: sc.clientHeight }));
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const first = view.height ? Math.max(0, Math.floor(view.top / SB_ROW_H) - OVERSCAN) : 0;
  const last = view.height ? Math.min(rows.length, Math.ceil((view.top + view.height) / SB_ROW_H) + OVERSCAN) : Math.min(rows.length, FIRST_ROWS);
  const stopIndex = stopKey ? rows.findIndex(r => r.key === stopKey) : -1;
  const drawn: number[] = [];
  if (stopIndex >= 0 && stopIndex < first) drawn.push(stopIndex);
  for (let i = first; i < last; i++) drawn.push(i);
  if (stopIndex >= last) drawn.push(stopIndex);

  /** Scroll so row `i` is in sight, with no animation: it follows a key. */
  const reveal = useCallback((i: number) => {
    const sc = scrollRef.current;
    if (!sc) return;
    const top = i * SB_ROW_H;
    if (top < sc.scrollTop) sc.scrollTop = top;
    else if (top + SB_ROW_H > sc.scrollTop + sc.clientHeight) sc.scrollTop = top + SB_ROW_H - sc.clientHeight;
  }, []);

  // Focus follows the cursor once its row is drawn.
  const pending = useRef<string | null>(null);
  useLayoutEffect(() => {
    const want = pending.current;
    if (!want) return;
    const el = document.getElementById(idOf(want));
    if (el) { pending.current = null; el.focus({ preventScroll: true }); }
  });
  const focusRow = useCallback((key: string) => {
    const i = rows.findIndex(r => r.key === key);
    if (i < 0) return;
    reveal(i);
    pending.current = key;
    const el = document.getElementById(idOf(key));
    if (el) { pending.current = null; el.focus({ preventScroll: true }); }
  }, [rows, reveal]);
  useEffect(() => { if (focusSeq > 0 && stopKey) focusRow(stopKey); }, [focusSeq]);

  // Whether the last open or shut came from a key: its chevron turns at once.
  const [keyed, setKeyed] = useState(false);

  const indexOfEvent = (t: EventTarget | null) => {
    const key = (t as HTMLElement | null)?.closest?.<HTMLElement>("[data-key]")?.dataset.key;
    return key ? rows.findIndex(r => r.key === key) : -1;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = indexOfEvent(e.target);
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? SB_ROW_H * 10) / SB_ROW_H) - 1);
    const move = sidebarKey(e, rows, at < 0 ? stopIndex : at, page, filtering);
    if (move.kind === "pass") return;
    e.preventDefault();
    if (!keyed) setKeyed(true);
    if (move.kind === "stay") return;
    if (move.kind === "type") { onType(move.text); return; }
    const row = rows[move.index];
    if (!row) return;
    if (move.kind === "cursor") { onCursor(row.key); focusRow(row.key); return; }
    if (move.kind === "toggle") { onCursor(row.key); onToggle(row.key, move.open); return; }
    if (move.kind === "jump") { onCursor(row.key); onJump(row); return; }
    if (move.kind === "menu") {
      const box = document.getElementById(idOf(row.key))?.getBoundingClientRect();
      onMenu(row, box ? { x: box.left + 24, y: box.bottom } : { x: 0, y: 0 });
    }
  };

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const i = indexOfEvent(e.target);
    const row = rows[i];
    if (!row || row.kind === "note") return;
    onCursor(row.key);
    if (expandable(row)) onToggle(row.key, !row.open);
    else if (row.sha) onJump(row);
  };

  const onContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    const row = rows[indexOfEvent(e.target)];
    if (!row?.copy) return;
    e.preventDefault();
    onCursor(row.key);
    onMenu(row, { x: e.clientX, y: e.clientY });
  };

  return (
    <div className="fk-sb-scroll" ref={scrollRef} onScroll={onScroll}>
      <div className="fk-sb-tree" role="tree" aria-label={label} style={{ height: rows.length * SB_ROW_H }} data-keyed={keyed ? "" : undefined}
        onKeyDown={onKeyDown} onClick={onClick} onContextMenu={onContextMenu} onPointerDown={() => { if (keyed) setKeyed(false); }}>
        {drawn.map(i => {
          const row = rows[i];
          return <SbTreeRow key={row.key} row={row} index={i} id={idOf(row.key)} selected={row.key === selKey} stop={i === stopIndex} />;
        })}
      </div>
    </div>
  );
}
