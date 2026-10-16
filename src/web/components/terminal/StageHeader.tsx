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
// "‹" leads with the same promise, back to the board.
import { modelFamily, shortModel } from "../../model-label";
import type { TerminalProvider } from "../../terminal-api";
import type { KeysOwner, StageStatus } from "./stage-model";
import { BackGlyph, CloseGlyph, CollapseGlyph, ExpandGlyph, KeyboardGlyph, ProviderGlyph } from "./stage-icons";

/** ✕'s name and tooltip, word for word (DESIGN.md: never "stop"/"end"/"quit"). */
export const CLOSE_LABEL = "Close — the session keeps running";
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
  takeover: boolean;
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
  const expandLabel = p.expanded ? "Give the board its room back" : "Give the stage the width";
  return (
    <header className="ts-head">
      {p.takeover && (
        <button type="button" className="glyph-btn" aria-label={BACK_LABEL} title={BACK_LABEL} onClick={p.onClose}>
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
        {!p.takeover && (
          <button type="button" className="glyph-btn" aria-label={expandLabel} title={expandLabel} onClick={p.onExpand}>
            {p.expanded ? <CollapseGlyph /> : <ExpandGlyph />}
          </button>
        )}
        <button type="button" className="glyph-btn" data-stage-close aria-label={CLOSE_LABEL} title={CLOSE_LABEL} onClick={p.onClose}>
          <CloseGlyph />
        </button>
      </div>
      <div className="ts-scan" aria-hidden="true" />
    </header>
  );
}
