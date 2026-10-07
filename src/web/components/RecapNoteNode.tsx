// A session's note, as a node of its own beside the session root.
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
// It was Claude Code's recap alone, and is now whatever session-note.ts says
// the session's note is: what it is doing while a turn runs, what came of a
// background job, the last thing a finished turn did — and the recap, which
// takes the note's place when Claude Code writes it. App builds it only while
// there is something to say and nobody has put it away (recap-note.ts).
import React from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { dismissRecap } from "../recap-note";
import { noteSource, noteTag, type SessionNote } from "../session-note";
import { faceTitle } from "../node-face";
import { promptTime } from "../relative-time";
import { useNow } from "../use-now";
import { NoteMark } from "./RecapMark";

/** What App hands the node. `parentId` is the session root — the tie's target,
 *  and the member joinSessions anchors a new node to, so a note arriving in a
 *  session already on the canvas lands beside its card rather than wherever a
 *  layout from scratch would have put the whole session. */
export interface RecapNoteData {
  sessionId: string;
  parentId: string;
  note: SessionNote;
  noteKey: string;
  hue: number;
}

export default function RecapNoteNode({ data }: NodeProps<RecapNoteData>) {
  // Its own clock, as the card keeps its own: the node's data is not rebuilt
  // for time passing, and the age is a count of minutes.
  const now = useNow(30_000);
  const note = data.note;
  const isRecap = note.kind === "recap";
  const written = promptTime(note.at, now);
  // A status note wears its kind as `status-<kind>`, the prefix the session
  // list's line already uses, so a question, a failure and a finished job read
  // in the same colours in both places.
  const cls = isRecap ? "recap-note" : `recap-note is-status status-${note.kind}`;
  // Who wrote a status note; a recap says so in its mark. The text carries it
  // too, under the text itself (faceTitle), at both sizes.
  const tip = isRecap ? undefined : noteSource(note);
  return (
    <div
      className={cls}
      role="note"
      aria-label={isRecap ? "Claude Code's recap" : `Session note: ${noteTag(note.kind)}`}
      title={tip}
      style={{ "--session-hue": data.hue } as React.CSSProperties}
    >
      <div className="recap-note-head">
        <span className="recap-note-mark"><NoteMark recap={isRecap} />{noteTag(note.kind)}</span>
        <span className="recap-note-age" title={written.title}>{written.label}</span>
        {/* The click stops here: a click on the node is App's, and selects
            the session the note belongs to. */}
        <button
          type="button"
          className="glyph-btn recap-note-close"
          aria-label={isRecap ? "Hide the recap" : "Hide this note"}
          title="Hide — the mark on the card brings it back"
          onClick={e => { e.stopPropagation(); dismissRecap(data.noteKey); }}
        >×</button>
      </div>
      {/* Its whole text on hover, as the face's line carries it: a status
          note holds three lines here, a running turn often says more, and the
          hover preview that holds the rest does not open at this zoom. */}
      <p className="recap-note-text" title={faceTitle(note.text, tip)}>{note.text}</p>
      {/* Claude Code's guess at the answer to the question above, shown as a
          guess — muted, quoted — and never typed for anybody. One line, so a
          long one is cut, and carries itself whole on hover. */}
      {note.reply && <p className="recap-note-reply" title={`suggested reply “${note.reply}”`}>suggested reply “{note.reply}”</p>}
      {/* The note at a distance, drawn in screen pixels over its own box the
          way a card's face is (AgentNode's NodeFace): its mark and age, and as
          many lines of the note as the box has room for at 1:1. Without it the
          note below the full card was an empty box around a 3px "recap". The
          whole text is the peek's, beside the pointer, and the cut line carries
          it on hover too (faceTitle). Hidden from assistive technology, which
          has the note itself. */}
      <div className="lod-face recap-face" aria-hidden>
        <div className="lod-id">
          <span className="recap-note-mark"><NoteMark recap={isRecap} />{noteTag(note.kind)}</span>
          <span className="recap-face-age" title={faceTitle(written.label, written.title)}>{written.label}</span>
        </div>
        <p className="recap-face-text" title={faceTitle(note.text, tip)}>{note.text}</p>
      </div>
      <Handle type="source" position={Position.Right} style={{ background: "transparent", border: "none" }} />
    </div>
  );
}
