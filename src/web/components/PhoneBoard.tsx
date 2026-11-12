// The Board on a phone: a vertical, scrollable stack of full-width cards, one
// per session, in place of the free canvas (phone-board.ts has the rules). No
// zoom, no minimap, no Fit all and no trash: nothing here moves a camera. A tap
// is the Sessions row's own press (App.tsx pickSession).
//
// The order is held while a finger or a pointer is on the stack, as the list
// holds its own (rail-model.ts holdOrder): a card never moves under a tap.
import { Fragment, useMemo, useRef, useState, type ReactNode } from "react";
import { useLanguage, useT } from "../i18n";
import type { GraphState } from "../reducer";
import { phoneBoardCards, phoneCardMeta, type PhoneCard } from "../phone-board";
import { holdOrder, type Slot } from "../rail-model";
import { railLine, rowSpoken, twinStart } from "../rail-row-copy";
import { useSessionsSeenVersion } from "../session-seen";
import { AlertMark, StateMark } from "./StateMark";

export default function PhoneBoard({ state, now, watching, removedIds, selectedIds, onOpen }: {
  state: GraphState;
  now: number;
  /** The sessions you are looking at: their finished turns are seen as they end. */
  watching?: ReadonlySet<string>;
  /** What "Remove from board" took off: not drawn here, the list brings it back. */
  removedIds?: ReadonlySet<string>;
  selectedIds?: ReadonlySet<string>;
  /** What a tap does: the same press as the session's Sessions row. */
  onOpen: (sessionId: string) => void;
}) {
  const t = useT();
  const language = useLanguage();
  const seenVersion = useSessionsSeenVersion();
  const watchKey = watching ? [...watching].sort().join("\n") : "";
  // `state.revision` for the reason the list gives: the reducer mutates the
  // state in place, so its identity never moves.
  const cards = useMemo(() => phoneBoardCards(state, now, { watching, removed: removedIds }, t),
    [state, state.revision, now, seenVersion, watchKey, removedIds, language]);
  const [aimed, setAimed] = useState(false);
  const drawn = useRef<Slot[]>([]);
  const fresh: Slot[] = cards.map(c => ({ id: c.row.sessionId, group: c.group }));
  const order = aimed && drawn.current.length > 0 ? holdOrder(drawn.current, fresh).order : fresh;
  drawn.current = order;
  if (cards.length === 0) return null;
  const byId = new Map(cards.map(c => [c.row.sessionId, c]));
  return (
    // role="list": a list styled without its bullets loses the role in Safari.
    <ul className="phone-board" role="list" aria-label={t("board.phone.stack")}
      onPointerEnter={() => setAimed(true)} onPointerLeave={() => setAimed(false)}>
      {order.map(s => (
        <li key={s.id} className="pb-item">
          <PhoneBoardCard card={byId.get(s.id)!} now={now} selected={selectedIds?.has(s.id) ?? false} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}

/** One card: the mark, the name and the state word; the question it waits on,
 *  else "folder · task"; then "model · time" in mono, and a look-alike's start
 *  time after them. */
export function PhoneBoardCard({ card, now, selected, onOpen }: { card: PhoneCard; now: number; selected: boolean; onOpen: (sessionId: string) => void }) {
  const { row: r, group, status } = card;
  const line = railLine(r, group);
  const { model, time } = phoneCardMeta(r, group, now);
  // "model · time · start": the start time only on a card that reads like
  // another (twinClocks), last, so the name keeps its line whole.
  const parts: ReactNode[] = [
    model,
    time && <><span className="vis-hidden">{time.spoken} </span>{time.text}</>,
    r.twin && <span className="pb-start">{twinStart(r.startedAt, r.twin)}</span>,
  ].filter(Boolean);
  return (
    <button type="button" className={`pb-card${selected ? " selected" : ""}`} data-session={r.sessionId} data-tone={status.tone}
      aria-current={selected ? "true" : undefined} onClick={() => onOpen(r.sessionId)}>
      <span className="pb-head">
        {status.mark === "alert" ? <AlertMark /> : <StateMark kind={status.mark} />}
        <span className="pb-name">{r.label}</span>
        <span className="pb-state">{status.word}</span>
      </span>
      {line && (
        <span className={`pb-line${line.kind === "tool" ? " mono" : ""}`}>
          {line.kind === "tool" ? <><b className="pb-tool">{line.name}</b>{line.rest ? ` · ${line.rest}` : ""}</> : line.text}
        </span>
      )}
      {parts.length > 0 && (
        <span className="pb-meta">
          {parts.map((part, i) => <Fragment key={i}>{i > 0 ? " · " : ""}{part}</Fragment>)}
        </span>
      )}
      {/* What the card does not draw, for a screen reader (the list row's words). */}
      <span className="vis-hidden">{rowSpoken(r)}</span>
    </button>
  );
}
