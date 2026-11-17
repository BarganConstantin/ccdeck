// The stage's header: the session's name and what it is doing, on one row (V4).
//
// ONE ROW, ONE STATE GLYPH (Figma V4, "Pane header · Term"). The v3 header was
// two lines tall and wore the session's hue as a spine down its left edge,
// with a light travelling down it while output streamed. V4 takes the spine
// away with the light — the handoff's "the hue spine leaves Workspace
// chrome" — and the session's identity is its name and its state: the same
// 14px glyph its row on the rail wears (stage-icons.tsx, glyphForState), then
// the name. Nothing here moves with the stream any more, so there is no
// travelling light to take away under reduced motion; the working glyph holds
// still where the rail's breathes, because the terminal beside it already shows
// the session at work.
//
// THE NAME HAS THE ROOM, AND ONE STATE WORD (V4 top-10 #7). The header used to
// add the face's whole sentence, "waiting 6m · Bash · git push …", and the name
// shrank with it until a pane 545 wide read "retention …". Now it says at most
// one state, and only one that is not the normal run of a session: "waiting
// 6m", "not attached", "reconnecting…", "starting", "ended 14m ago", "working
// elsewhere" (stateWord). Working, its turn and ready say nothing: the terminal
// below shows that, and the glyph marks it. The word keeps the state's colour
// (waiting is --warn, as the rail's timer is) and never shrinks before the name
// does; the whole sentence is its tooltip, and a screen reader hears it all,
// the normal states too. Sans, as prose is, with tabular figures.
//
// THE MODEL CHIP IS GONE from this header: the rail's row and the agent card
// carry the model, and Figma's Term header draws none. What its accessible name
// said is not lost — the provider is still named, in words, after the session's
// name, for a screen reader.
//
// THE CONTEXT CHIP is at the row's end, before the controls: how full the
// session's window is, as the cards' foot says it (V4 top-10 #7), the ring
// (ContextModal.tsx ContextRing, the donut's own drawing) and the percent
// beside it, "◔ 17%". The whole figure, "170k / 1M · 17% context"
// (context-figure.ts, the Inspector's words), is its tooltip and its name.
// The stage is handed the two numbers by stage-board.ts, from the same place
// the Inspector's Context tab reads them; with no figure, or nothing used yet,
// no chip is drawn rather than an empty one. It is a sibling of the controls,
// not inside them, so it fades in on the morph's own `chip` ramp
// (stage-morph.ts) and not with the controls. It opens nothing, so it is no
// button. In a narrow header (a phone's) it says "17% context" in the
// language's own number format, and the ring gives its room to the word.
//
// THE TEXT SIZE LEADS THEM: Aa, a large A beside a small one, opens −, the
// percent and + for the pane's own zoom (TextSizeControl.tsx), drawn while
// there is a terminal on the stage to size. In the takeover it is two rows of
// the ⋯ menu, Larger text and Smaller text.
//
// THREE CONTROLS AFTER IT AND NO MORE: ⌨ (only while there is a pane to type into),
// ⤢ and ✕ — each the deck's own header glyph (.glyph-btn, panel-glyph.css),
// so their target, focus ring and press are the ones already measured. ✕'s name is the promise the stage keeps — "Close — the session
// keeps running" — never stop, end or quit, because closing the stage stops
// nothing. In the takeover layout (a window too narrow for any navigator) a
// "‹" leads with the same promise, back to the board. ⤢ is full screen where
// full screen hands the session the browser's shortcuts (tab-keys.ts), and is
// drawn in the takeover too, where there is no width to give but that. There
// is no Split. The Chat | Term switch is drawn only when the caller hands in
// `view`, which it does only with a transcript to show (use-screens.ts); the
// deck has none, so the deck's header is the one it always was, and a control
// that would have nothing behind it is not drawn.
import { contextFigure, contextPct, contextPercent, contextTokens } from "../../context-figure";
import type { TerminalProvider } from "../../terminal-api";
import { agentName, type KeysOwner, type StageState, type StageStatus } from "./stage-model";
import { ContextRing } from "../ContextModal";
import { type DragEvent, type RefObject, useState } from "react";
import AnchoredPopover from "../AnchoredPopover";
import SessionNameField, { RenameGlyph } from "../SessionNameField";
import type { RenameFacts } from "../../session-rename";
import { t as tNow, useT } from "../../i18n";
import { formatPercent } from "../../i18n/format";
import { BackGlyph, CloseGlyph, CollapseGlyph, ExpandGlyph, KeyboardGlyph, StageGlyph, glyphForState } from "./stage-icons";
import TextSizeControl, { type TextSizeView } from "./TextSizeControl";
import PaneBadge from "../PaneBadge";
import ProviderAvatar from "../ProviderAvatar";
import type { PaneLink } from "../../workspace-split";
import { canGoLarger, canGoSmaller } from "../../terminal-text-size";

const PANE_MORE_ID = "ts-more";
const PANE_MORE_MENU_ID = "ts-more-menu";

/** A menu row's words. The full-screen item's label carries the shortcut hint
 *  after " — " (it stays on the desktop button's tooltip); the menu shows the
 *  part before it. The close item keeps its whole label: "the session keeps
 *  running" is the promise that closing stops nothing. */
export function menuLabel(item: { id: string; label: string }): string {
  if (item.id === "close") return item.label;
  if (item.label === tNow(FULL_LABEL_MSG)) return tNow("board.stage.fullScreenShort");
  const cut = item.label.indexOf(" — ");
  return cut > 0 ? item.label.slice(0, cut) : item.label;
}

/** On a phone the three 24px controls the frame does not draw (type into the
 *  session, full screen, close) are one ⋯ at a 44 target, and its menu holds
 *  them, each doing what the control did. Hidden at any wider layout, where the
 *  controls themselves are drawn (stage-shell.css). */
function PaneMore({ items }: { items: Array<{ id: string; label: string; run(): void }> }) {
  const t = useT();
  // Open at the first row, or (ArrowUp on the button) at the last, like the
  // dock's More.
  const [menu, setMenu] = useState<"first" | "last" | null>(null);
  const open = menu !== null;
  const more = t("board.rail.more");
  return (
    <>
      <button
        type="button"
        id={PANE_MORE_ID}
        className="glyph-btn ts-more"
        aria-label={more}
        title={more}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? PANE_MORE_MENU_ID : undefined}
        onKeyDown={e => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          setMenu(e.key === "ArrowUp" ? "last" : "first");
        }}
        onClick={() => setMenu(open ? null : "first")}
      >
        <svg className="ts-icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="2.8" cy="7" r="0.7" /><circle cx="7" cy="7" r="0.7" /><circle cx="11.2" cy="7" r="0.7" />
        </svg>
      </button>
      {open && (
        <AnchoredPopover anchorId={PANE_MORE_ID} id={PANE_MORE_MENU_ID} className="ap-pop dock-more-pop" role="menu"
          labelledBy={PANE_MORE_ID} start={menu} onClose={() => setMenu(null)}>
          {items.map(item => (
            <button key={item.id} type="button" role="menuitem" className="ap-menu-item"
              onClick={() => {
                // Focus goes back to the ⋯ before the menu closes, so whatever
                // the item opens or closes gives it back there.
                document.getElementById(PANE_MORE_ID)?.focus();
                setMenu(null);
                window.requestAnimationFrame(item.run);
              }}>
              {menuLabel(item)}
            </button>
          ))}
        </AnchoredPopover>
      )}
    </>
  );
}

/** ✕'s name and tooltip, word for word (DESIGN.md: never "stop"/"end"/"quit"). */
export const CLOSE_LABEL_MSG = "board.stage.closeLabel";
/** ✕ and ‹ on a stage with no session on it, where there is nothing to keep. */
export const CLOSE_EMPTY_LABEL_MSG = "board.stage.closeEmptyLabel";
export const BACK_EMPTY_LABEL_MSG = "board.stage.backEmptyLabel";
export const BACK_LABEL_MSG = "board.stage.backLabel";
/** WORKSPACE: ⤢ is Zoom. Off, it folds the list and the Inspector; on, it
 *  brings them back. Where ⤢ goes full screen it still does (FULL_LABEL_MSG). */
export const ZOOM_LABEL_MSG = "board.stage.zoomLabel";
export const ZOOM_OFF_LABEL_MSG = "board.stage.zoomOffLabel";
/** WORKSPACE: ✕ on a pane whose session is not running, or never started. */
export const PANE_CLOSE_LABEL_MSG = "board.stage.paneCloseLabel";

/** The header's renaming, held by the stage: the session's facts, whether
 *  its field is open, and the pencil focus goes back to when it closes. */
export interface StageRename {
  facts: RenameFacts;
  on: boolean;
  start(): void;
  done(saved: boolean): void;
  back: RefObject<HTMLButtonElement>;
}

export interface StageHeaderProps {
  paneLink?: PaneLink;
  /** Changes with the session on stage, so its identity arrives afresh —
   *  from the left, out of the board — on every switch. */
  identity: string;
  /** The session's name, or the empty stage's title. */
  name: string;
  /** A session the deck can name (internal #101): a pencil after the name, and
   *  a double click on the name, open the field in its place. Left out, the
   *  name is only drawn. The stage holds the renaming (useRenaming), so this
   *  header calls no hook and stays drawable by calling it. */
  rename?: StageRename | null;
  provider?: TerminalProvider | null;
  status: StageStatus;
  keysOwner: KeysOwner;
  /** The release chord as the reader's keyboard labels it (terminal-keys.ts). */
  chordLabel: string;
  /** A live pane to type into: ⌨ is drawn only then. */
  canType: boolean;
  expanded: boolean;
  /** ⤢ is full screen here, the browser's shortcuts the session's (tab-keys.ts). */
  canFull?: boolean;
  /** The deck is in the full screen ⤢ asked for. */
  full?: boolean;
  takeover: boolean;
  /** How much of the session's context window is used, for the chip at the
   *  row's end; none (or nothing used) draws no chip. */
  context?: { used: number; window: number } | null;
  /** No session behind the stage — the empty stage, a launch that never
   *  started — so ✕ and ‹ promise nothing about one. */
  nothingRunning?: boolean;
  /** WORKSPACE: the pane fills its cell. `empty` is the pane with nothing in
   *  it, whose one control is ✕, back to the board; `pane` has ⤢ as Zoom
   *  (`expanded` is zoomed) and ✕ emptying the pane. Left out on the Board. */
  workspace?: "pane" | "empty";
  /** Chat | Term: which one the pane shows. Left out, no switch is drawn. It is
   *  the deck's own View switch (workspace.css) in the header, so it costs no
   *  stylesheet of Chat's. */
  view?: { current: "chat" | "term"; onChange(next: "chat" | "term"): void };
  /** The pane's text size and its −/+; left out, no Aa is drawn (no terminal
   *  on the stage to size). */
  textSize?: TextSizeView;
  /** WORKSPACE with panes side by side (internal #102): ⤢ fills the Workspace
   *  with this pane and gives the others their room back (`expanded` is
   *  filled), never full screen. */
  split?: boolean;
  /** A drag from the header moves the pane (internal #102). Not while the
   *  name is being edited, nor from a button. */
  onDragHead?(e: DragEvent<HTMLElement>): void;
  /** Ask the session for keys, or give them back. */
  onKeys(): void;
  onExpand(): void;
  onClose(): void;
}

/** The part of the sentence after the state: the tool, its argument and how
 *  long it has run, "Bash · git push -u origin …", or null when there is none. */
export function metaRest(status: StageStatus): string | null {
  const parts = [status.tool, status.arg, status.seconds].filter((s): s is string => !!s);
  return parts.length ? parts.join(" · ") : null;
}

/** The normal run of a session: at work, at its prompt, or waiting for its
 *  first one. The terminal shows these and the glyph marks them, so the
 *  header draws no word for them. */
const NORMAL_STATES: ReadonlySet<StageState> = new Set<StageState>(["working", "idle", "ready", "none"]);

/** The one state word the header draws, "waiting 6m" or "not attached"; null
 *  for a normal state. */
export function stateWord(status: StageStatus): string | null {
  if (NORMAL_STATES.has(status.state) || !status.phrase) return null;
  return status.emphasis ? `${status.phrase} ${status.emphasis}` : status.phrase;
}

/** The whole sentence, "waiting 6m · Bash · git push": the state word's
 *  tooltip, and what a screen reader hears whatever the state. */
export function stateSentence(status: StageStatus): string {
  const head = status.emphasis ? `${status.phrase} ${status.emphasis}` : status.phrase;
  const rest = metaRest(status);
  return rest ? `${head} · ${rest}` : head;
}

/** ⤢'s name: what a press will do. Full screen is named for what it is for. */
export function expandLabelFor(expanded: boolean, canFull: boolean, full: boolean): string {
  if (expanded) return full ? tNow(FULL_LEAVE_LABEL_MSG) : tNow("board.stage.giveRoomBack");
  return canFull ? tNow(FULL_LABEL_MSG) : tNow("board.stage.giveWidth");
}

/** WORKSPACE ⤢'s name: Zoom, or full screen where that is what it does. */
export function zoomLabelFor(zoomed: boolean, canFull: boolean, full: boolean): string {
  if (zoomed) return full ? tNow(FULL_LEAVE_LABEL_MSG) : tNow(ZOOM_OFF_LABEL_MSG);
  return canFull ? tNow(FULL_LABEL_MSG) : tNow(ZOOM_LABEL_MSG);
}

export const FULL_LABEL_MSG = "board.stage.fullLabel";
/** ⤢ in a split Workspace (internal #102): what a press will do. */
export const SPLIT_MAX_LABEL_MSG = "board.stage.split.maximize";
export const SPLIT_RESTORE_LABEL_MSG = "board.stage.split.restore";
/** No Esc in it: held where the keyboard lock took, pressed where it did
 *  not, and the browser's own bubble says which. */
export const FULL_LEAVE_LABEL_MSG = "board.stage.fullLeaveLabel";

/** The chip's figure, or null when there is none to say. */
export function contextChipText(context: StageHeaderProps["context"]): string | null {
  return context && context.used > 0 ? contextFigure(context.used, context.window) : null;
}

export default function StageHeader(p: StageHeaderProps) {
  const t = useT();
  const { status } = p;
  // One reading for the chip: its ring and its percent are the same fill. With
  // no window known there is no ring, and the used tokens are the figure.
  const used = p.context && p.context.used > 0 ? p.context : null;
  const windowed = used != null && used.window > 0;
  const ctxFigure = used ? (windowed ? formatPercent(contextPercent(used.used, used.window)) : contextTokens(used.used)) : "";
  const ctxName = used ? t("board.stage.contextShort", { pct: contextFigure(used.used, used.window) }) : "";
  const glyph = glyphForState(status.state);
  const word = stateWord(status);
  const rest = metaRest(status);
  const pane = p.keysOwner === "pane";
  // One name with aria-pressed saying which way it is, rather than a name
  // that flips: a screen reader then hears "Type into the session, pressed".
  // The tooltip, for the pointer, says what a press will do.
  const keysLabel = t("board.stage.typeInto");
  const keysTip = pane ? t("board.stage.keysBack", { chord: p.chordLabel }) : t("board.stage.typeIntoTip", { label: keysLabel });
  const zoom = p.workspace === "pane";
  const expandLabel = p.split ? t(p.expanded ? SPLIT_RESTORE_LABEL_MSG : SPLIT_MAX_LABEL_MSG)
    : zoom ? zoomLabelFor(p.expanded, p.canFull === true, p.full === true) : expandLabelFor(p.expanded, p.canFull === true, p.full === true);
  const closeLabel = t(p.workspace === "empty" ? BACK_EMPTY_LABEL_MSG
    : p.workspace === "pane" ? (p.nothingRunning ? PANE_CLOSE_LABEL_MSG : CLOSE_LABEL_MSG)
      : p.nothingRunning ? CLOSE_EMPTY_LABEL_MSG : CLOSE_LABEL_MSG);
  const backLabel = t(p.nothingRunning ? BACK_EMPTY_LABEL_MSG : BACK_LABEL_MSG);
  // RENAMING (internal #101): the field takes the name's place for the session
  // it opened on; a switch to another session closes it unsaved.
  const renaming = p.rename ?? null;
  const renameLabel = t("board.rename.action");
  return (
    <header
      className="ts-head"
      draggable={p.onDragHead && !renaming?.on ? true : undefined}
      onDragStart={p.onDragHead && !renaming?.on ? e => {
        // A press on a control is that control's, never the start of a move.
        if ((e.target as Element | null)?.closest?.("button, input, [role=menu]")) { e.preventDefault(); return; }
        p.onDragHead?.(e);
      } : undefined}
    >
      {p.takeover && (
        <button type="button" className="glyph-btn" aria-label={backLabel} title={backLabel} onClick={p.onClose}>
          <BackGlyph />
        </button>
      )}
      <div className="ts-id" key={p.identity}>
        {p.paneLink && <PaneBadge pane={p.paneLink} />}
        {p.workspace && p.provider ? <ProviderAvatar provider={p.provider} /> : glyph && <StageGlyph kind={glyph} />}
        {renaming?.on
          ? <SessionNameField facts={renaming.facts} place="header" onDone={renaming.done} />
          : <h2 className="ts-name" data-renamable={renaming ? "" : undefined} onDoubleClick={renaming?.start}>{p.name}</h2>}
        {/* The pencil: on a phone the ⋯ menu holds Rename instead. */}
        {renaming && !renaming.on && (
          <button ref={renaming.back} type="button" className="glyph-btn ts-rename"
            aria-label={renameLabel} title={t("board.rename.tip")} onClick={renaming.start}>
            <RenameGlyph />
          </button>
        )}
        {/* The provider, in words, where the model chip used to say it. */}
        {p.provider && !p.workspace && <span className="vis-hidden">{agentName(p.provider)}</span>}
        {/* One state word, only where the state is not the normal one; the
            rest of the sentence in its tooltip and for a screen reader. */}
        {word ? (
          <div className="ts-meta" data-state={status.state} title={rest ? stateSentence(status) : undefined}>
            <span className="ts-meta-state">{word}</span>
            {rest && <span className="vis-hidden"> · {rest}</span>}
          </div>
        ) : status.phrase ? <span className="vis-hidden">{stateSentence(status)}</span> : null}
      </div>
      {used && (
        <span className="ts-ctxchip" role="img" aria-label={ctxName} title={ctxName}>
          {windowed && <ContextRing fill={contextPct(used.used, used.window) / 100} />}
          <span className="ts-ctxpct">{ctxFigure}</span>
          {/* A header too narrow for the ring (a phone's) says the figure with
              what it is a figure of, "17% context", where a bare "17 %" said
              nothing. The chip's name is the whole figure either way. */}
          <span className="ts-ctxshort">{t("board.stage.contextShort", { pct: ctxFigure })}</span>
        </span>
      )}
      {p.view && (
        <div className="view-switch" role="group" aria-label={t("board.stage.view")}>
          {(["chat", "term"] as const).map(v => (
            <button key={v} type="button" className="view-opt" aria-pressed={p.view!.current === v} onClick={() => p.view!.onChange(v)}>
              {v === "chat" ? t("board.stage.viewChat") : t("board.stage.viewTerm")}
            </button>
          ))}
        </div>
      )}
      {p.takeover && (
        <PaneMore items={[
          ...(renaming ? [{ id: "rename", label: renameLabel, run: renaming.start }] : []),
          ...(p.canType ? [{ id: "keys", label: keysLabel, run: p.onKeys }] : []),
          ...(p.canFull && p.workspace !== "empty" ? [{ id: "expand", label: expandLabel, run: p.onExpand }] : []),
          // The size is set once per screen, so it follows the actions used on every visit.
          ...(p.textSize && canGoLarger(p.textSize.step) ? [{ id: "text-larger", label: t("board.stage.textLarger"), run: () => p.textSize?.onStep("larger") }] : []),
          ...(p.textSize && canGoSmaller(p.textSize.step) ? [{ id: "text-smaller", label: t("board.stage.textSmaller"), run: () => p.textSize?.onStep("smaller") }] : []),
          { id: "close", label: closeLabel, run: p.onClose },
        ]} />
      )}
      <div className="ts-ctl">
        <div className="ts-tools">
          {p.textSize && <TextSizeControl size={p.textSize} />}
          {p.canType && (
            <button
              type="button"
              className="glyph-btn"
              aria-pressed={pane}
              aria-label={keysLabel}
              aria-keyshortcuts={pane ? "Control+Shift+X" : undefined}
              title={keysTip}
              // Pressing it must not move focus first: the textarea's blur
              // would hand the keys to the board before the click lands, and
              // the click would then read "board" and put them back.
              onMouseDown={e => e.preventDefault()}
              onClick={p.onKeys}
            >
              <KeyboardGlyph />
            </button>
          )}
          {/* No width to give in the takeover — but full screen still gives
              the browser's shortcuts, and a bigger window. */}
          {(!p.takeover || p.canFull) && p.workspace !== "empty" && (
            <button
              type="button"
              className="glyph-btn"
              aria-label={expandLabel}
              title={expandLabel}
              // Zoom is a state, so it reports one; the glyph stays ⤢ and the
              // button is filled while it is on (terminal-stage.css).
              aria-pressed={zoom ? p.expanded : undefined}
              data-zoom={zoom || undefined}
              // Typing carries on across it: the pane keeps the keys it had.
              onMouseDown={e => e.preventDefault()}
              onClick={p.onExpand}
            >
              {p.expanded && !zoom ? <CollapseGlyph /> : <ExpandGlyph />}
            </button>
          )}
          <button type="button" className="glyph-btn" data-stage-close aria-label={closeLabel} title={closeLabel} onClick={p.onClose}>
            <CloseGlyph />
          </button>
        </div>
      </div>
      <div className="ts-scan" aria-hidden="true" />
    </header>
  );
}
