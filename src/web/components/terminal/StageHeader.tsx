// The stage's header: the session's name and what it is doing, on one row (V4).
//
// ONE ROW, ONE STATE GLYPH (Figma V4, "Pane header · Term"). The v3 header was
// two lines tall and wore the session's hue as a spine down its left edge,
// with a light travelling down it while output streamed. V4 takes the spine
// away with the light — the handoff's "the hue spine leaves Workspace
// chrome" — and the session's identity is its name and its state: the same
// 14px glyph its row on the rail wears (stage-icons.tsx, glyphForState), then
// the name, then the face's own sentence in mono, "waiting 6m · Bash · git
// push …", from stage-model.ts, which is where the vocabulary is held to one
// word per state. The state part takes the state's colour (waiting is --warn,
// as the rail's timer is); the tool and its argument are --muted and give way
// first, with an ellipsis, when the row is short. Nothing here moves with the
// stream any more, so there is no travelling light to take away under reduced
// motion; the working glyph holds still where the rail's breathes, because the
// terminal beside it already shows the session at work.
//
// THE MODEL CHIP IS GONE from this header: the rail's row and the agent card
// carry the model, and Figma's Term header draws none. What its accessible name
// said is not lost — the provider is still named, in words, after the session's
// name, for a screen reader.
//
// THE CONTEXT CHIP is at the row's end, before the controls: how full the
// session's window is, "129k / 200k · 65%" (context-figure.ts, the Inspector's
// words) with a 4px bar of the same percent. The stage is handed the two
// numbers by stage-board.ts, from the same place the Inspector's Context tab
// reads them; with no figure, or nothing used yet, no chip is drawn rather than
// an empty one. It is a sibling of the controls, not inside them, so it fades in
// on the morph's own `chip` ramp (stage-morph.ts) and not with the controls.
//
// THREE CONTROLS AND NO MORE: ⌨ (only while there is a pane to type into),
// ⤢ and ✕ — each the deck's own header glyph (.glyph-btn, panel-glyph.css),
// so their target, focus ring and press are the ones already measured. ✕'s name is the promise the stage keeps — "Close — the session
// keeps running" — never stop, end or quit, because closing the stage stops
// nothing. In the takeover layout (a window too narrow for any navigator) a
// "‹" leads with the same promise, back to the board. ⤢ is full screen where
// full screen hands the session the browser's shortcuts (tab-keys.ts), and is
// drawn in the takeover too, where there is no width to give but that. There
// is no Chat/Term toggle and no Split: Chat is a later phase behind a flag
// that is off, and a control for either would be a dead one.
import { contextFigure, contextPercent } from "../../context-figure";
import type { TerminalProvider } from "../../terminal-api";
import { agentName, type KeysOwner, type StageStatus } from "./stage-model";
import { BackGlyph, CloseGlyph, CollapseGlyph, ExpandGlyph, KeyboardGlyph, StageGlyph, glyphForState } from "./stage-icons";

/** ✕'s name and tooltip, word for word (DESIGN.md: never "stop"/"end"/"quit"). */
export const CLOSE_LABEL = "Close — the session keeps running";
/** ✕ and ‹ on a stage with no session on it, where there is nothing to keep. */
export const CLOSE_EMPTY_LABEL = "Close the Command Panel";
export const BACK_EMPTY_LABEL = "Back to the board";
export const BACK_LABEL = "Back to the board — the session keeps running";

export interface StageHeaderProps {
  /** Changes with the session on stage, so its identity arrives afresh —
   *  from the left, out of the board — on every switch. */
  identity: string;
  /** The session's name, or the empty stage's title. */
  name: string;
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

/** ⤢'s name: what a press will do. Full screen is named for what it is for. */
export function expandLabelFor(expanded: boolean, canFull: boolean, full: boolean): string {
  if (expanded) return full ? FULL_LEAVE_LABEL : "Give the board its room back";
  return canFull ? FULL_LABEL : "Give the Command Panel the width";
}

export const FULL_LABEL = "Full screen — Ctrl+W, Ctrl+T and Ctrl+N go to the session";
/** No Esc in it: held where the keyboard lock took, pressed where it did
 *  not, and the browser's own bubble says which. */
export const FULL_LEAVE_LABEL = "Leave full screen";

/** The chip's figure, or null when there is none to say. */
export function contextChipText(context: StageHeaderProps["context"]): string | null {
  return context && context.used > 0 ? contextFigure(context.used, context.window) : null;
}

export default function StageHeader(p: StageHeaderProps) {
  const { status } = p;
  const chip = contextChipText(p.context);
  const glyph = glyphForState(status.state);
  const rest = metaRest(status);
  const pane = p.keysOwner === "pane";
  // One name with aria-pressed saying which way it is, rather than a name
  // that flips: a screen reader then hears "Type into the session, pressed".
  // The tooltip, for the pointer, says what a press will do.
  const keysLabel = "Type into the session";
  const keysTip = pane ? `Give the keys back to the board (${p.chordLabel})` : `${keysLabel} (↵)`;
  const expandLabel = expandLabelFor(p.expanded, p.canFull === true, p.full === true);
  const closeLabel = p.nothingRunning ? CLOSE_EMPTY_LABEL : CLOSE_LABEL;
  const backLabel = p.nothingRunning ? BACK_EMPTY_LABEL : BACK_LABEL;
  return (
    <header className="ts-head">
      {p.takeover && (
        <button type="button" className="glyph-btn" aria-label={backLabel} title={backLabel} onClick={p.onClose}>
          <BackGlyph />
        </button>
      )}
      <div className="ts-id" key={p.identity}>
        {glyph && <StageGlyph kind={glyph} />}
        <h2 className="ts-name">{p.name}</h2>
        {/* The provider, in words, where the model chip used to say it. */}
        {p.provider && <span className="vis-hidden">{agentName(p.provider)}</span>}
        {status.state !== "none" && (
          <div className="ts-meta" data-state={status.state}>
            <span className="ts-meta-state">
              {status.emphasis ? `${status.phrase} ${status.emphasis}` : status.phrase}
            </span>
            {rest && <span className="ts-meta-rest">· {rest}</span>}
          </div>
        )}
      </div>
      {chip && p.context && (
        <span className="ts-ctxchip" title="Context window">
          <span className="vis-hidden">Context </span>
          {chip}
          <span className="ts-ctxbar" aria-hidden="true"><i style={{ width: `${Math.min(100, contextPercent(p.context.used, p.context.window))}%` }} /></span>
        </span>
      )}
      <div className="ts-ctl">
        <div className="ts-tools">
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
          {(!p.takeover || p.canFull) && (
            <button
              type="button"
              className="glyph-btn"
              aria-label={expandLabel}
              title={expandLabel}
              // Typing carries on across it: the pane keeps the keys it had.
              onMouseDown={e => e.preventDefault()}
              onClick={p.onExpand}
            >
              {p.expanded ? <CollapseGlyph /> : <ExpandGlyph />}
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
