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
// else took away gets the same bar with "Attach again".
//
// NO PANE, NO BAR. The empty pane and the cards that say why there is nothing
// to type into (an error, a session that cannot be attached, tmux missing)
// have no keys to name; the bar is hidden, not removed, because the stage
// measures it by element (TerminalStage's useDrawnHeight) and a new element
// would never be measured.
import { RELEASE_CHORD_SPOKEN_MSG } from "../../terminal-keys";
import { RECONNECT_NOTE_MSG, type KeysOwner } from "./stage-model";
import { Kbd } from "../Kbd";
import { t as tNow, useT } from "../../i18n";
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
  action: string;
  busy?: boolean;
  onAction(): void;
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
   *  pane leaves for the Board), where the Board's closes the Command Panel. */
  workspace?: boolean;
  /** No pane to type into (nothing open, an error, a session that cannot be
   *  attached, tmux missing): the bar says nothing and is not drawn, unless it
   *  carries the older hosts' line. */
  paneless?: boolean;
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
 *  pane. Neither ends the session. */
export function firstRunClause(workspace: boolean): string {
  return workspace ? tNow("board.keys.firstWorkspace") : tNow("board.keys.firstBoard");
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
  let left;
  if (p.end) {
    left = (
      <div className="ts-keys" data-owner="none" data-split>
        <span className="ts-end">{p.end.sentence}</span>
        <button type="button" className="btn" aria-busy={p.end.busy || undefined} data-stage-land onClick={p.end.onAction}>{p.end.action}</button>
      </div>
    );
  } else if (p.notice) {
    left = (
      <div className="ts-keys" data-owner="none">
        <span className="ts-end">{p.notice}</span>
      </div>
    );
  } else if (p.firstRun && p.canType) {
    // The first-run line lives here so it does not cost the terminal a row.
    // On a stage too narrow for it on one line (a phone) it wraps, and Got it
    // stays in reach; only a third line, on the narrowest screens, grows the
    // bar, and then the rows are fitted above it until Got it (the stage
    // hands its bar's height to stage-geometry.ts). A fingertip has no Esc,
    // so the clause that names it goes whole under a coarse pointer; ✕, the
    // header's control, stays.
    left = (
      <div className="ts-keys" data-owner={p.owner} data-split>
        <span className="ts-first">{t("board.keys.typingGoes")}<span className="ts-first-keys">{t("board.keys.escIncluded")}</span>. {firstRunClause(p.workspace === true)}</span>
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
        {!lean && <span className="ts-hint"><Kbd label={t(RELEASE_CHORD_SPOKEN_MSG)}>{p.chordLabel}</Kbd> {t("board.keys.backToBoard")}</span>}
      </div>
    );
  } else {
    left = (
      <div className="ts-keys" data-owner="board">
        <span className="ts-label">{t("board.keys.onBoard")}</span>
        {!lean && !p.takeover && <span className="ts-hint"><Kbd>j k</Kbd> {t("board.keys.sessions")}</span>}
        {!lean && p.canType && (
          <span className="ts-hint">
            <Kbd label={t("board.keys.enterSpoken")}>↵</Kbd>
            <button type="button" className="btn ts-plain" onClick={p.onTypeHere}>{t("board.keys.typeHere")}</button>
          </span>
        )}
        {!lean && p.asksWaiting && <span className="ts-hint"><Kbd>n</Kbd> {t("board.keys.nextAskHint")}</span>}
      </div>
    );
  }
  return (
    <footer className="ts-bar" aria-label={t("board.keys.bar")} hidden={(p.paneless && !p.hosts) || undefined}>
      {left}
      {right}
    </footer>
  );
}
