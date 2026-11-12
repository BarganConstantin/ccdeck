// The Board on a phone (owner's critique, 2026-11-12): a stack of full-width
// cards, one per session, where a free canvas at 26 % drew a spinner in a pill
// with no text. Every rule here is one another surface already keeps: the order
// and the groups are the Sessions list's (SessionList.tsx buildRows), the mark
// and the state word the card's own (node-face.ts faceStatus), the second line
// the list row's (rail-row-copy.ts railLine) and the look-alike's start time
// twinClocks', asked of the cards drawn, as the canvas asks it.
import { buildRows, rank, type Row } from "./components/SessionList";
import { rootAgentId, type GraphState } from "./graph-state";
import { t, type TFunction } from "./i18n";
import { modelChipText } from "./model-label";
import { faceStatus, type CardState } from "./node-face";
import type { RailGroup } from "./rail-model";
import { railTime, twinClocks } from "./rail-row-copy";
import { isAgentVisible } from "./visibility";

/** One card of the stack. `row.twin` is set only when another CARD reads the
 *  same, name and task. */
export interface PhoneCard {
  row: Row;
  group: RailGroup;
  status: CardState;
}

/**
 * The cards, in the Sessions list's order. Only what the canvas would draw: a
 * session "Remove from board" took off, and one the canvas does not show (a
 * card fading out, a session that ended at once having done nothing), is left
 * to the list, which is the way back for both.
 */
export function phoneBoardCards(
  state: GraphState,
  now: number,
  opts: { watching?: ReadonlySet<string>; removed?: ReadonlySet<string> } = {},
  tr: TFunction = t,
): PhoneCard[] {
  const cards: PhoneCard[] = [];
  for (const listed of buildRows(state, now, opts.watching)) {
    const root = state.agents.get(rootAgentId(listed.sessionId));
    if (!root || opts.removed?.has(listed.sessionId) || !isAgentVisible(root, now)) continue;
    const row: Row = { ...listed };
    delete row.twin;
    cards.push({ row, group: rank(row), status: faceStatus(root, tr) });
  }
  const twins = twinClocks(cards.map(c => ({ id: c.row.sessionId, title: c.row.label, task: c.row.task, startedAt: c.row.startedAt })));
  for (const c of cards) {
    const twin = twins.get(c.row.sessionId);
    if (twin) c.row.twin = twin;
  }
  return cards;
}

/** The card's mono line, "model · time": the model as the list's chip names it
 *  and the clock the list's row keeps at its right edge (railTime), with the
 *  word a screen reader hears ahead of the number. Either may be absent. */
export function phoneCardMeta(r: Row, group: RailGroup, now: number): { model: string | null; time: ReturnType<typeof railTime> } {
  return { model: r.modelId ? modelChipText(r.modelId, r.effort) : null, time: railTime(r, group, now) };
}
