import React from "react";
import { shownPath } from "../git-hidden-chars";
import { splitPath } from "../git-path-fit";
import FkFileTypeLabel from "./FkFileTypeLabel";
import { CheckGlyph, CopyGlyph, ReloadGlyph, WrapGlyph } from "./GitDiffIcons";

// The bar over the Fork look's diff: ▲ ▼ to step through the changed files
// on the left, the file's kind and path in the middle (the folder gives way
// first, the name stays whole as long as it can), the diff's tools on the
// right. The tools are only the ones the deck has — nothing here stages,
// discards or reverts.

export interface FkPathBarProps {
  file: { path: string; area: string; from?: string };
  /** The path it was renamed or copied from, when it was. */
  from?: string | null;
  similarity?: number;
  /** The file before and after in the tree; absent at either end. */
  onPrev?: () => void;
  onNext?: () => void;
  stale: boolean;
  gone: boolean;
  onShowLatest: () => void;
  /** What the pill says git no longer lists it as. */
  areaWord?: string;
  wrap: boolean;
  onToggleWrap: () => void;
  copied: boolean;
  onCopy: () => void;
  /** Open in editor, when the deck found one and the page is on its machine. */
  editor?: React.ReactNode;
  onReload?: () => void;
}

function Chevron({ up }: { up: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <path d={up ? "M3 8.5 7 4.8l4 3.7" : "M3 5.5 7 9.2l4-3.7"} />
    </svg>
  );
}

export default function FkPathBar(p: FkPathBarProps) {
  const shown = shownPath(p.file.path);
  const parts = splitPath(shown);
  const from = p.from ? shownPath(p.from) : null;
  const title = from ? `${p.file.path}\nrenamed from ${p.from}${p.similarity !== undefined ? `, ${p.similarity}% similar` : ""}` : p.file.path;
  return (
    <div className="fkd-bar">
      <span className="fkd-bar-steps">
        <button type="button" className="fkd-step" onClick={p.onPrev} disabled={!p.onPrev} title="Previous file" aria-label="Previous file"><Chevron up /></button>
        <button type="button" className="fkd-step" onClick={p.onNext} disabled={!p.onNext} title="Next file" aria-label="Next file"><Chevron up={false} /></button>
      </span>
      <span className="fkd-bar-path" title={title}>
        <span className="vis-hidden">{p.file.path}</span>
        <FkFileTypeLabel path={p.file.path} />
        <span className="fkd-bar-text" aria-hidden="true">
          {from && <><span className="fkd-bar-from">{splitPath(from).base}</span><span className="fkd-bar-arrow">→</span></>}
          <span className="fkd-bar-dir">{parts.dir}</span>
          <span className="fkd-bar-base">{parts.base}</span>
        </span>
        {from && <span className="vis-hidden">, renamed from {p.from}</span>}
      </span>
      <span className="fkd-bar-tools">
        {p.stale && (
          <button type="button" className="fkd-pill" onClick={p.onShowLatest}
            title={p.gone ? "git no longer lists this change. Show the latest (n)" : "The file changed since this diff was read. Show the latest (n)"}>
            <span className="fkd-pill-dot" aria-hidden="true" />
            <span className="fkd-pill-long">{p.gone ? `No longer ${p.areaWord ?? "changed"} · ` : "Updated just now · "}</span>Show latest
          </button>
        )}
        <button type="button" className="fkd-tool" aria-pressed={p.wrap} onClick={p.onToggleWrap} title="Wrap lines" aria-label="Wrap lines"><WrapGlyph /></button>
        <button type="button" className="fkd-tool" onClick={p.onCopy} title={p.copied ? "Copied" : "Copy path"} aria-label="Copy path">
          {p.copied ? <CheckGlyph /> : <CopyGlyph />}
        </button>
        {p.editor}
        {p.onReload && (
          <button type="button" className="fkd-tool" onClick={p.onReload} title="Reload the diff (n)" aria-label="Reload the diff"><ReloadGlyph /></button>
        )}
      </span>
      <span className="vis-hidden" aria-live="polite">
        {p.stale ? (p.gone ? "git no longer lists this change. Show the latest with n." : "This file changed since the diff was read. Show the latest with n.") : p.copied ? "Path copied" : ""}
      </span>
    </div>
  );
}

/** The diff with nothing selected: one quiet line in the middle of the pane. */
export function FkDiffEmpty({ reason }: { reason: "clean" | "unselected" }) {
  return (
    <div className="fkd-empty">
      <span className="fkd-empty-line">{reason === "clean" ? "Working tree clean." : "Select a file."}</span>
    </div>
  );
}
