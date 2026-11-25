// The keys bar: 32px under the terminal that always says who has the keyboard,
// and runs the asks (V4; 36px in v3).
//
// ONE OWNER, ALWAYS VISIBLE. A pane that takes every key — Escape included —
// is a keyboard trap unless the way out is on screen, so the bar's left side
// is never empty: "Keys on the board" with the board's own keys, or "Typing
// into paycore" with the release chord. The sentence is what a screen reader
// hears, once, when it lands on the bar (it is not a live region — the owner
// changes on every click into the pane, and #372 is what announcing that
// would be); the words alone say who has the keys, in the label's weight of
// colour: --text-secondary for the board, --text for the pane.
//
// NO GLYPH LEADS THE BAR (Figma V4, "Keys bar"). v3 drew the owner as a 7px
// lamp and the first V4 pass as the rail's state glyph; the drawn bar has
// neither, the label does it. The one glyph left is where a state is told
// about another session: Waiting for an ask, Done for an answer. The keys are
// the kit's Kbd (components/Kbd.tsx) as it is, and the buttons that are
// behaviour (type here, Next ask, Answer) are drawn as plain text.
//
// THE ASKS LIVE WHERE THE EYES ALREADY ARE. Answering a permission prompt
// means looking at the last rows of the terminal; the next ask is offered
// right under them rather than in the header 700px up. The run's state comes
// from the integrator (use-asks), as data: this bar draws it and calls back.
// It never switches session by itself — a stray "1" must never approve
// something nobody has read.
//
// WHEN THE SESSION HAS ENDED the bar becomes the end bar: the sentence that
// says the frame is frozen, and "Reopen here". A pane someone
// else took away gets the same bar with "Attach again". That is the phone's
// (640 and under), where the bar stays in the pane. Wider, the bar is drawn in
// the window's status bar, far from the pane and not at all for a split's
// other pane, so the stage hands the end action to the pane's own header
// instead (StageHeader `end`, TerminalStage endPlacement) and this bar gets
// none.
//
// NO PANE, NO BAR. The empty pane and the cards that say why there is nothing
// to type into (an error, a session that cannot be attached, tmux missing)
// have no keys to name; the bar is hidden, not removed, because the stage
// measures it by element (TerminalStage's useDrawnHeight) and a new element
// would never be measured.
//
// Chat can supply its composer in this same measured footer. Session end,
// notice and ask/host actions remain reachable beneath the input.
import { RELEASE_CHORD_SPOKEN_MSG } from "../../terminal-keys";
import { RECONNECT_NOTE_MSG, type KeysOwner } from "./stage-model";
import { Kbd } from "../Kbd";
import { t as tNow, useT } from "../../i18n";
import { useLayoutEffect, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { StageGlyph } from "./stage-icons";

/** One run through the waiting sessions, as the integrator's use-asks has it. */
export interface AsksView {
  /** "1 of 2", while the stage is on an ask of the run. */
  position?: { index: number; total: number } | null;
  /** The session just answered: "✓ paycore resumed". */
  resumed?: string | null;
  /** The next ask, offered as a button. `waited` is "2m". */
  next?: { name: string; waited: string; tool?: string | null } | null;
  /** Every ask answered. The integrator takes it away after a moment. */
  clear?: boolean;
}

/** A session that started waiting while the stage was on another one. */
export interface ArrivalView {
  name: string;
  tool?: string | null;
}

/** Sessions on an older session host (Windows): the line and Review. */
export interface HostsLineView {
  said: string;
  /** Null while there is nothing to review: the line is the engine's
   *  refusal of new sessions alone. */
  onReview?: (() => void) | null;
}

/** The end bar's sentence and its one action. */
export interface EndView {
  sentence: string;
  /** The sentence's tooltip: the full path of a folder it names by name. */
  where?: string;
  /** The sentence changes where the reader is looking (a Check again on a
   *  folder still gone): a polite live region. */
  live?: boolean;
  action: string;
  /** The action's tooltip, when it says more than the sentence: what
   *  Choose folder… does with the conversation (folder-gone). */
  title?: string;
  /** The action's id, for a popover hung off it (Choose folder…'s New session). */
  id?: string;
  busy?: boolean;
  onAction(): void;
  /** A second way on, after the action: a new session in the same folder,
   *  when Reopen here could not resume the session, or Check again on a
   *  folder that was gone (TerminalStage endView). */
  alt?: { action: string; title?: string; busy?: boolean; onAction(): void };
  /** The way back, last and plain: Cancel on a folder that was gone, which
   *  puts the ended pane back as it was (TerminalStage endView). */
  back?: { action: string; onAction(): void };
}

export interface KeysBarProps {
  owner: KeysOwner;
  /** The session's name, for "Typing into …". */
  name: string;
  /** The release chord as the reader's keyboard labels it (terminal-keys.ts). */
  chordLabel: string;
  /** A live pane: "type here" is offered only then. */
  canType: boolean;
  /** At least one session is waiting: "n next ask" is a key worth showing. */
  asksWaiting: boolean;
  /** The stage has the whole view: no navigator, so no j/k to step through. */
  takeover?: boolean;
  /** The pane's connection is being made again: keys typed now go nowhere. */
  reconnecting?: boolean;
  /** Something the pane just refused (a paste too big to send), for a few
   *  seconds in place of the hints. */
  notice?: string | null;
  firstRun: boolean;
  /** The pane is one of Workspace's: its ✕ empties the pane (and on the empty
   *  pane leaves for the Board), where the Board's closes the Command Panel,
   *  and the keys go back to "the deck", as the status bar says, not to a
   *  board that is not in view. */
  workspace?: boolean;
  /** The Workspace pane holds tabs: its ✕ closes the tab on show. */
  tabbed?: boolean;
  /** Only the focused split pane contributes to the shared status bar. */
  primary?: boolean;
  /** No pane to type into (nothing open, an error, a session that cannot be
   *  attached, tmux missing, or a pane still being attached or started with
   *  nothing on screen yet): the bar says nothing and is not drawn, unless it
   *  carries the older hosts' line. */
  paneless?: boolean;
  /** Chat is on the pane: the keys go to Term, which a press shows first. */
  chat?: boolean;
  /** Direct reply input, using the stage's existing writable connection. */
  composer?: ReactNode;
  /** Chat is on a pane that cannot take keys (a card stands for it in Term):
   *  the bar says so, with the way to that card. */
  chatCannotType?: boolean;
  onShowTerm?(): void;
  onFirstRunDone(): void;
  onTypeHere(): void;
  end?: EndView | null;
  asks?: AsksView | null;
  arrival?: ArrivalView | null;
  onNextAsk?(): void;
  onAnswerArrival?(): void;
  /** Sessions on an older session host, said where an ask would be when
   *  there is none. */
  hosts?: HostsLineView | null;
}

/** What ✕ does where the first-run line is said, and so what the line says it
 *  does: the Board's closes the Command Panel, a Workspace pane's empties the
 *  pane, and a pane's with tabs closes the tab on show. None ends the
 *  session. */
export function firstRunClause(workspace: boolean, tabbed = false): string {
  if (!workspace) return tNow("board.keys.firstBoard");
  return tabbed ? tNow("board.keys.firstWorkspaceTab") : tNow("board.keys.firstWorkspace");
}

/** Whether the asks' slot has anything to draw. */
export function asksSpeak(asks: AsksView | null | undefined): boolean {
  return !!asks && (!!asks.position || !!asks.next || !!asks.clear);
}

/** The run, in words: "Asks 2 of 3" while the stage is on one of them, the
 *  answered session and the next ask after it. (V4 draws no segment track: the
 *  count says it.) */
export function AsksTrack({ asks, onNextAsk }: { asks: AsksView; onNextAsk?(): void }) {
  const t = useT();
  if (asks.position) {
    return (
      <div className="ts-asks">
        <span className="ts-asks-label">{t("board.keys.asks")}</span>
        <span className="ts-count">{t("board.keys.position", { index: asks.position.index + 1, total: asks.position.total })}</span>
      </div>
    );
  }
  if (asks.next) {
    const { next } = asks;
    return (
      <div className="ts-asks">
        {asks.resumed && <span className="ts-resumed"><StageGlyph kind="done" />{t("board.keys.resumed", { name: asks.resumed })}</span>}
        <button
          type="button"
          className="btn ts-next ts-plain"
          aria-label={next.tool
            ? t("board.keys.nextAskLabelTool", { name: next.name, waited: next.waited, tool: next.tool })
            : t("board.keys.nextAskLabel", { name: next.name, waited: next.waited })}
          onClick={onNextAsk}
        >
          {t("board.keys.nextAsk")} <span className="ts-next-name">{next.name}</span> {next.waited}
        </button>
      </div>
    );
  }
  if (asks.clear) return <div className="ts-asks" data-clear><span className="ts-resumed"><StageGlyph kind="done" />{t("board.keys.noMoreAsks")}</span></div>;
  return null;
}

/** "1 session still runs on an older session host.  [Review]" */
export function HostsNote({ hosts }: { hosts: HostsLineView }) {
  const t = useT();
  return (
    <div className="ts-asks ts-hosts">
      <span className="ts-hosts-said" title={hosts.said}>{hosts.said}</span>
      {hosts.onReview && <button type="button" className="btn" onClick={hosts.onReview}>{t("board.keys.review")}</button>}
    </div>
  );
}

/** "[waiting] paycore asks · Bash  [n] Answer" — said once, quietly, in the bar. */
export function ArrivalNote({ arrival, onAnswer }: { arrival: ArrivalView; onAnswer?(): void }) {
  const t = useT();
  return (
    <div className="ts-asks">
      <span className="ts-arrival">
        <StageGlyph kind="waiting" />
        {arrival.tool ? t("board.keys.arrivalTool", { name: arrival.name, tool: arrival.tool }) : t("board.keys.arrival", { name: arrival.name })}
      </span>
      <button type="button" className="btn ts-next ts-plain" aria-label={t("board.keys.answerLabel", { name: arrival.name })} onClick={onAnswer}>
        <Kbd>n</Kbd> {t("board.keys.answer")}
      </button>
    </div>
  );
}

/** The window's status bar slot the keys bar is drawn in
 *  (#ccdeck-stage-status), or null where the shell has none (a phone, 640 and
 *  under) and the bar stays in the pane. The stage asks it too: with the bar
 *  out in the status bar, an ended session's action goes to the pane's header. */
export function useStageStatusSlot(): HTMLElement | null {
  const [statusSlot, setStatusSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    // Guarded: the suite runs the stage with no document, or one that knows
    // only its focus, and there is no slot there (the phone's answer).
    if (typeof document === "undefined") return;
    const read = () => setStatusSlot(document.getElementById?.("ccdeck-stage-status") ?? null);
    read();
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(read);
    // The shell adds/removes its footer at phone widths. Ignore terminal DOM.
    observer.observe(document.querySelector(".app") ?? document.body, { childList: true });
    return () => observer.disconnect();
  }, []);
  return statusSlot;
}

function KeysBarPlacement({ children, visible }: { children: ReactElement; visible: boolean }) {
  const statusSlot = useStageStatusSlot();
  if (!statusSlot) return children;
  return visible ? createPortal(<div {...children.props} />, statusSlot) : null;
}

export default function KeysBar(p: KeysBarProps) {
  const t = useT();
  let right = null;
  // With something on the right, the left keeps only who has the keys: the
  // other hints go (V4's Ask, Asks, Resumed, No more asks and hosts bars).
  let lean = false;
  if (!p.end && p.asks) { right = <AsksTrack asks={p.asks} onNextAsk={p.onNextAsk} />; lean = asksSpeak(p.asks); }
  else if (!p.end && p.arrival) { right = <ArrivalNote arrival={p.arrival} onAnswer={p.onAnswerArrival} />; lean = true; }
  // An ask outranks it; an end bar does not — it is the same note on any
  // pane, and a refused launch is where it is needed most.
  else if (p.hosts) { right = <HostsNote hosts={p.hosts} />; lean = true; }
  // Workspace has no board in view: its strip names the place the keys go
  // back to as the status bar under it does, "the deck", in the same words.
  const deck = p.workspace === true;
  let left;
  if (p.end) {
    left = (
      <div className="ts-keys" data-owner="none" data-split>
        <span className="ts-end" title={p.end.where} role={p.end.live ? "status" : undefined}>{p.end.sentence}</span>
        <button type="button" id={p.end.id} className="btn" title={p.end.title} aria-busy={p.end.busy || undefined} data-stage-land onClick={p.end.onAction}>{p.end.action}</button>
        {p.end.alt && <button type="button" className="btn" title={p.end.alt.title} aria-busy={p.end.alt.busy || undefined} onClick={p.end.alt.onAction}>{p.end.alt.action}</button>}
        {p.end.back && <button type="button" className="btn ts-plain" onClick={p.end.back.onAction}>{p.end.back.action}</button>}
      </div>
    );
  } else if (p.notice) {
    left = (
      <div className="ts-keys" data-owner="none">
        <span className="ts-end">{p.notice}</span>
      </div>
    );
  } else if (p.chatCannotType) {
    left = (
      <div className="ts-keys ts-chat-handoff" data-owner="none" data-split>
        <span className="ts-chat-reply-note">{t("board.chat.replyInTerm")}</span>
        <button type="button" className="btn" onClick={p.onShowTerm}>{t("board.chat.showTerm")}</button>
      </div>
    );
  } else if (p.chat && p.canType && !lean) {
    left = (
      <div className="ts-keys ts-chat-handoff" data-owner="board" data-split>
        <span className="ts-chat-reply-note">{t("board.chat.replyInTerm")}</span>
        <button type="button" className="btn primary" onClick={p.onTypeHere}>{t("board.chat.continueInTerm")}</button>
      </div>
    );
  } else if (p.firstRun && p.canType && !p.chat) {
    // Not on Chat: the line is about the terminal ("Typing goes to the
    // session"), and on Chat the keys are with the deck, so there the bar
    // names Term instead; the line comes back on Term until Got it.
    // The first-run line lives here so it does not cost the terminal a row.
    // On a stage too narrow for it on one line (a phone) it wraps, and Got it
    // stays in reach; only a third line, on the narrowest screens, grows the
    // bar, and then the rows are fitted above it until Got it (the stage
    // hands its bar's height to stage-geometry.ts). A fingertip has no Esc,
    // so the clause that names it goes whole under a coarse pointer; ✕, the
    // header's control, stays.
    // The clause names the way out with the warning: while the line is up it
    // stands in for "Typing into …" and its chord, and the status bar's own
    // hints are hidden behind it, so the release chord is said here or nowhere.
    left = (
      <div className="ts-keys" data-owner={p.owner} data-split>
        <span className="ts-first">{t("board.keys.typingGoes")}<span className="ts-first-keys">{t("board.keys.escIncluded", { chord: p.chordLabel })}</span>. {firstRunClause(p.workspace === true, p.tabbed === true)}</span>
        <button type="button" className="btn" onClick={p.onFirstRunDone}>{t("board.keys.gotIt")}</button>
      </div>
    );
  } else if (p.owner === "pane" && p.reconnecting) {
    // The pane still has the focus, but nothing typed reaches the session
    // until the connection is back; "Typing into" would be a promise the
    // stage cannot keep. The whole sentence is the warning's colour.
    left = (
      <div className="ts-keys" data-owner="none">
        <span className="ts-reconnecting" title={t("board.keys.reconnecting", { name: p.name, note: t(RECONNECT_NOTE_MSG) })}>{t("board.keys.reconnecting", { name: p.name, note: t(RECONNECT_NOTE_MSG) })}</span>
      </div>
    );
  } else if (p.owner === "pane") {
    left = (
      <div className="ts-keys" data-owner="pane">
        <span className="ts-label" data-strong>{t("board.keys.typingInto", { name: p.name })}</span>
        {!lean && <span className="ts-hint" data-optional><Kbd>Esc</Kbd> {t("board.keys.escGoes")}</span>}
        {!lean && <span className="ts-hint"><Kbd label={t(RELEASE_CHORD_SPOKEN_MSG)}>{p.chordLabel}</Kbd> {t(deck ? "board.status.keysBack" : "board.keys.backToBoard")}</span>}
      </div>
    );
  } else {
    left = (
      <div className="ts-keys" data-owner="board">
        <span className="ts-label">{t(deck ? "board.status.deckLabel" : "board.keys.onBoard")}</span>
        {!lean && !p.takeover && <span className="ts-hint"><Kbd>j k</Kbd> {t("board.keys.sessions")}</span>}
        {!lean && p.canType && (
          <span className="ts-hint">
            <Kbd label={t("board.keys.enterSpoken")}>↵</Kbd>
            <button type="button" className="btn ts-plain" onClick={p.onTypeHere}>{t(p.chat ? "board.keys.typeInTerm" : "board.keys.typeHere")}</button>
          </span>
        )}
        {!lean && p.asksWaiting && <span className="ts-hint"><Kbd>n</Kbd> {t("board.keys.nextAskHint")}</span>}
      </div>
    );
  }
  const bar = (
    <footer className={p.composer ? "ts-bar ts-bar-compose" : "ts-bar"}
      aria-label={t(p.composer ? "board.chat.conversation" : "board.keys.bar")}
      hidden={(p.paneless && !p.hosts && !p.chatCannotType && !p.composer) || undefined}>
      {p.composer ? <>{p.composer}{(p.end || p.notice || right) && <div className="ts-chat-status">
        {(p.end || p.notice) && left}
        {right}
      </div>}</> : <>{left}{right}</>}
    </footer>
  );
  // Each Chat pane keeps its input locally; only terminal hints share the
  // focused pane's status slot, with a local fallback on phones.
  if (p.composer) return bar;
  if (p.primary === false) return null;
  return <KeysBarPlacement visible={!(p.paneless && !p.hosts && !p.chatCannotType)}>{bar}</KeysBarPlacement>;
}
