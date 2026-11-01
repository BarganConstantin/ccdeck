// The pieces the attention rail (SessionList.tsx) is drawn from: the status
// glyph, a row, a group's header, the fold, and the small marks they use. The
// rail's rules are rail-model.ts's and what a row says is rail-row-copy.ts's;
// this only lays them out.
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { Row } from "./SessionList";
import { AlertMark, StateMark } from "./StateMark";
import { stateLabel } from "../agent-copy";
import { modelChipText, modelChipTitle } from "../model-label";
import { RAIL_GROUP_LABELS, type RailGroup } from "../rail-model";
import { railGlyph, railLine, railTime, rowSpoken, rowTooltip, type RailGlyphKind } from "../rail-row-copy";
import { fadeIn, tokenMs } from "../rail-motion";

/** The 14px status glyph. Working breathes on --pulse-live and nothing else
 *  moves on its own; Waiting is the alert triangle and holds still, because
 *  what asks for you is the rail's order, not motion. The kind keys the mark,
 *  and the new mark fades in over --dur-fast only when THIS row's kind changes
 *  (a row that is only moved, or drawn again, remounts without playing it). */
export function RailGlyph({ kind }: { kind: RailGlyphKind }) {
  const shown = useRef(kind);
  const mark = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (shown.current === kind) return;
    shown.current = kind;
    fadeIn(mark.current);
  }, [kind]);
  return (
    <span className="sl-glyph" data-glyph={kind} aria-hidden>
      <span key={kind} ref={mark} className="sl-glyph-mark">
        {kind === "waiting" && <AlertMark size={14} />}
        {kind === "working" && <StateMark kind="live" size={14} />}
        {kind === "done" && <StateMark kind="done" size={14} />}
        {kind === "error" && <StateMark kind="err" size={14} />}
        {kind === "idle" && <StateMark kind="idle" size={14} />}
      </span>
    </span>
  );
}

/** A chevron that points right and turns a quarter when its group is open. */
export function ChevronGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg className="sl-chev" width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor"
      strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4.5 2.5L8 6l-3.5 3.5" />
    </svg>
  );
}

/** The close button's 14px mark, drawn on the control glyphs' own spec
 *  (rail-glyphs.tsx): a 14 viewBox, round caps, a 1.4 stroke. */
export function CloseGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor"
      strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
    </svg>
  );
}

export type FoldMode = "animate" | "fade" | "instant";

export interface RailRowProps {
  row: Row;
  group: RailGroup;
  now: number;
  selected: boolean;
  removed: boolean;
  /** Gone from the list and still drawn, inert, while it fades and its space closes. */
  leaving: boolean;
  /** Set, for one render, on the row the last jump landed on: the highlight's turn. */
  landNonce: number | null;
  onSelect: (sessionId: string) => void;
}

export function RailRow({ row: r, group, now, selected, removed, leaving, landNonce, onSelect }: RailRowProps) {
  const line = railLine(r, group);
  const time = railTime(r, group, now);
  // The highlight is the row's own once it has been handed over, so it plays
  // out its fade; a row drawn again later has no nonce and does not replay it.
  const [lit, setLit] = useState<number | null>(null);
  useEffect(() => { if (landNonce != null) setLit(landNonce); }, [landNonce]);
  return (
    <li className={`sl-row-item${leaving ? " leaving" : ""}`} data-rail-id={r.sessionId}
      ref={el => { if (el) el.inert = leaving; }}>
      <div className="sl-row-in">
        <button
          type="button"
          className={`sl-row${selected ? " selected" : ""}${removed ? " removed" : ""}`}
          aria-current={selected ? "true" : undefined}
          onClick={() => onSelect(r.sessionId)}
          title={rowTooltip(r, removed)}
        >
          {/* Once, on the row a jump arrived at; a new nonce is a new element,
              so the fade runs again for the next jump. */}
          {lit != null && <span key={lit} className="sl-land" aria-hidden onAnimationEnd={() => setLit(null)} />}
          {/* The glyph stays hidden and the state beside it is in words, ahead
              of the name, so the row's name says what the glyph shows (#373). */}
          <RailGlyph kind={railGlyph(r, group)} />
          <span className="vis-hidden">{stateLabel(r.state)}</span>
          {/* What the row no longer draws, for a screen reader and for touch,
              where the tooltip is not reached. */}
          <span className="vis-hidden">{rowSpoken(r)}</span>
          <span className="sl-text">
            <span className="sl-line1">
              <span className="sl-name">
                <span className="sl-label">{r.label}</span>
                {r.modelId && <span className="sl-model" title={modelChipTitle(r.modelId, r.effort)}>{modelChipText(r.modelId, r.effort)}</span>}
                {/* Words, in the row's name: the press on this row does something different. */}
                {removed && <span className="sl-model">off the board</span>}
              </span>
              {time && <span className={`sl-time ${time.tone}`}><span className="vis-hidden">{time.spoken}</span>{time.text}</span>}
            </span>
            {line && (
              <span className={`sl-line2 ${line.kind === "sans" ? "sans" : "mono"}`}>
                {line.kind === "tool"
                  ? <><b className="sl-tool">{line.name}</b>{line.rest ? ` · ${line.rest}` : ""}</>
                  : line.text}
              </span>
            )}
          </span>
        </button>
      </div>
    </li>
  );
}

/** A group's label and how many rows it holds. A group that can fold is a
 *  button: closed it points right, open it has turned. */
export function GroupHead({ group, count, spaced, fold }: {
  group: RailGroup;
  count: number;
  /** Not the first thing in the list: 8px of space above. */
  spaced: boolean;
  fold?: { open: boolean; motion: FoldMode; onToggle: (e: MouseEvent<HTMLButtonElement>) => void };
}) {
  const label = RAIL_GROUP_LABELS[group];
  return (
    <li className={`sl-group-head${spaced ? " spaced" : ""}`}>
      {fold
        ? (
          <button type="button" className="sl-fold-btn" aria-expanded={fold.open} data-motion={fold.motion} onClick={fold.onToggle}>
            <ChevronGlyph />
            <span className="sl-group-label">{label}</span>
            <span className="sl-group-count">{count}</span>
          </button>
        )
        : (
          <>
            <span className="sl-group-label">{label}</span>
            <span className="sl-group-count">{count}</span>
          </>
        )}
    </li>
  );
}

/** "N more", under what is drawn of a group: the way to open the rest. */
export function MoreLine({ count, onToggle }: { count: number; onToggle: (e: MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <li className="sl-more-item">
      <button type="button" className="sl-more" aria-expanded={false} onClick={onToggle}>
        {count} more
        <ChevronGlyph />
      </button>
    </li>
  );
}

/** What a group keeps behind its fold. The space opens as the content fades in
 *  (grid rows 0fr to 1fr, so nothing is measured), and folds the same way a
 *  little quicker; it stays drawn for as long as the fold takes to close. */
export function FoldBody({ open, motion, children }: { open: boolean; motion: FoldMode; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  useEffect(() => {
    if (open || !mounted) return;
    const ms = motion === "instant" ? 0 : tokenMs(motion === "fade" ? "--dur-fast" : "--dur-exit");
    const timer = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(timer);
  }, [open, mounted, motion]);
  if (!mounted) return null;
  return (
    <li className="sl-fold" data-open={open ? "" : undefined} data-motion={motion}>
      <div className="sl-fold-in"><ul className="sl-fold-list">{children}</ul></div>
    </li>
  );
}
