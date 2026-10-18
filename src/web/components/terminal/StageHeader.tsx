// The stage's header: the node's face, at the size of a stage (v3).
//
// THE SPINE IS THE SESSION'S HUE, the same one its tile on the board wears, so
// which session is on stage is a colour match before it is a word. While the
// agent streams output, a light travels down it toward the terminal — the
// board's in-flight edge grammar — and it is still while the session waits on
// you, because a waiting session is not doing anything. Reduced motion takes
// the light away and leaves the hue.
//
// LINE ONE is the name and the deck's model chip with the provider's glyph in
// it; the chip's accessible name says the provider in words. LINE TWO is the
// face's own sentence ("working · Task 3 subagents running 7m 38s",
// "waiting 6m · Bash git push …") from stage-model.ts, which is where the
// vocabulary is held to one word per state.
//
// THREE CONTROLS AND NO MORE: ⌨ (only while there is a pane to type into),
// ⤢ and ✕ — each the deck's own header glyph (.glyph-btn, panel-glyph.css),
// so their target, focus ring and press are the ones already measured. ✕'s name is the promise the stage keeps — "Close — the session
// keeps running" — never stop, end or quit, because closing the stage stops
// nothing. In the takeover layout (a window too narrow for any navigator) a
// "‹" leads with the same promise, back to the board. ⤢ is full screen where
// full screen hands the session the browser's shortcuts (tab-keys.ts), and is
// drawn in the takeover too, where there is no width to give but that.
import { modelFamily, shortModel } from "../../model-label";
import type { TerminalProvider } from "../../terminal-api";
import type { KeysOwner, StageStatus } from "./stage-model";
import { BackGlyph, CloseGlyph, CollapseGlyph, ExpandGlyph, KeyboardGlyph, ProviderGlyph } from "./stage-icons";

/** ✕'s name and tooltip, word for word (DESIGN.md: never "stop"/"end"/"quit"). */
export const CLOSE_LABEL = "Close — the session keeps running";
/** ✕ and ‹ on a stage with no session on it, where there is nothing to keep. */
export const CLOSE_EMPTY_LABEL = "Close the stage";
export const BACK_EMPTY_LABEL = "Back to the board";
export const BACK_LABEL = "Back to the board — the session keeps running";

export interface StageHeaderProps {
  /** Changes with the session on stage, so its identity arrives afresh —
   *  from the left, out of the board — on every switch. */
  identity: string;
  /** The session's name, or the empty stage's title. */
  name: string;
  provider?: TerminalProvider | null;
  /** The model id, for the chip; absent before the session has reported one. */
  model?: string | null;
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
  /** No session behind the stage — the empty stage, a launch that never
   *  started — so ✕ and ‹ promise nothing about one. */
  nothingRunning?: boolean;
  /** Ask the session for keys, or give them back. */
  onKeys(): void;
  onExpand(): void;
  onClose(): void;
}

/** The chip's words: the model's short name, or the provider's when the
 *  session has not said which model yet. */
export function chipText(provider: TerminalProvider | null | undefined, model: string | null | undefined): string | null {
  if (model) return shortModel(model);
  if (provider === "codex") return "Codex";
  return null;
}

/** What the chip is called aloud: "Claude Code · Opus 5.5". */
export function chipLabel(provider: TerminalProvider | null | undefined, text: string): string {
  const who = provider === "codex" ? "Codex" : "Claude Code";
  return text === who ? who : `${who} · ${text}`;
}

/** ⤢'s name: what a press will do. Full screen is named for what it is for. */
export function expandLabelFor(expanded: boolean, canFull: boolean, full: boolean): string {
  if (expanded) return full ? FULL_LEAVE_LABEL : "Give the board its room back";
  return canFull ? FULL_LABEL : "Give the stage the width";
}

export const FULL_LABEL = "Full screen — Ctrl+W, Ctrl+T and Ctrl+N go to the session";
/** No Esc in it: held where the keyboard lock took, pressed where it did
 *  not, and the browser's own bubble says which. */
export const FULL_LEAVE_LABEL = "Leave full screen";

export default function StageHeader(p: StageHeaderProps) {
  const chip = chipText(p.provider, p.model);
  const { status } = p;
  const detail = !!(status.tool || status.arg || status.seconds);
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
      <span className="ts-spine" aria-hidden="true" />
      <div className="ts-id" key={p.identity}>
        <div className="ts-l1">
          <h2 className="ts-name">{p.name}</h2>
          {chip && (
            <span
              className="model-chip ts-chip"
              data-family={p.model ? modelFamily(p.model) : ""}
              role="img"
              aria-label={chipLabel(p.provider, chip)}
              title={p.provider === "codex" ? "Codex" : "Claude Code"}
            >
              <ProviderGlyph provider={p.provider ?? "claude"} />
              {chip}
            </span>
          )}
        </div>
        {status.state !== "none" && (
          <div className="ts-l2" data-state={status.state}>
            {/* Waiting borrows the deck's own "still asking" emitter, so the
                header pings the way the topbar chip and the card do. */}
            {status.state === "waiting"
              ? <span className="ap-pulse" aria-hidden="true" />
              : <i className="ts-mark" aria-hidden="true" />}
            <span className="ts-phrase">
              {status.phrase}
              {status.emphasis && <> <b>{status.emphasis}</b></>}
            </span>
            {detail && <span className="ts-dot" aria-hidden="true">·</span>}
            {status.tool && <span className="ts-tool">{status.tool}</span>}
            {status.arg && <span className="ts-arg">{status.arg}</span>}
            {status.seconds && <span className="ts-sec">{status.seconds}</span>}
          </div>
        )}
      </div>
      <div className="ts-ctl">
        {p.canType && (
          <>
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
            <span className="ts-ctl-sep" aria-hidden="true" />
          </>
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
      <div className="ts-scan" aria-hidden="true" />
    </header>
  );
}
