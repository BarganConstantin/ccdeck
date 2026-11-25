// The alert stack: a compact card in the corner for each session that started
// waiting on you while you were looking at something else. What it asks, and
// up to three ways to answer: "Allow once" and "Deny" for a permission prompt,
// the options of a one-question question, and "Open in Chat" for the rest.
//
// AN ANSWER HERE IS NEVER A KEY. A button holds an intent (answer-intent.ts)
// and opens the session in Chat, where the prompt's own card presses it once
// the words on screen are checked; anything else waits for the reader there.
//
// QUIET BY DESIGN. Three cards at most, then "+N more", which opens the
// waiting queue under the top bar's count (the list of everybody waiting).
// A card goes when its session stops waiting, when the session is shown in
// Chat, or when × or Esc dismisses it. Nothing takes the focus on arrival;
// each card's buttons are in the tab order, Esc inside a card dismisses it,
// and a polite live region says who asks and what.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AlertChoice, AlertModel } from "../../alert-model";
import { useT } from "../../i18n";
import { KitIcon } from "../kit-icons";
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
    <section className="ca-stack" aria-label={t("board.chat.alert.region")} data-empty={drawn.length === 0 || undefined}>
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
