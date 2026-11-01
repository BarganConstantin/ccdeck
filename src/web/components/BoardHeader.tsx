// The strip across the top of the board: five figures (board-header.ts works
// them out), drawn and nothing else.
//
// Memoised, and handed numbers and short strings rather than the agents map:
// App re-renders on its clock several times a second, and the props here
// change only when a figure does. No live region: the topbar's waiting chip and
// the tab title already speak for a session that starts waiting.
//
// A section with a name, as the topbar's readouts are named, not a landmark of
// its own kind: the canvas is the page's <main>, and a strip inside it is a
// region of it. Each stat reads number first, label second ("2 Waiting on
// you"), the order the eye takes.
import { memo } from "react";

import { BOARD_HEAD_CLASS, BOARD_HEAD_LABELS, BOARD_HEAD_NONE, type BoardHeadFigures } from "../board-header";

// The waiting trend (Figma: "Sessions waiting on you, last hour" over a small
// bar graphic) is not drawn here. The deck keeps no per-minute history of the
// waiting count to draw it from, and its colours wait on the data palette.

function Stat({ value, label, tone, title }: {
  value: string;
  label: string;
  /** "warn" for a waiting count above zero, "none" for a dash. */
  tone?: "warn" | "none";
  title?: string;
}) {
  return (
    <div className="bh-stat" title={title}>
      <span className="bh-num" data-tone={tone}>{value}</span>
      <span className="bh-label">{label}</span>
    </div>
  );
}

function BoardHeader({ waiting, working, done, longestWait, spent, scopeTitle, spentTitle, reservedRight = 0 }: BoardHeadFigures & {
  /** Width of the rail of panels over the strip's right end, as padding, so the
   *  container query sees only the room that is left. */
  reservedRight?: number;
}) {
  const [lWaiting, lWorking, lDone, lLongest, lSpent] = BOARD_HEAD_LABELS;
  return (
    <section className={BOARD_HEAD_CLASS} aria-label="Board summary" style={{ paddingRight: `calc(24px + ${reservedRight}px)` }}>
      {/* A resting zero is not an alarm: --warn only above zero, the rule
          ambient.ts states for the tab title. */}
      <Stat value={String(waiting)} label={lWaiting} tone={waiting > 0 ? "warn" : undefined} />
      <Stat value={String(working)} label={lWorking} />
      <Stat value={String(done)} label={lDone} title={scopeTitle} />
      <Stat value={longestWait ?? BOARD_HEAD_NONE} label={lLongest} tone={longestWait == null ? "none" : undefined} />
      <Stat value={spent ?? BOARD_HEAD_NONE} label={lSpent} tone={spent == null ? "none" : undefined} title={spentTitle} />
    </section>
  );
}

export default memo(BoardHeader);
