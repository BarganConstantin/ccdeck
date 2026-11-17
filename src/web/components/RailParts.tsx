// The pieces the attention rail (SessionList.tsx) is drawn from: the status
// glyph, a row, a group's header, the fold, and the small marks they use. The
// rail's rules are rail-model.ts's and what a row says is rail-row-copy.ts's;
// this only lays them out.
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { Row } from "./SessionList";
import { AlertMark, StateMark } from "./StateMark";
import { stateLabel } from "../agent-copy";
import { RAIL_GROUP_LABEL_MSGS, type RailGroup } from "../rail-model";
import { railFailed, railGlyph, railLine, railTime, rowSpoken, rowTooltip, twinStart, type CompactRowContext, type RailGlyphKind, type RailLine } from "../rail-row-copy";
import { fadeIn, tokenMs } from "../rail-motion";
import type { UsageMeter } from "../rail-usage";
import { FadeFigure, useFillJump } from "./FadeFigure";
import { LevelMark } from "./LevelMark";
import { useT } from "../i18n";
import SessionNameField, { useRenaming } from "./SessionNameField";
import { isRenameKey, type RenameFacts } from "../session-rename";
import { beginDrag, endDrag } from "../split-drag";
import ProviderAvatar from "./ProviderAvatar";
import type { PaneLink } from "../workspace-split";

/** The 14px status glyph. Working turns steadily (pulses with reduced motion);
 *  nothing else moves on its own. Waiting is the alert mark and holds still, because
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
        {kind === "partial" && <StateMark kind="partial" size={14} />}
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

/** The Plus's 14px mark, on the same spec as the close mark. */
export function PlusGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor"
      strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 3v8M3 7h8" />
    </svg>
  );
}

export type FoldMode = "animate" | "fade" | "instant";

export interface RailRowProps {
  compact?: boolean;
  showContext?: boolean;
  context?: CompactRowContext;
  pane?: PaneLink;
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
  /** WORKSPACE: Enter on the row opens the session with the keys in its pane,
   *  where a click leaves them on the list. Absent on the Board, where Enter
   *  is the button's own click. */
  onOpenKeys?: (sessionId: string) => void;
  /** WORKSPACE (internal #102): ⇧↵ on the row opens the session in a pane
   *  beside the one in focus, and the row can be dragged onto a pane. Absent
   *  on the Board, and on a row off the board. */
  onOpenBeside?: (sessionId: string) => void;
  /** A session the deck can name (internal #101): a double click on the row,
   *  or F2 on it, opens the field where its name is. Left out (a row on its
   *  way out), the row only selects. */
  rename?: RenameFacts | null;
}

/** WORKSPACE: a row's keydown. A bare Enter opens the session and takes the
 *  keys into its pane — not the button's click, which leaves them on the list —
 *  and any other key, or a modified or held Enter, is the row's own. Nothing
 *  where the view gives the row no handler: the Board's Enter is the click. */
export function openKeysOnEnter(
  sessionId: string,
  onOpenKeys: ((sessionId: string) => void) | undefined,
): ((e: { key: string; repeat: boolean; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; preventDefault(): void }) => void) | undefined {
  if (!onOpenKeys) return undefined;
  return e => {
    if (e.key !== "Enter" || e.repeat || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    // Not the button's click: Enter here also takes the keys along.
    e.preventDefault();
    onOpenKeys(sessionId);
  };
}

/** WORKSPACE (internal #102): ⇧↵ on a row, unheld and with no other
 *  modifier, opens the session beside the pane in focus. The bare Enter is
 *  openKeysOnEnter's; any other key is the row's own. */
export function openBesideOnShiftEnter(
  sessionId: string,
  onOpenBeside: ((sessionId: string) => void) | undefined,
): ((e: { key: string; repeat: boolean; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; preventDefault(): void }) => boolean) | undefined {
  if (!onOpenBeside) return undefined;
  return e => {
    if (e.key !== "Enter" || !e.shiftKey || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return false;
    e.preventDefault();
    onOpenBeside(sessionId);
    return true;
  };
}

export function RailRow({ row: r, group, now, selected, removed, leaving, landNonce, onSelect, onOpenKeys, onOpenBeside, rename, compact = false, showContext = false, context, pane }: RailRowProps) {
  const t = useT();
  const failed = railFailed(r, group, t);
  // Keep a second line where it explains an action or tells sessions apart.
  // A named task's project fits beside its name; its full prompt stays in the tooltip.
  const twin = compact && context ? context.twin : r.twin;
  const detail = !compact || showContext || context?.detail === "task" || context?.detail === "project" || group === 0 || !!twin || removed || !!failed || r.state === "err" || !r.folder;
  const contextual = compact && context && group !== 0 && !removed && !failed && r.state !== "err" && !r.neverPrompted;
  const projectOnly = contextual && context.detail === "project";
  const line = detail ? contextual && context.text ? { kind: "words" as const, text: context.text } : railLine(r, group) : null;
  // True twins keep their clock even when one is open in a pane.
  const start = twin ? [twinStart(r.startedAt, twin), compact ? context?.idTail : null].filter(Boolean).join(" · ") : null;
  const hiddenTask = compact && (!detail || projectOnly || group === 0 || (r.fullTask && (r.fullTask !== r.task || context?.text !== undefined && !context.text.includes(r.fullTask))))
    ? r.fullTask ?? r.task : null;
  const worded = !!(line || removed || failed);
  const lined = worded || !!start;
  const time = railTime(r, group, now);
  // Done · new: a finished turn you have not looked at, unread until you do.
  // The row's own group, so a row held in place under the pointer shows it too.
  const unread = group === 1;
  const words = <RowWords removed={removed} failed={failed} line={line} />;
  // The highlight is the row's own once it has been handed over, so it plays
  // out its fade; a row drawn again later has no nonce and does not replay it.
  const [lit, setLit] = useState<number | null>(null);
  useEffect(() => { if (landNonce != null) setLit(landNonce); }, [landNonce]);
  // RENAMING (internal #101): the field takes the row's place, its glyph kept,
  // and the row comes back with the keyboard on it.
  const rowRef = useRef<HTMLButtonElement>(null);
  const renaming = useRenaming(rename?.sessionId, rowRef);
  // WORKSPACE (internal #102): the row, dragged onto a pane, opens there.
  const [dragging, setDragging] = useState(false);
  const beside = removed ? undefined : onOpenBeside;
  const besideKey = openBesideOnShiftEnter(r.sessionId, beside);
  if (renaming.on && rename) {
    return (
      <li className="sl-row-item" data-rail-id={r.sessionId}>
        <div className="sl-row-in">
          <div className={`sl-row sl-row-edit${selected ? " selected" : ""}`}>
            <RailGlyph kind={railGlyph(r, group)} />
            <SessionNameField facts={rename} place="row" onDone={renaming.done} />
          </div>
        </div>
      </li>
    );
  }
  return (
    <li className={`sl-row-item${leaving ? " leaving" : ""}`} data-rail-id={r.sessionId}
      ref={el => { if (el) el.inert = leaving; }}>
      {/* F2 and ⇧↵ on the row, caught here as they bubble: the row's own
          keydown is the Workspace's Enter (openKeysOnEnter). */}
      <div
        className="sl-row-in"
        data-dragging={dragging || undefined}
        draggable={beside ? true : undefined}
        onDragStart={beside ? e => {
          beginDrag(e, { kind: "session", id: r.sessionId, name: r.label });
          setDragging(true);
        } : undefined}
        onDragEnd={beside ? () => { setDragging(false); endDrag(); } : undefined}
        onKeyDown={rename || besideKey ? e => {
          if (e.target !== rowRef.current) return;
          if (besideKey?.(e)) return;
          if (rename && isRenameKey(e)) { e.preventDefault(); renaming.start(); }
        } : undefined}
      >
        <button
          ref={rowRef}
          type="button"
          className={`sl-row${selected ? " selected" : ""}${removed ? " removed" : ""}`}
          aria-current={selected ? "true" : undefined}
          aria-keyshortcuts={rename ? "F2" : undefined}
          data-session={r.sessionId}
          data-one-line={!lined || undefined}
          data-compact={compact || undefined}
          data-pane-active={pane?.active || undefined}
          onClick={() => onSelect(r.sessionId)}
          onDoubleClick={rename ? renaming.start : undefined}
          onKeyDown={openKeysOnEnter(r.sessionId, onOpenKeys)}
          title={[rowTooltip(r, removed, compact), pane ? t(pane.active ? "board.stage.split.activePane" : "board.stage.split.paneNumber", { number: pane.number }) : ""].filter(Boolean).join("\n")}
        >
          {/* Once, on the row a jump arrived at; a new nonce is a new element,
              so the fade runs again for the next jump. */}
          {lit != null && <span key={lit} className="sl-land" aria-hidden onAnimationEnd={() => setLit(null)} />}
          {/* The glyph stays hidden and the state beside it is in words, ahead
              of the name, so the row's name says what the glyph shows (#373). */}
          {compact ? <ProviderAvatar provider={r.provider ?? "claude"} /> : <RailGlyph kind={railGlyph(r, group)} />}
          <span className="vis-hidden">{stateLabel(r.state)}</span>
          {/* What the row no longer draws, for a screen reader and for touch,
              where the tooltip is not reached. */}
          <span className="vis-hidden">{rowSpoken(r)}</span>
          {hiddenTask && <span className="vis-hidden">{[!detail || group === 0 ? r.folder : null, hiddenTask].filter(Boolean).join(" · ")}</span>}
          {compact && !start && <span className="vis-hidden">{r.exactHover}</span>}
          <span className="sl-text">
            <span className="sl-line1">
              {/* The name alone: the model that stood after it, in mono, is
                  the Inspector's to say (V4 top-10 #5). */}
              <span className="sl-name">
                <span className="sl-label">{r.label}</span>
                {compact && !detail && r.folder && <span className="sl-project" aria-hidden="true">{r.folder}</span>}
                {/* Said after the name, as the Feedback list says an unread
                    conversation; the dot is for the eye. */}
                {unread && <span className="vis-hidden">{t("shell.feedback.unreadSuffix")}</span>}
              </span>
              {pane && <span className="vis-hidden">{t(pane.active ? "board.stage.split.activePane" : "board.stage.split.paneNumber", { number: pane.number })}</span>}
              {/* The unread dot, in the accent the stripes' doors use for
                  something unread, just before the age (V4 top-10, inbox). */}
              {unread && <span className="sl-unread" aria-hidden />}
              <span className="sl-row-status">
                {time && <span className={`sl-time ${time.tone}`}><span className="vis-hidden">{time.spoken}</span>{time.text}</span>}
                {compact && <RailGlyph kind={railGlyph(r, group)} />}
              </span>
            </span>
            {lined && (start
              ? (
                // A look-alike's line: its words give way first, so the start
                // time at its end stays whole. Not at the line's start any more
                // (V4 top-10, inbox): the line leads with what the session is.
                <span className="sl-line2 sl-twin">
                  {worded && <span className={`sl-words${line?.kind === "tool" ? " mono" : ""}`}>{words}</span>}
                  <span className="sl-start">{worded ? "· " : ""}{start}</span>
                </span>
              )
              : <span className={`sl-line2${line?.kind === "tool" ? " mono" : ""}`}>{words}</span>)}
          </span>
        </button>
      </div>
    </li>
  );
}

/** A row's second line in words, so the name keeps the first line whole: that
 *  the session is off the board (the press on this row does something
 *  different), Done and its failed count, then what it waits on or "folder ·
 *  task". */
function RowWords({ removed, failed, line }: { removed: boolean; failed: string | null; line: RailLine | null }) {
  const t = useT();
  return (
    <>
      {removed && <span className="sl-off">{t("board.rail.offBoard")}</span>}
      {removed && (failed || line) ? " · " : ""}
      {/* Done in the line's own ink, then the count in the warning's: the
          turn finished, and some of its calls did not. */}
      {failed && <>{t("board.card.stateDone")} · <span className="sl-failed">{failed}</span></>}
      {failed && line ? " · " : ""}
      {line && (line.kind === "tool"
        ? <><b className="sl-tool">{line.name}</b>{line.rest ? ` · ${line.rest}` : ""}</>
        : line.text)}
    </>
  );
}

/** Rail / Usage (V4's Figma): the 5-hour window at the rail's foot, one
 *  button that opens the Usage panel (or closes it, as its stripe door does).
 *  Nothing at all without a reading (rail-usage.ts), not an empty box. */
export function RailUsage({ meter, onPress }: { meter: UsageMeter | null; onPress: () => void }) {
  const t = useT();
  const jump = useFillJump(meter?.fill ?? 0);
  if (!meter) return null;
  // A stale reading leads with its age and drops the 7-day figure from the line
  // (the one line has room for two things; the spoken name still has it).
  const second = meter.stale ? [meter.readAgo, meter.reset] : [meter.reset, meter.week];
  const line2 = second.flatMap((part, i) => (part ? [i > 0 && second[0] ? "·" : null, part] : [])).filter(Boolean);
  return (
    <div className="sl-usage">
      <button type="button" className="sl-usage-btn" onClick={onPress} data-stale={meter.stale || undefined} aria-label={meter.spoken}>
        <span className="sl-usage-line1" aria-hidden>
          {meter.name && <span className="sl-usage-name" title={meter.name}>{meter.name}</span>}
          <span className="sl-usage-what">{t("board.rail.fiveHour")}</span>
          {/* The Usage panel's level, mark and word: "⚠ 86% · high" here as there. */}
          <LevelMark tone={meter.level} word="high">
            <FadeFigure className="sl-usage-pct" text={meter.pctText} value={meter.fill} />
          </LevelMark>
        </span>
        <span className="sl-usage-bar" aria-hidden>
          {/* Every part in the one fill colour: a split is shape, 2 apart. */}
          <span className="sl-usage-fill" data-jump={jump || undefined} style={{ width: `${meter.fill}%` }}>
            {meter.segments.map((seg, i) => <span key={i} className="sl-usage-seg" style={{ flexGrow: seg.share, background: meter.color }} />)}
          </span>
          <span className="sl-usage-track" />
        </span>
        {line2.length > 0 && (
          <span className="sl-usage-line2" aria-hidden>
            {line2.map((part, i) => <span key={i}>{part}</span>)}
          </span>
        )}
      </button>
    </div>
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
  const t = useT();
  const label = t(RAIL_GROUP_LABEL_MSGS[group]);
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
