import React from "react";
import type { CardMark } from "../git-card-mark";
import { focusAgentFrom } from "../git-view-request";
import { GvIcon } from "./GitViewParts";

/**
 * The card's collision mark: one row under the session's name, a way to the
 * other agent. Quiet is a muted line with the folder glyph; sharp is the
 * error colour on an edge, the clash glyph and the file's name first. The
 * sentence gives way before the file's name and the tail; the tooltip holds
 * every agent and file. A press is the mark's own: it does not select this
 * card, it selects the other agent and brings it into view.
 */
export function GitMarkRow({ mark }: { mark: CardMark }) {
  return (
    <button
      type="button"
      className="git-mark"
      data-level={mark.level}
      data-session={mark.session ? "" : undefined}
      title={mark.title}
      onClick={e => { e.stopPropagation(); focusAgentFrom(mark.target); }}
      onDoubleClick={e => e.stopPropagation()}
    >
      {mark.level === "sharp"
        ? <span className="git-mark-glyph" role="img" aria-label="same file"><GvIcon name="clash" size={12} /></span>
        : <span className="git-mark-glyph" aria-hidden="true"><GvIcon name="share" size={12} /></span>}
      {mark.lead && <b className="git-mark-lead">{mark.lead}</b>}
      <span className="git-mark-said">{mark.said}</span>
      {mark.tail && <span className="git-mark-tail">{mark.tail}</span>}
    </button>
  );
}
