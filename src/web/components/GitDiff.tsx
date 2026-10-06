import React, { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fmtBytes } from "../byte-format";
import { copyText } from "../copy-text";
import {
  budgetHunks, collapsedKind, diffState, freshLines, groupDigits, lockOwner, parsePatch,
  type DiffLine, type DiffResult, type Hunk, type ParsedDiff,
} from "../git-diff-parse";
import { fitPath, monoMeasure, splitPath, type PathParts } from "../git-path-fit";
import { cachedSpans, highlightDocs, langOf, type LineSpans } from "../git-syntax";
import { hunkWordMarks, type Range } from "../git-word-diff";
import { readStored, writeStored } from "../storage";
import { CheckGlyph, ClashGlyph, CopyGlyph, InfoGlyph, WrapGlyph } from "./GitDiffIcons";

export type { DiffResult } from "../git-diff-parse";

export interface GitDiffProps {
  file: { path: string; area: string; from?: string } | null;
  diff: DiffResult | null;
  loading: boolean;
  /** The file changed since this diff was read: the header offers the latest. */
  stale: boolean;
  /** "Show latest" (or `n`, which the view owns): read the diff again. */
  onShowLatest: () => void;
  wrap: boolean;
  onToggleWrap: () => void;
  /** A sharp collision on this file: who else edited it. */
  collision: { with: string } | null;
  /** Why no file is selected: a clean working tree, or nothing picked yet. */
  emptyReason?: "clean" | "unselected";
}

/** What the view does to the diff from outside: give it the keyboard. */
export interface GitDiffHandle {
  focus(): void;
}

const WRAP_KEY = "agent-dag.gitDiffWrap";

/** The header path's type size and the gap between the header's pieces
 *  (`.gvd-path`, `.gvd-title`): stated rather than read off the computed
 *  style, which nothing on a render may ask for; git-diff-view.test.ts holds
 *  both to the sheet. */
export const HEAD_PATH_PX = 12;
export const HEAD_GAP = 8;

/** Each syntax tone's class, spelled out so the sheet's rules can be found. */
const SYN_CLASS = { kw: "syn-kw", str: "syn-str", com: "syn-com" } as const;

/** Lines per block: the unit a diff is drawn in, and skipped in once it is
 *  long. */
export const BLOCK_LINES = 100;
/** From this many lines drawn on, only the blocks near the part of the diff
 *  on screen are rendered, and the others hold their height: a whole large
 *  diff stays as quick to scroll, wrap and leave as its first 400 lines. */
export const WINDOW_FROM = 1200;
/** How far above and below what is on screen blocks stay rendered. */
const WINDOW_MARGIN = "800px 0px";
/** A line's height and a hunk header's (24px, its borders and the 10px above
 *  it), for a block not drawn yet; `.gvd-line` and `.gvd-hunk` in the sheet. */
const LINE_PX = 20;
const HUNK_PX = 36;
/** Blocks drawn on the first frame of a windowed diff, by their estimated top. */
const FIRST_PX = 1600;

/** Whether diffs wrap long lines: on unless the reader turned it off. */
export function readDiffWrap(): boolean {
  return readStored(WRAP_KEY) !== "0";
}

export function writeDiffWrap(wrap: boolean): void {
  writeStored(WRAP_KEY, wrap ? "1" : "0");
}

const AREA_WORD: Record<string, string> = { staged: "staged", unstaged: "unstaged", untracked: "untracked", conflict: "conflict" };

const REASON: Record<string, string> = {
  timeout: "git took too long to answer.",
  gone: "The file is no longer there.",
  outside: "The file is outside this repository.",
  error: "git could not read it.",
  "too-large": "The answer was too large.",
  "not-downloaded": "This partial clone has not downloaded it, and the deck never fetches.",
};

/**
 * One file's diff, unified, the way the git view reads it: numbered gutters
 * that stay put while the code scrolls, a +/− glyph and a tinted gutter that
 * carry the meaning (with "added:"/"removed:" for a screen reader), the words
 * that changed inside a changed line, quiet syntax colours once they load,
 * long lines wrapped unless the reader says otherwise, and the first 400 lines
 * or 20 KB before "Load more".
 *
 * The diff being read never changes under the reader: when the file changes,
 * the header says so and offers the latest, and the lines that are new glow
 * once when it comes.
 */
const GitDiff = forwardRef<GitDiffHandle, GitDiffProps>(function GitDiff(props, ref) {
  const { file, diff, loading, stale, onShowLatest, wrap, onToggleWrap, collision, emptyReason = "unselected" } = props;
  const fileKey = file ? `${file.area}\0${file.path}` : "";
  const scrollRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef<HTMLSpanElement>(null);

  // How much of a long diff is drawn, and whether a collapsed one was opened:
  // both belong to one file, so another file starts over on its first frame.
  const [shown, setShown] = useState<{ key: string; steps: number; expanded: boolean }>({ key: "", steps: 1, expanded: false });
  const steps = shown.key === fileKey ? shown.steps : 1;
  const expanded = shown.key === fileKey && shown.expanded;
  const setSteps = (next: (n: number) => number) => setShown({ key: fileKey, steps: next(steps), expanded });
  const setExpanded = (open: boolean) => setShown({ key: fileKey, steps, expanded: open });
  const [copied, setCopied] = useState(false);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const [pathCut, setPathCut] = useState<PathParts | null>(null);
  const [headWidth, setHeadWidth] = useState(0);

  useImperativeHandle(ref, () => ({ focus: () => scrollRef.current?.focus() }), []);

  useEffect(() => { setCopied(false); }, [fileKey]);

  const parsed = useMemo<ParsedDiff | null>(
    () => (diff && diffState(diff) === "text" ? parsePatch(diff.patch ?? "") : null),
    [diff],
  );

  // Where the reader is: the first line on screen and how far below the
  // scroller's top it sits, kept as they scroll, so a newer version of the
  // same diff can be put back under them however the lines above it changed.
  const place = useRef<{ k: string; off: number } | null>(null);
  const placeRaf = useRef(0);
  const notePlace = useCallback(() => {
    if (placeRaf.current) return;
    placeRaf.current = requestAnimationFrame(() => {
      placeRaf.current = 0;
      const s = scrollRef.current;
      if (!s) return;
      if (s.scrollTop <= 0) { place.current = null; return; }
      const top = s.getBoundingClientRect().top;
      const line = Array.from(s.querySelectorAll<HTMLElement>(".gvd-line[data-k]")).find(l => l.getBoundingClientRect().bottom > top + 1);
      place.current = line ? { k: line.dataset.k!, off: line.getBoundingClientRect().top - top } : null;
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(placeRaf.current), []);
  useEffect(() => { place.current = null; }, [fileKey]);

  // The lines that are new since the version the reader saw: computed when
  // the same file's diff changes after the header said it was out of date.
  const seen = useRef<{ key: string; parsed: ParsedDiff | null; wasStale: boolean }>({ key: "", parsed: null, wasStale: false });
  useLayoutEffect(() => {
    const prev = seen.current;
    if (prev.key === fileKey && prev.parsed && parsed && prev.parsed !== parsed) keepPlace(scrollRef.current, place.current);
    if (prev.key === fileKey && prev.parsed && parsed && prev.parsed !== parsed && prev.wasStale) {
      setFresh(freshLines(prev.parsed, parsed));
      seen.current = { key: fileKey, parsed, wasStale: stale };
      return;
    }
    if (prev.key !== fileKey) setFresh(new Set());
    seen.current = { key: fileKey, parsed: parsed ?? prev.parsed, wasStale: prev.key === fileKey ? prev.wasStale || stale : stale };
  }, [fileKey, parsed, stale]);

  // Back to the top when a different file's diff is first on screen.
  const shownKey = useRef("");
  useLayoutEffect(() => {
    if (!diff || shownKey.current === fileKey) return;
    shownKey.current = fileKey;
    const s = scrollRef.current;
    if (s) { s.scrollTop = 0; s.scrollLeft = 0; }
  }, [diff, fileKey]);

  const collapsed = file && parsed && parsed.hunks.length ? collapsedKind(file.path, parsed) : null;
  const showTable = !!parsed && parsed.hunks.length > 0 && (!collapsed || expanded) && !parsed.binary;
  const budgeted = useMemo(() => (showTable && parsed ? budgetHunks(parsed.hunks, steps) : null), [showTable, parsed, steps]);

  // Syntax: each hunk's old side and new side tokenized as runs of lines, so a
  // comment or a string spanning lines reads whole. Plain until they arrive.
  const lang = file ? langOf(file.path) : null;
  const { docs, sideAt } = useMemo(() => sideDocs(lang ? budgeted?.hunks ?? [] : []), [budgeted, lang]);
  const [colored, setColored] = useState<{ docs: string[]; spans: LineSpans[][] } | null>(null);
  const known = useMemo(() => cachedSpans(lang, docs), [lang, docs]);
  const spans = (colored && colored.docs === docs ? colored.spans : null) ?? known;
  useEffect(() => {
    if (!lang || !docs.length || cachedSpans(lang, docs)) return;
    let live = true;
    highlightDocs(lang, docs).then(s => { if (live && s) setColored({ docs, spans: s }); });
    return () => { live = false; };
  }, [lang, docs]);

  // A long diff is drawn in blocks, and past WINDOW_FROM lines only the blocks
  // near the scroller's view are rendered; each one skipped holds the height
  // it was last drawn at, or an estimate, so the scrollbar tells the truth.
  const blocks = useMemo(() => (budgeted ? blocksOf(budgeted.hunks) : []), [budgeted]);
  const windowed = !!budgeted && budgeted.shown >= WINDOW_FROM && typeof IntersectionObserver !== "undefined";
  const heights = useRef(new Map<string, number>());
  useEffect(() => { heights.current = new Map(); }, [fileKey, wrap]);
  const watch = useWindow(scrollRef, windowed);
  const rows = useMemo<RowsCtx | null>(
    () => (budgeted ? { hunks: budgeted.hunks, spans, sideAt, fresh } : null),
    [budgeted, spans, sideAt, fresh],
  );
  // Unwrapped and windowed, the diff is as wide as its longest line, drawn or not.
  const cols = useMemo(() => (windowed && !wrap && budgeted ? widestLine(budgeted.hunks) : 0), [windowed, wrap, budgeted]);

  // The header's path is cut to the room its row leaves it, file name whole.
  useLayoutEffect(() => {
    const t = titleRef.current;
    if (!t || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setHeadWidth(Math.round(t.clientWidth)));
    ro.observe(t);
    return () => ro.disconnect();
  }, [file !== null]);
  useLayoutEffect(() => {
    const t = titleRef.current, p = pathRef.current;
    if (!file || !t || !p) return;
    let used = 0, others = 0;
    for (const c of Array.from(t.children)) {
      if (c === p || (c as HTMLElement).classList.contains("vis-hidden")) continue;
      used += c.getBoundingClientRect().width;
      others++;
    }
    const room = t.clientWidth - used - HEAD_GAP * others - 2;
    const cut = fitPath(file.path, room, monoMeasure(HEAD_PATH_PX));
    setPathCut(prev => (prev && prev.dir === cut.dir && prev.base === cut.base ? prev : { dir: cut.dir, base: cut.base }));
  }, [file?.path, headWidth, stale, diff, loading]);

  // The body last drawn, kept on screen for a moment while the next file's
  // diff is on its way, so switching files never flashes an empty pane. It
  // stays the very element it was, in the same wrapper, so keeping it costs
  // nothing: React has nothing to draw again.
  const lastBody = useRef<React.ReactNode>(null);

  // A control in the diff that goes away when pressed (Show diff, Load all,
  // the last Load more, Show latest) leaves the keyboard in the diff rather
  // than on the page, where the deck's own keys would answer the next press.
  const holdFocus = useCallback(() => {
    const s = scrollRef.current;
    const at = document.activeElement;
    if (s && at && at !== s && s.closest(".gvd")?.contains(at)) s.focus({ preventScroll: true });
  }, []);

  if (!file) {
    return (
      <div className="gvd" data-wrap={wrap}>
        <div className="gvd-head"><span className="gvd-title-word">Diff</span></div>
        <div className="gvd-empty">
          {emptyReason === "clean"
            ? <><b>Nothing to show.</b><span>The working tree matches HEAD. Pick a commit above to read its changes.</span></>
            : <><b>No file selected.</b><span>Pick a file on the left, or press → then Enter.</span></>}
        </div>
      </div>
    );
  }

  const pending = !diff && loading && lastBody.current != null;
  let content: React.ReactNode;
  if (!diff) {
    content = pending ? lastBody.current : loading ? null : <Placeholder title="Nothing to show yet." />;
  } else {
    content = renderBody();
    lastBody.current = content;
  }
  const body = (
    <>
      {loading && <Loading />}
      <div className="gvd-body" data-pending={pending || undefined} aria-hidden={pending || undefined}>{content}</div>
    </>
  );

  function renderBody(): React.ReactNode {
    const d = diff!;
    const state = diffState(d);
    if (state === "error") return <Placeholder title="Couldn't read this diff." line={REASON[d.reason ?? "error"] ?? REASON.error} />;
    if (state === "directory") {
      return <Placeholder title="An untracked folder." line="git lists a new folder as one entry until a file in it is added, so its files are not shown one by one." />;
    }
    if (state === "binary" || parsed?.binary) return <Placeholder title="Binary file, not shown." line={sizes(d)} />;
    if (state === "too-large") {
      return <Placeholder title="Too large to show here." line={`The diff is over ${fmtBytes(d.limit)}, the most the deck reads at once.${sizes(d) ? ` ${sizes(d)}.` : ""}`} />;
    }
    const p = parsed!;
    if (!p.hunks.length) {
      if (p.renamed || p.copied) {
        const from = splitPath(p.from ?? file!.from ?? "").base;
        return <Placeholder title={p.copied ? "Copied, content unchanged." : "Renamed, content unchanged."}
          line={`${from} → ${splitPath(file!.path).base}${p.similarity !== undefined ? ` · ${p.similarity}% similar` : ""}`} />;
      }
      if (file!.area === "conflict" || p.unmerged) {
        return <Placeholder title="In conflict, and the same as HEAD here." line="The other side of the merge changed or deleted this file. Resolve the conflict in your editor or git client." />;
      }
      if (p.oldMode && p.newMode) return <Placeholder title="Only the file mode changed." line={`${p.oldMode} → ${p.newMode}`} mono />;
      if (p.created) return <Placeholder title="An empty new file." />;
      if (p.deleted) return <Placeholder title="An empty file, deleted." />;
      return <Placeholder title="No changes in the text." />;
    }
    if (collapsed && !expanded) {
      const who = collapsed === "lock" ? lockOwner(file!.path) : null;
      return (
        <div className="gvd-placeholder">
          <b>{collapsed === "lock" ? "Lock file, diff collapsed." : "Generated file, diff collapsed."}</b>
          <span>
            {(d.added ?? 0) > 0 && <><span className="gvd-add">+{groupDigits(d.added ?? 0)}</span>{" "}</>}
            {(d.removed ?? 0) > 0 && <><span className="gvd-del">−{groupDigits(d.removed ?? 0)}</span>{" "}</>}
            lines{who ? `, written by ${who}` : ""}.
          </span>
          <button type="button" className="btn gvd-show" onClick={() => { holdFocus(); setExpanded(true); }}>Show diff</button>
        </div>
      );
    }
    const b = budgeted!;
    const next = b.shown < b.total ? budgetHunks(parsed!.hunks, steps + 1).shown : b.total;
    return (
      <>
        <div className="gvd-diff" key={fileKey} style={cols ? { minWidth: `max(100%, calc(${cols}ch + ${GUTTER_PX + CODE_PAD_PX}px))` } : undefined}>
          {blocks.map(k => (
            <DiffBlock key={k.key} block={k} rows={rows!} watch={watch} heights={heights.current} />
          ))}
        </div>
        {b.shown < b.total && (
          <div className="gvd-more">
            <span>Showing {groupDigits(b.shown)} of {groupDigits(b.total)} lines</span>
            <button type="button" className="gvd-link" onClick={() => { if (next >= b.total) holdFocus(); setSteps(s => s + 1); }}>Load {groupDigits(next - b.shown)} more</button>
            <button type="button" className="gvd-link" onClick={() => { holdFocus(); setSteps(() => Infinity); }}>Load all</button>
          </div>
        )}
      </>
    );
  }

  const parts = pathCut ?? splitPath(file.path);
  const counts = diff && diffState(diff) === "text" && !parsed?.binary ? { added: diff.added ?? 0, removed: diff.removed ?? 0 } : null;
  const renameFrom = parsed?.from ?? file.from;
  const copy = async () => {
    if (await copyText(file.path)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="gvd" data-wrap={wrap}>
      <div className="gvd-head">
        <div className="gvd-title" ref={titleRef}>
          <span className="vis-hidden">{file.path}</span>
          <span className="gvd-path" ref={pathRef} title={file.path} aria-hidden="true">
            <span className="gvd-dir">{parts.dir}</span><span className="gvd-base">{parts.base}</span>
          </span>
          {AREA_WORD[file.area] && <span className="gvd-area" data-area={file.area}>{AREA_WORD[file.area]}</span>}
          {renameFrom && (
            <span className="gvd-from" title={`renamed from ${renameFrom}${parsed?.similarity !== undefined ? `, ${parsed.similarity}% similar` : ""}`}>
              ← {splitPath(renameFrom).base}{parsed?.similarity !== undefined ? ` · ${parsed.similarity}%` : ""}
            </span>
          )}
          {counts && (
            <span className="gvd-counts">
              {counts.added > 0 && <span className="gvd-add">+{groupDigits(counts.added)}<span className="vis-hidden"> added</span></span>}
              {counts.removed > 0 && <span className="gvd-del">−{groupDigits(counts.removed)}<span className="vis-hidden"> removed</span></span>}
            </span>
          )}
          {stale && (
            <button type="button" className="gvd-pill" onClick={() => { holdFocus(); onShowLatest(); }} title="The file changed since this diff was read. Show the latest (n)">
              <span className="gvd-pill-dot" aria-hidden="true" />
              <span className="gvd-pill-long">Updated just now · </span>Show latest <kbd>n</kbd>
            </button>
          )}
        </div>
        <span className="gvd-actions">
          <button type="button" className="glyph-btn gvd-icon" aria-pressed={wrap} onClick={onToggleWrap} title="Wrap lines" aria-label="Wrap lines">
            <WrapGlyph />
          </button>
          <button type="button" className="glyph-btn gvd-icon" onClick={copy} title={copied ? "Copied" : "Copy path"} aria-label="Copy path">
            {copied ? <CheckGlyph /> : <CopyGlyph />}
          </button>
        </span>
        <span className="vis-hidden" aria-live="polite">
          {stale ? "This file changed since the diff was read. Show the latest with n." : copied ? "Path copied" : ""}
        </span>
      </div>
      {collision && (
        <div className="gvd-note">
          <ClashGlyph />
          <span><b>{collision.with}</b> edited this file too since it was last committed. This diff is the folder as it is now.</span>
        </div>
      )}
      {file.area === "conflict" && (
        <div className="gvd-note">
          <InfoGlyph />
          <span><b>Unresolved merge conflict.</b> This is the file as it is now against HEAD, its conflict markers included.</span>
        </div>
      )}
      <div ref={scrollRef} className="gvd-scroll" tabIndex={0} role="region" aria-label={`Diff of ${file.path}`} aria-busy={loading || undefined} onScroll={notePlace}>
        {body}
      </div>
    </div>
  );
});

export default GitDiff;

function Placeholder({ title, line, mono }: { title: string; line?: string | null; mono?: boolean }) {
  return (
    <div className="gvd-placeholder">
      <b>{title}</b>
      {line && <span className={mono ? "gvd-mono" : undefined}>{line}</span>}
    </div>
  );
}

/** Appears only if the wait is long enough to notice. */
function Loading() {
  return <div className="gvd-loading" role="status">Loading the diff…</div>;
}

function sizes(d: DiffResult): string | null {
  const has = (n: number | null | undefined): n is number => typeof n === "number";
  if (has(d.oldSize) && has(d.newSize)) return `The file went from ${fmtBytes(d.oldSize)} to ${fmtBytes(d.newSize)}`;
  if (has(d.newSize)) return `A new file of ${fmtBytes(d.newSize)}`;
  if (has(d.oldSize)) return `It was ${fmtBytes(d.oldSize)}`;
  return null;
}

/**
 * Each hunk's old side and new side as two runs of text — [old0, new0, old1,
 * new1, …] — and where each line sits in its run: a removed line in the old
 * side, every other line in the new.
 */
function sideDocs(hunks: Hunk[]): { docs: string[]; sideAt: number[][] } {
  const docs: string[] = [];
  const sideAt: number[][] = [];
  for (const h of hunks) {
    const oldSide: string[] = [], newSide: string[] = [], at: number[] = [];
    for (const l of h.lines) {
      if (l.kind === "del") { at.push(oldSide.length); oldSide.push(l.text); continue; }
      if (l.kind === "ctx") oldSide.push(l.text);
      at.push(newSide.length);
      newSide.push(l.text);
    }
    docs.push(oldSide.join("\n"), newSide.join("\n"));
    sideAt.push(at);
  }
  return { docs, sideAt };
}

/** Put the line the reader was on back where it was on screen, if the new
 *  version still has it. */
function keepPlace(s: HTMLElement | null, at: { k: string; off: number } | null): void {
  if (!s || !at) return;
  const line = s.querySelector<HTMLElement>(`.gvd-line[data-k="${CSS.escape(at.k)}"]`);
  if (!line) return;
  const off = line.getBoundingClientRect().top - s.getBoundingClientRect().top;
  if (Math.abs(off - at.off) >= 1) s.scrollTop += off - at.off;
}

/** What every block reads its lines from. */
interface RowsCtx {
  hunks: Hunk[];
  /** Syntax spans, two runs per hunk (old side, new side), or null. */
  spans: LineSpans[][] | null;
  /** Where each line sits in its side's run, by hunk. */
  sideAt: number[][];
  /** Lines new since the version the reader saw, `hunk:line`. */
  fresh: Set<string>;
}

/** A run of up to BLOCK_LINES lines of one hunk, its header with the first. */
interface Block {
  key: string;
  hi: number;
  from: number;
  to: number;
  head: boolean;
  /** Where it starts and how tall it is, estimated before it is drawn. */
  top: number;
  est: number;
}

/** The three gutter cells (`.gvd-line`) and the code cell's padding. */
const GUTTER_PX = 44 + 44 + 18;
const CODE_PAD_PX = 4 + 24;

/**
 * Blocks keyed by what they hold rather than where they sit: a hunk by where
 * it starts in the old file, which an edit elsewhere in the working tree does
 * not move (the old side of an unstaged diff is the index). So when the
 * reader takes the latest and a hunk above them is gone, only its block goes,
 * and the lines they were reading stay the same nodes.
 */
export function blocksOf(hunks: Hunk[]): Block[] {
  const out: Block[] = [];
  const used = new Map<number, number>();
  let top = 0;
  hunks.forEach((h, hi) => {
    const twice = used.get(h.oldStart) ?? 0;
    used.set(h.oldStart, twice + 1);
    const hk = `o${h.oldStart}${twice ? `~${twice}` : ""}`;
    const n = Math.max(1, h.lines.length);
    for (let from = 0; from < n; from += BLOCK_LINES) {
      const to = Math.min(h.lines.length, from + BLOCK_LINES);
      const head = from === 0;
      const est = (head ? HUNK_PX : 0) + (to - from) * LINE_PX;
      out.push({ key: `${hk}.${from / BLOCK_LINES}`, hi, from, to, head, top, est });
      top += est;
    }
  });
  return out;
}

/** Each line's key in its hunk, by what it is rather than where it sits: a
 *  removed or unchanged line by its number in the old file, an added one by
 *  the old line it follows and its place in the run of added lines there. */
const keysOf = new WeakMap<DiffLine[], string[]>();
export function lineKeys(lines: DiffLine[], oldStart: number): string[] {
  let k = keysOf.get(lines);
  if (k) return k;
  k = [];
  let after = oldStart - 1, run = 0;
  for (const l of lines) {
    if (l.kind === "add") k.push(`a${after}.${run++}`);
    else { after = l.old ?? after; run = 0; k.push(`o${after}`); }
  }
  keysOf.set(lines, k);
  return k;
}

/** The longest line, in characters, a tab counted as the sheet's tab-size. */
function widestLine(hunks: Hunk[]): number {
  let w = 0;
  for (const h of hunks) for (const l of h.lines) {
    if (l.text.length <= w) continue;
    const tabs = l.text.split("\t").length - 1;
    w = Math.max(w, l.text.length + tabs * 3);
  }
  return w;
}

type Watch = (el: Element, on: (e: IntersectionObserverEntry) => void) => () => void;

/** One IntersectionObserver on the scroller for every block of a windowed
 *  diff, or null when the diff is drawn whole. */
function useWindow(scrollRef: React.RefObject<HTMLDivElement>, on: boolean): Watch | null {
  const io = useRef<{ io: IntersectionObserver; of: Map<Element, (e: IntersectionObserverEntry) => void> } | null>(null);
  useEffect(() => () => { io.current?.io.disconnect(); io.current = null; }, [on]);
  return useMemo<Watch | null>(() => {
    if (!on) return null;
    return (el, cb) => {
      if (!io.current) {
        const of = new Map<Element, (e: IntersectionObserverEntry) => void>();
        const obs = new IntersectionObserver(entries => { for (const e of entries) of.get(e.target)?.(e); }, { root: scrollRef.current, rootMargin: WINDOW_MARGIN });
        io.current = { io: obs, of };
      }
      const cur = io.current;
      cur.of.set(el, cb);
      cur.io.observe(el);
      return () => { cur.of.delete(el); cur.io.unobserve(el); };
    };
  }, [on]);
}

/** A hunk's word marks, worked out the first time a block of it is drawn. */
const marksOf = new WeakMap<Hunk, Map<number, Range[]>>();
function wordMarks(h: Hunk): Map<number, Range[]> {
  let m = marksOf.get(h);
  if (!m) { m = hunkWordMarks(h.lines); marksOf.set(h, m); }
  return m;
}

/**
 * One block of a diff: drawn while it is near the part on screen, or always
 * when the diff is not windowed; otherwise an empty box at the height it was
 * last drawn at (or its estimate), so nothing below it moves.
 */
const DiffBlock = memo(function DiffBlock({ block, rows, watch, heights }: {
  block: Block; rows: RowsCtx; watch: Watch | null; heights: Map<string, number>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(() => !watch || (!heights.has(block.key) && block.top < FIRST_PX));
  const drawn = useRef(near);
  useEffect(() => {
    const el = ref.current;
    if (!watch || !el) return;
    return watch(el, e => {
      if (e.isIntersecting) { drawn.current = true; setNear(true); return; }
      if (drawn.current) heights.set(block.key, e.boundingClientRect.height);
      drawn.current = false;
      setNear(false);
    });
  }, [watch, block.key, heights]);
  if (watch && !near) return <div ref={ref} className="gvd-block" style={{ height: heights.get(block.key) ?? block.est }} />;
  const { hi } = block;
  const h = rows.hunks[hi];
  const marks = wordMarks(h);
  const keys = lineKeys(h.lines, h.oldStart);
  const at = block.key.slice(0, block.key.lastIndexOf("."));
  return (
    <div ref={ref} className="gvd-block">
      {block.head && (
        <div className="gvd-hunk">
          <span className="gvd-hunk-range">{h.range}</span>
          {h.section && <span className="gvd-hunk-ctx" title={h.section}>{h.section}</span>}
        </div>
      )}
      {h.lines.slice(block.from, block.to).map((l, i) => {
        const li = block.from + i;
        const syn = rows.spans?.[hi * 2 + (l.kind === "del" ? 0 : 1)]?.[rows.sideAt[hi]?.[li]];
        return (
          <div key={keys[li]} className="gvd-line" data-k={`${at}:${keys[li]}`} data-kind={l.kind} data-fresh={rows.fresh.has(`${hi}:${li}`) ? "" : undefined}>
            <span className="gvd-ln n1" aria-hidden="true">{l.old ?? ""}</span>
            <span className="gvd-ln n2" aria-hidden="true" data-old={l.kind === "del" ? l.old ?? undefined : undefined}>{l.new ?? ""}</span>
            <span className="gvd-glyph" aria-hidden="true">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
            <span className="gvd-code">
              {l.kind === "add" && <span className="vis-hidden">added: </span>}
              {l.kind === "del" && <span className="vis-hidden">removed: </span>}
              {codeOf(l.text, syn, marks.get(li))}
              {l.noEol && <span className="gvd-noeol" title="No newline at end of file"><span aria-hidden="true">⊘</span><span className="vis-hidden"> no newline at end of file</span></span>}
            </span>
          </div>
        );
      })}
    </div>
  );
});

/** A line's text in segments: syntax tones inside, the changed words marked. */
function codeOf(text: string, syn: LineSpans | undefined, words: Range[] | undefined): React.ReactNode {
  // An empty line copies as an empty line, not as a space.
  if (!text) return <br />;
  if (!syn?.length && !words?.length) return text;
  const cuts = new Set<number>([0, text.length]);
  for (const [s, e] of syn ?? []) { cuts.add(s); cuts.add(e); }
  for (const [s, e] of words ?? []) { cuts.add(s); cuts.add(e); }
  const at = [...cuts].filter(n => n >= 0 && n <= text.length).sort((a, b) => a - b);
  const kindAt = (pos: number) => syn?.find(([s, e]) => pos >= s && pos < e)?.[2];
  const inWord = (pos: number) => !!words?.some(([s, e]) => pos >= s && pos < e);
  const out: React.ReactNode[] = [];
  let mark: React.ReactNode[] | null = null;
  for (let i = 0; i < at.length - 1; i++) {
    const s = at[i], e = at[i + 1];
    if (s === e) continue;
    const kind = kindAt(s);
    const piece = kind ? <span key={s} className={SYN_CLASS[kind]}>{text.slice(s, e)}</span> : text.slice(s, e);
    if (inWord(s)) {
      if (!mark) mark = [];
      mark.push(piece);
    } else {
      if (mark) { out.push(<mark key={`m${s}`} className="gvd-word">{mark}</mark>); mark = null; }
      out.push(typeof piece === "string" ? <React.Fragment key={s}>{piece}</React.Fragment> : piece);
    }
  }
  if (mark) out.push(<mark key="m-end" className="gvd-word">{mark}</mark>);
  return out;
}
