// The alert stack: a compact card in the corner for each session that started
// waiting on you while you were looking at something else. What it asks, and
// up to three ways to answer: "Allow once" and "Deny" for a permission prompt,
// the options of a one-question question, and "Open in Chat" for the rest.
//
// AN ANSWER HERE IS NEVER A KEY. A button holds an intent (answer-intent.ts)
// and opens the session in Chat, where the prompt's own card presses it once
// the words on screen are checked; anything else waits for the reader there.
//
// BY ITS ROW. With the Sessions list on screen the stack sits just right of
// the first card's row (its Needs you row), level with it, and that card
// points at it; the session's name stays on the card. With no row to sit by
// (the list folded or covered, the row scrolled away, a window too narrow
// for the stack beside it) the stack keeps to the corner under the top bar.
//
// QUIET BY DESIGN. Three cards at most, then "+N more", which opens the
// waiting queue under the top bar's count (the list of everybody waiting).
// A card goes when its session stops waiting, when the session is shown in
// Chat, or when × or Esc dismisses it. Nothing takes the focus on arrival;
// each card's buttons are in the tab order, Esc inside a card dismisses it,
// and a polite live region says who asks and what.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { AlertChoice, AlertModel } from "../../alert-model";
import { useT } from "../../i18n";
import { KitIcon } from "../kit-icons";
import { railRowId } from "../RailParts";
import { AlertMark } from "../StateMark";

/** How many cards are drawn; the rest are counted. */
export const MAX_ALERT_CARDS = 3;
/** --dur-exit (tokens.css): how long a card that goes stays to fade out. */
export const ALERT_EXIT_MS = 150;

export interface AlertStackProps {
  /** The sessions to alert about, oldest wait first. */
  alerts: AlertModel[];
  /** Chat can be opened here (Workspace is on offer): answers and "Open in
   *  Chat" are offered. Otherwise "Open" goes to the session. */
  canChat: boolean;
  /** What the live region says, once per change ("" for nothing). */
  said: string;
  onAnswer(alert: AlertModel, choice: AlertChoice): void;
  onOpen(alert: AlertModel): void;
  onDismiss(alert: AlertModel): void;
  /** "+N more": the waiting queue. */
  onMore(): void;
}

/** The room between a row and the stack beside it, and kept to the window's edge. */
export const ANCHOR_GAP = 8;
export const ANCHOR_EDGE = 12;
/** The stack's width, as in the corner; beside a row it may narrow to the least
 *  that still holds a card's answers, and below that it keeps to the corner. */
export const ANCHOR_WIDTH = 320;
export const ANCHOR_MIN_WIDTH = 240;
/** How near a card's corners the point toward its row may come. */
const NOTCH_INSET = 14;

export interface AnchorBox { left: number; top: number; right: number; bottom: number }
/** The stack beside a row: its corner and width, and how far down the row's card its point sits. */
export interface AnchorPlace { left: number; top: number; width: number; notch: number | null }

/** The stack's height, and where the row's own card is in it. */
export interface StackBox { height: number; cardTop: number; cardHeight: number }

/** Where the stack goes beside `row`, or null when it does not fit there and
 *  keeps to the corner. `view.right` is where the free page ends (the right
 *  stripe's edge). The row's card is level with the row, moved up only as far
 *  as the window's bottom needs; the point toward the row is drawn only when
 *  the row's middle falls on that card. */
export function placeBeside(row: AnchorBox, stack: StackBox, view: { right: number; height: number }): AnchorPlace | null {
  const left = Math.round(row.right + ANCHOR_GAP);
  const width = Math.min(ANCHOR_WIDTH, Math.floor(view.right - ANCHOR_EDGE - left));
  if (width < ANCHOR_MIN_WIDTH) return null;
  const lowest = Math.max(ANCHOR_EDGE, view.height - stack.height - ANCHOR_EDGE);
  const top = Math.round(Math.min(Math.max(row.top - stack.cardTop, ANCHOR_EDGE), lowest));
  const mid = Math.round((row.top + row.bottom) / 2 - top - stack.cardTop);
  const notch = mid >= NOTCH_INSET && mid <= stack.cardHeight - NOTCH_INSET ? mid : null;
  return { left, top, width, notch };
}

const samePlace = (a: AnchorPlace | null, b: AnchorPlace | null) =>
  a === b || (!!a && !!b && a.left === b.left && a.top === b.top && a.width === b.width && a.notch === b.notch);

/** Where the free page ends on the right: inside the right stripe, as the
 *  stack in the corner keeps. */
function freeRight(el: HTMLElement): number {
  const edge = parseFloat(getComputedStyle(el).getPropertyValue("--edge-w"));
  return window.innerWidth - (Number.isFinite(edge) ? edge : 0);
}

/** The session's row in the Sessions list, while it is drawn and seen: a row
 *  of a folded list, scrolled out of its list or under a sheet is not. */
function rowBox(sessionId: string): AnchorBox | null {
  if (typeof document === "undefined") return null;
  const el = document.getElementById(railRowId(sessionId));
  if (!el) return null;
  const box = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (box.width === 0 || box.height === 0 || box.bottom <= 0 || box.top >= vh || box.right <= 0 || box.left >= vw) return null;
  const x = Math.min(Math.max(box.left + 12, 0), vw - 1);
  const y = Math.min(Math.max((box.top + box.bottom) / 2, 0), vh - 1);
  const hit = typeof document.elementFromPoint === "function" ? document.elementFromPoint(x, y) : el;
  return hit && el.contains(hit) ? box : null;
}

/** One drawn card: the alert, and whether it is on its way out. */
interface Drawn { alert: AlertModel; leaving: boolean }

/** The cards to draw after `alerts` arrived: the ones still drawn keep their
 *  place, the ones that went stay as leaving until their exit is over, and new
 *  ones join at the end. */
export function nextDrawn(prev: readonly Drawn[], alerts: readonly AlertModel[]): Drawn[] {
  const now = new Map(alerts.map(a => [a.sessionId, a]));
  const kept: Drawn[] = prev.map(d => {
    const fresh = now.get(d.alert.sessionId);
    return fresh ? { alert: fresh, leaving: false } : { alert: d.alert, leaving: true };
  });
  const have = new Set(prev.map(d => d.alert.sessionId));
  return [...kept, ...alerts.filter(a => !have.has(a.sessionId)).map(alert => ({ alert, leaving: false }))];
}

/** The answer drawn as the primary button: a permission prompt's Allow once. */
const leads = (alert: AlertModel, index: number) => index === 0 && alert.kind === "permission";

export default function AlertStack(p: AlertStackProps) {
  const t = useT();
  const shownAlerts = p.alerts.slice(0, MAX_ALERT_CARDS);
  const more = p.alerts.length - shownAlerts.length;
  const [drawn, setDrawn] = useState<Drawn[]>([]);
  const timer = useRef<number | undefined>(undefined);
  const key = shownAlerts.map(a => `${a.sessionId}@${a.since}:${a.what}:${a.choices.length}`).join("|");
  useEffect(() => {
    setDrawn(prev => nextDrawn(prev.filter(d => !d.leaving), shownAlerts));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDrawn(prev => prev.filter(d => !d.leaving)), ALERT_EXIT_MS);
    // The key says when the alerts moved; the list is rebuilt on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Beside the first card's row while there is one to sit by. The rows move
  // (the list scrolls, folds, sorts a newcomer into Needs you), so the place is
  // read again on a scroll, a resize and twice a second while cards are up.
  const stack = useRef<HTMLElement>(null);
  const [place, setPlace] = useState<AnchorPlace | null>(null);
  const anchorId = drawn.find(d => !d.leaving)?.alert.sessionId ?? null;
  useLayoutEffect(() => {
    if (!anchorId || typeof document === "undefined") { setPlace(null); return; }
    let frame = 0;
    const measure = () => {
      frame = 0;
      const el = stack.current;
      const card = el?.querySelector<HTMLElement>(".ca-card[data-anchor]");
      const row = el && card ? rowBox(anchorId) : null;
      const next = el && card && row
        ? placeBeside(row, { height: el.offsetHeight, cardTop: card.offsetTop, cardHeight: card.offsetHeight }, { right: freeRight(el), height: window.innerHeight })
        : null;
      setPlace(prev => (samePlace(prev, next) ? prev : next));
    };
    const soon = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    window.addEventListener("resize", soon);
    document.addEventListener("scroll", soon, true);
    const every = window.setInterval(soon, 500);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", soon);
      document.removeEventListener("scroll", soon, true);
      window.clearInterval(every);
    };
  }, [anchorId, drawn.length]);
  const placed = place
    ? ({ "--ca-left": `${place.left}px`, "--ca-top": `${place.top}px`, "--ca-width": `${place.width}px`, ...(place.notch !== null ? { "--ca-notch": `${place.notch}px` } : null) } as CSSProperties)
    : undefined;

  const onKey = (alert: AlertModel) => (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    // The focus stays in the stack: on the next card, else the one before.
    const card = e.currentTarget;
    const near = [card.nextElementSibling, card.previousElementSibling]
      .find(el => el != null && !el.hasAttribute("data-leaving"));
    near?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    p.onDismiss(alert);
  };

  return (
    <section ref={stack} className="ca-stack" aria-label={t("board.chat.alert.region")} data-empty={drawn.length === 0 || undefined}
      data-anchored={place ? "" : undefined} data-notch={place?.notch != null ? "" : undefined} style={placed}>
      {drawn.length > 0 && (
        <ol className="ca-list">
          {drawn.map(({ alert, leaving }) => {
            const answers = p.canChat ? alert.choices : [];
            return (
              <li
                key={alert.sessionId}
                className="ca-card"
                data-kind={alert.kind}
                data-leaving={leaving || undefined}
                data-anchor={alert.sessionId === anchorId || undefined}
                onKeyDown={leaving ? undefined : onKey(alert)}
                aria-hidden={leaving || undefined}
              >
                <div className="ca-head">
                  <AlertMark size={14} />
                  <span className="ca-name">{alert.name}</span>
                  <button type="button" className="glyph-btn ca-close" aria-label={t("board.chat.alert.dismiss", { name: alert.name })}
                    title={t("board.chat.alert.dismiss", { name: alert.name })} onClick={() => p.onDismiss(alert)}>
                    <KitIcon name="close" />
                  </button>
                </div>
                <p className="ca-what" data-mono={alert.kind === "permission" || undefined}>{alert.what}</p>
                <div className="ca-actions">
                  {answers.map((choice, i) => (
                    <button key={i} type="button" className={leads(alert, i) ? "btn primary ca-answer" : "btn ca-answer"}
                      onClick={() => p.onAnswer(alert, choice)}>{choice.text}</button>
                  ))}
                  <button type="button" className="btn ts-plain ca-open" onClick={() => p.onOpen(alert)}>
                    {t(!p.canChat ? "board.chat.alert.open" : answers.length > 0 ? "board.chat.alert.open" : "board.chat.alert.openInChat")}
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {more > 0 && (
        <button type="button" className="btn ts-plain ca-more" onClick={p.onMore}>{t("board.chat.alert.more", { n: more })}</button>
      )}
      <p className="vis-hidden" role="status" aria-live="polite" aria-atomic="true">{p.said}</p>
    </section>
  );
}

/** The two buttons' class names a test can find a card's answers by. */
export const ALERT_ANSWER_CLASS = "ca-answer";
export type { AlertChoice, AlertModel };
