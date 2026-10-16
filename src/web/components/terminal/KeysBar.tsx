// The keys bar: 36px under the terminal that always says who has the keyboard,
// and runs the asks (v3).
//
// ONE OWNER, ALWAYS VISIBLE. A pane that takes every key — Escape included —
// is a keyboard trap unless the way out is on screen, so the bar's left side
// is never empty: a hollow lamp and "Keys on the board" with the board's own
// keys, or a lit lamp and "Typing into paycore" with the release chord. The
// lamp is the state; the sentence is what a screen reader hears, once, when it
// lands on the bar (it is not a live region — the owner changes on every
// click into the pane, and #372 is what announcing that would be).
//
// THE ASKS LIVE WHERE THE EYES ALREADY ARE. Answering a permission prompt
// means looking at the last rows of the terminal; the next ask is offered
// right under them rather than in the header 700px up. The run's state comes
// from the integrator (use-asks), as data: this bar draws it and calls back.
// It never switches session by itself — a stray "1" must never approve
// something nobody has read.
//
// WHEN THE SESSION HAS ENDED the bar becomes the end bar: the square mark, the
// sentence that says the frame is frozen, and "Reopen here". A pane someone
// else took away gets the same bar with "Attach again".
import { RELEASE_CHORD_SPOKEN } from "../../terminal-keys";
import type { KeysOwner } from "./stage-model";
import { ChevronGlyph } from "./stage-icons";

/** One run through the waiting sessions, as the integrator's use-asks has it. */
export interface AsksView {
  /** One per ask in the run, in order. */
  segments: Array<"todo" | "now" | "done">;
  /** The segment that just joined the run, which grows in. */
  freshIndex?: number | null;
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
  /** Something the pane just refused (a paste too big to send), for a few
   *  seconds in place of the hints. */
  notice?: string | null;
  firstRun: boolean;
  onFirstRunDone(): void;
  onTypeHere(): void;
  end?: EndView | null;
  asks?: AsksView | null;
  arrival?: ArrivalView | null;
  onNextAsk?(): void;
  onAnswerArrival?(): void;
}

const Kbd = ({ children, label }: { children: string; label?: string }) =>
  <kbd className="ts-kbd" aria-label={label}>{children}</kbd>;

/** The track: hollow for an ask still to come, filled for the one on stage,
 *  green for one answered. Drawn, so hidden from the reader; the count and
 *  the button beside it say the same in words. */
export function AsksTrack({ asks, onNextAsk }: { asks: AsksView; onNextAsk?(): void }) {
  const track = (
    <span className="ts-track" aria-hidden="true">
      {asks.segments.map((s, i) => <i key={i} data-s={s} data-fresh={asks.freshIndex === i || undefined} />)}
    </span>
  );
  if (asks.position) {
    return (
      <div className="ts-asks">
        <span className="ts-asks-label">Asks</span>
        {track}
        <span className="ts-count">{asks.position.index + 1} of {asks.position.total}</span>
      </div>
    );
  }
  if (asks.next) {
    const { next } = asks;
    return (
      <div className="ts-asks">
        {asks.resumed && <span className="ts-resumed">✓ {asks.resumed} resumed</span>}
        {track}
        <button
          type="button"
          className="btn ts-next"
          aria-label={`Next ask: ${next.name}, waiting ${next.waited}${next.tool ? ` on ${next.tool}` : ""}`}
          onClick={onNextAsk}
        >
          Next ask <span className="ts-next-name">{next.name}</span> <b>{next.waited}</b>
          <ChevronGlyph />
        </button>
      </div>
    );
  }
  if (asks.clear) return <div className="ts-asks"><span className="ts-resumed">✓ No more asks</span></div>;
  return null;
}

/** "● paycore asks · Bash  [Answer n]" — said once, quietly, in the bar. */
export function ArrivalNote({ arrival, onAnswer }: { arrival: ArrivalView; onAnswer?(): void }) {
  return (
    <div className="ts-asks">
      <span className="ts-arrival">
        <span className="ap-pulse" aria-hidden="true" />
        <b>{arrival.name}</b> asks{arrival.tool ? ` · ${arrival.tool}` : ""}
      </span>
      <button type="button" className="btn ts-next" aria-label={`Answer ${arrival.name}`} onClick={onAnswer}>
        Answer <Kbd>n</Kbd>
      </button>
    </div>
  );
}

export default function KeysBar(p: KeysBarProps) {
  let left;
  if (p.end) {
    left = (
      <div className="ts-keys" data-owner="none">
        <span className="ts-end"><i className="ts-end-mark" aria-hidden="true" />{p.end.sentence}</span>
        <button type="button" className="btn" aria-busy={p.end.busy || undefined} onClick={p.end.onAction}>{p.end.action}</button>
      </div>
    );
  } else if (p.notice) {
    left = (
      <div className="ts-keys" data-owner="none">
        <span className="ts-end"><i className="ts-end-mark" aria-hidden="true" />{p.notice}</span>
      </div>
    );
  } else if (p.firstRun && p.canType) {
    // The first-run line lives here so it never costs the terminal a row.
    left = (
      <div className="ts-keys" data-owner={p.owner}>
        <i className="ts-lamp" aria-hidden="true" />
        <span>Typing goes to the session — <Kbd>Esc</Kbd> included. <Kbd>✕</Kbd> closes the stage; the session keeps running.</span>
        <button type="button" className="btn" onClick={p.onFirstRunDone}>Got it</button>
      </div>
    );
  } else if (p.owner === "pane") {
    left = (
      <div className="ts-keys" data-owner="pane">
        <i className="ts-lamp" aria-hidden="true" />
        <span>Typing into <span className="ts-who">{p.name}</span></span>
        <span className="ts-hint"><Kbd>Esc</Kbd> goes to the session</span>
        <span className="ts-hint"><Kbd label={RELEASE_CHORD_SPOKEN}>{p.chordLabel}</Kbd> back to the board</span>
      </div>
    );
  } else {
    left = (
      <div className="ts-keys" data-owner="board">
        <i className="ts-lamp" aria-hidden="true" />
        <span>Keys on the board</span>
        {!p.takeover && <span className="ts-hint"><Kbd>j</Kbd><Kbd>k</Kbd> sessions</span>}
        {p.canType && (
          <span className="ts-hint">
            <Kbd label="Enter">↵</Kbd>
            <button type="button" className="btn ts-type" onClick={p.onTypeHere}>type here</button>
          </span>
        )}
        {p.asksWaiting && <span className="ts-hint"><Kbd>n</Kbd> next ask</span>}
      </div>
    );
  }
  let right = null;
  if (!p.end && p.asks) right = <AsksTrack asks={p.asks} onNextAsk={p.onNextAsk} />;
  else if (!p.end && p.arrival) right = <ArrivalNote arrival={p.arrival} onAnswer={p.onAnswerArrival} />;
  return (
    <footer className="ts-bar" aria-label="Keyboard">
      {left}
      {right}
    </footer>
  );
}
