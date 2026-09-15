// Claude Code's recap, as a node of its own beside the session root.
//
// It began as something drawn on top of the canvas beside its card, and that
// was the trouble: the layout could not see it, so R stacked a session straight
// onto a neighbour's note; the fit could not see it, so it was cut off at the
// edge of the screen; and a drag of the card left the note to follow on terms
// of its own. As a node it is laid out by the same pass as the cards — dagre
// ranks it to the LEFT of its root, because the tie is an edge from the note to
// the root — fitted by the same fit, pushed aside by the same growth, carried
// with its session by the session drag, and dragged, pinned and remembered like
// any card.
//
// App builds it only while the recap still describes the session and nobody has
// put it away (recap-note.ts), so it opens by itself when a session comes to
// rest and goes when the next turn starts.
import React from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import type { SessionRecap } from "../types";
import { dismissRecap } from "../recap-note";
import { promptTime } from "../relative-time";
import { useNow } from "../use-now";
import { RecapMark } from "./AgentNode";

/** What App hands the node. `parentId` is the session root — the tie's target,
 *  and the member joinSessions anchors a new node to, so a note arriving in a
 *  session already on the canvas lands beside its card rather than wherever a
 *  layout from scratch would have put the whole session. */
export interface RecapNoteData {
  sessionId: string;
  parentId: string;
  recap: SessionRecap;
  noteKey: string;
  hue: number;
}

export default function RecapNoteNode({ data }: NodeProps<RecapNoteData>) {
  // Its own clock, as the card keeps its own: the node's data is not rebuilt
  // for time passing, and the age is a count of minutes.
  const now = useNow(30_000);
  const written = promptTime(data.recap.at, now);
  return (
    <div
      className="recap-note"
      role="note"
      aria-label="Claude Code's recap"
      style={{ "--session-hue": data.hue } as React.CSSProperties}
    >
      <div className="recap-note-head">
        <span className="recap-note-mark"><RecapMark />recap</span>
        <span className="recap-note-age" title={written.title}>{written.label}</span>
        {/* The click stops here: a click on the node is App's, and selects
            the session the note belongs to. */}
        <button
          type="button"
          className="glyph-btn recap-note-close"
          aria-label="Hide the recap"
          title="Hide — the ※ on the card brings it back"
          onClick={e => { e.stopPropagation(); dismissRecap(data.noteKey); }}
        >×</button>
      </div>
      <p className="recap-note-text">{data.recap.text}</p>
      <Handle type="source" position={Position.Right} style={{ background: "transparent", border: "none" }} />
    </div>
  );
}
