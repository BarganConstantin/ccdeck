import React, { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fmtBytes } from "../byte-format";
import { copyText } from "../copy-text";
import {
  budgetHunks, collapsedKind, diffState, freshLines, groupDigits, lockOwner, parsePatch,
  type DiffResult, type Hunk, type ParsedDiff,
} from "../git-diff-parse";
import { fitPath, monoMeasure, splitPath, type PathParts } from "../git-path-fit";
import { cachedSpans, highlightDocs, langOf, type LineSpans } from "../git-syntax";
import { hunkWordMarks, type Range } from "../git-word-diff";
import { readStored, writeStored } from "../storage";
import { CheckGlyph, ClashGlyph, CopyGlyph, WrapGlyph } from "./GitDiffIcons";

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

  // The lines that are new since the version the reader saw: computed when
  // the same file's diff changes after the header said it was out of date.
  const seen = useRef<{ key: string; parsed: ParsedDiff | null; wasStale: boolean }>({ key: "", parsed: null, wasStale: false });
  useLayoutEffect(() => {
    const prev = seen.current;
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
  const marks = useMemo(() => budgeted?.hunks.map(h => hunkWordMarks(h.lines)) ?? [], [budgeted]);

  // Syntax: each hunk's old side and new side tokenized as runs of lines, so a
  // comment or a string spanning lines reads whole. Plain until they arrive.
  const lang = file ? langOf(file.path) : null;
  const { docs, sideAt } = useMemo(() => sideDocs(budgeted?.hunks ?? []), [budgeted]);
  const [colored, setColored] = useState<{ docs: string[]; spans: LineSpans[][] } | null>(null);
  const spans = (colored && colored.docs === docs ? colored.spans : null) ?? cachedSpans(lang, docs);
  useEffect(() => {
    if (!lang || !docs.length || cachedSpans(lang, docs)) return;
    let live = true;
    highlightDocs(lang, docs).then(s => { if (live && s) setColored({ docs, spans: s }); });
    return () => { live = false; };
  }, [lang, docs]);

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
  // diff is on its way, so switching files never flashes an empty pane.
  const lastBody = useRef<React.ReactNode>(null);

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

  let body: React.ReactNode;
  if (!diff) {
    body = loading && lastBody.current
      ? <><div className="gvd-pending" aria-hidden="true">{lastBody.current}</div><Loading /></>
      : loading ? <Loading /> : <Placeholder title="Nothing to show yet." />;
  } else {
    body = renderBody();
    lastBody.current = body;
  }

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
          <button type="button" className="btn gvd-show" onClick={() => setExpanded(true)}>Show diff</button>
        </div>
      );
    }
    const b = budgeted!;
    return (
      <>
        <div className="gvd-diff">
          {b.hunks.map((h, hi) => (
            <React.Fragment key={hi}>
              <div className="gvd-hunk">
                <span className="gvd-hunk-range">{h.range}</span>
                {h.section && <span className="gvd-hunk-ctx" title={h.section}>{h.section}</span>}
              </div>
              {h.lines.map((l, li) => {
                const syn = spans?.[hi * 2 + (l.kind === "del" ? 0 : 1)]?.[sideAt[hi][li]];
                return (
                  <div key={li} className="gvd-line" data-kind={l.kind} data-fresh={fresh.has(`${hi}:${li}`) ? "" : undefined}>
                    <span className="gvd-ln n1" aria-hidden="true">{l.old ?? ""}</span>
                    <span className="gvd-ln n2" aria-hidden="true" data-old={l.kind === "del" ? l.old ?? undefined : undefined}>{l.new ?? ""}</span>
                    <span className="gvd-glyph" aria-hidden="true">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
                    <span className="gvd-code">
                      {l.kind === "add" && <span className="vis-hidden">added: </span>}
                      {l.kind === "del" && <span className="vis-hidden">removed: </span>}
                      {codeOf(l.text, syn, marks[hi]?.get(li))}
                      {l.noEol && <span className="gvd-noeol" title="No newline at end of file"><span aria-hidden="true">⊘</span><span className="vis-hidden"> no newline at end of file</span></span>}
                    </span>
                  </div>
                );
              })}
            </React.Fragment>
          ))}
        </div>
        {b.shown < b.total && (
          <div className="gvd-more">
            <span>Showing {groupDigits(b.shown)} of {groupDigits(b.total)} lines</span>
            <button type="button" className="gvd-link" onClick={() => setSteps(s => s + 1)}>Load {groupDigits(budgetHunks(parsed!.hunks, steps + 1).shown - b.shown)} more</button>
            <button type="button" className="gvd-link" onClick={() => setSteps(() => Infinity)}>Load all</button>
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
            <button type="button" className="gvd-pill" onClick={onShowLatest} title="The file changed since this diff was read. Show the latest (n)">
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
      <div ref={scrollRef} className="gvd-scroll" tabIndex={0} role="region" aria-label={`Diff of ${file.path}`} aria-busy={loading || undefined}>
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

/** A line's text in segments: syntax tones inside, the changed words marked. */
function codeOf(text: string, syn: LineSpans | undefined, words: Range[] | undefined): React.ReactNode {
  if (!text) return " ";
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
