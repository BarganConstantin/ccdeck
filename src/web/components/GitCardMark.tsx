import React, { useEffect, useRef, useState } from "react";
import { flashCard } from "../card-flash";
import { focusCanvasNode } from "../canvas-node-element";
import type { CardMark } from "../git-card-mark";
import { focusAgentFrom } from "../git-view-request";
import { GvIcon } from "./GitViewParts";

/**
 * The card's collision mark: one row under the session's name, a way to the
 * other agent. Quiet is a muted line with the folder glyph; sharp is the
 * error colour on an edge, the clash glyph and the file's name first. The
 * sentence gives way before the file's name and the tail; the tooltip holds
 * every agent and file.
 *
 * A press is the mark's own: it does not select this card, it selects the
 * other agent and brings it into the part of the pane nothing covers
 * (focusAgentFrom, focus-camera.ts). From a pointer the other card is then lit
 * once (card-flash.ts); from the keyboard the keyboard goes with the reader,
 * onto the other card, whose ring is the answer and nothing animates. No
 * sound, no notification.
 *
 * Live, as the server's collisions change: a mark fades in, and one that has
 * stopped being true fades out before its row goes (agent-node.css). The row
 * that is going is out of the tab order and out of the accessibility tree, and
 * if the keyboard was on it, it moves to the card.
 */
export function GitMarkRow({ mark, agentId }: { mark: CardMark | null; agentId: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  // The last mark this card had, kept while it fades out.
  const [last, setLast] = useState<CardMark | null>(mark);
  if (mark && mark !== last) setLast(mark);
  const shown = mark ?? last;
  const leaving = mark == null && last != null;

  useEffect(() => {
    if (leaving && ref.current != null && ref.current === document.activeElement) focusCanvasNode(agentId);
  }, [leaving, agentId]);

  if (!shown) return null;
  const target = shown.target;
  return (
    <button
      ref={ref}
      // A new level is a new mark, and fades in again.
      key={shown.level}
      type="button"
      className="git-mark"
      data-level={shown.level}
      data-session={shown.session ? "" : undefined}
      data-leaving={leaving ? "" : undefined}
      tabIndex={leaving ? -1 : undefined}
      aria-hidden={leaving ? true : undefined}
      title={shown.title}
      onClick={e => {
        e.stopPropagation();
        if (leaving) return;
        focusAgentFrom(target);
        // `detail` is 0 for a press made with Enter or Space.
        if (e.detail === 0) requestAnimationFrame(() => requestAnimationFrame(() => focusCanvasNode(target)));
        else requestAnimationFrame(() => flashCard(target));
      }}
      onDoubleClick={e => e.stopPropagation()}
      onAnimationEnd={e => { if (leaving && e.animationName === "git-mark-out") setLast(null); }}
    >
      {shown.level === "sharp"
        ? <span className="git-mark-glyph" role="img" aria-label="same file"><GvIcon name="clash" size={12} /></span>
        : <span className="git-mark-glyph" aria-hidden="true"><GvIcon name="share" size={12} /></span>}
      {shown.lead && <b className="git-mark-lead">{shown.lead}</b>}
      <span className="git-mark-said">{shown.said}</span>
      {shown.tail && <span className="git-mark-tail">{shown.tail}</span>}
    </button>
  );
}
