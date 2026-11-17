// The strip across the top of the board: two figures (board-header.ts works
// them out), drawn and nothing else.
//
// Memoised, and handed short strings rather than the agents map: App
// re-renders on its clock several times a second, and the props here change
// only when a figure does. No live region: the topbar's waiting chip and the
// tab title already speak for a session that starts waiting, and the topbar's
// counts are the place the waiting, working and done sessions are counted.
//
// A section with a name, as the topbar's readouts are named, not a landmark of
// its own kind: the canvas is the page's <main>, and a strip inside it is a
// region of it. Each stat reads number first, label second ("6m 42s Longest
// wait"), the order the eye takes.
import { memo } from "react";
import { useT } from "../i18n";

import { BOARD_HEAD_CLASS, BOARD_HEAD_LABEL_MSGS, BOARD_HEAD_NONE, type BoardHeadFigures } from "../board-header";

// The waiting trend (Figma: "Sessions waiting on you, last hour" over a small
// bar graphic) is not drawn here. The deck keeps no per-minute history of the
// waiting count to draw it from, and its colours wait on the data palette.

function Stat({ value, label, tone, title }: {
  value: string;
  label: string;
  /** "none" for a dash. */
  tone?: "none";
  title?: string;
}) {
  return (
    <div className="bh-stat" title={title}>
      <span className="bh-num" data-tone={tone}>{value}</span>
      <span className="bh-label">{label}</span>
    </div>
  );
}

function BoardHeader({ longestWait, spent, spentTitle, reservedRight = 0 }: BoardHeadFigures & {
  /** Width of the rail of panels over the strip's right end, as padding, so the
   *  container query sees only the room that is left. */
  reservedRight?: number;
}) {
  const t = useT();
  const [lLongest, lSpent] = BOARD_HEAD_LABEL_MSGS.map(key => t(key));
  return (
    <section className={BOARD_HEAD_CLASS} aria-label={t("board.header.summary")} style={{ paddingRight: `calc(24px + ${reservedRight}px)` }}>
      <Stat value={longestWait ?? BOARD_HEAD_NONE} label={lLongest} tone={longestWait == null ? "none" : undefined} />
      <Stat value={spent ?? BOARD_HEAD_NONE} label={lSpent} tone={spent == null ? "none" : undefined} title={spentTitle} />
    </section>
  );
}

export default memo(BoardHeader);
