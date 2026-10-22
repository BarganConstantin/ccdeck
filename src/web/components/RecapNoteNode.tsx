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
//
// The session's plan is on it too, every step under the note's words, and a
// session with a plan and nothing else to say has a note holding the plan alone
// (session-note.ts, boardNote).
import React from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { dismissRecap } from "../recap-note";
import { noteSource, noteTag, type SessionNote } from "../session-note";
import { faceTitle } from "../node-face";
import { planSummary, planWindow, planTitle } from "../agent-plan";
import type { AgentPlan, PlanStatus } from "../types";
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
  /** Null when the note holds the session's plan alone. */
  note: SessionNote | null;
  plan?: AgentPlan | null;
  noteKey: string;
  hue: number;
}

export default function RecapNoteNode({ data }: NodeProps<RecapNoteData>) {
  // Its own clock, as the card keeps its own: the node's data is not rebuilt
  // for time passing, and the age is a count of minutes.
  const now = useNow(30_000);
  const note = data.note;
  const plan = data.plan ?? null;
  const isRecap = note?.kind === "recap";
  const written = promptTime(note?.at ?? plan?.at ?? now, now);
  // A status note wears its kind as `status-<kind>`, the prefix the session
  // list's line already uses, so a question, a failure and a finished job read
  // in the same colours in both places.
  const cls = `${isRecap ? "recap-note" : `recap-note is-status status-${note?.kind ?? "plan"}`}${plan ? " has-plan" : ""}`;
  // Who wrote a status note; a recap says so in its mark. On hover it is the
  // full size's alone: the head says it, and the text carries it under the
  // text itself (faceTitle). Never on the note's own box, which the face sits
  // in — a pointer on the face would take it from there, on top of the hover
  // card that already says it. A screen reader has it as the description.
  const tip = isRecap || !note ? undefined : noteSource(note);
  // A note holding the plan alone says so in its mark, with the count, and
  // its list goes without a heading that would say "plan" a second time.
  const count = planSummary(plan);
  const tag = note ? noteTag(note.kind) : `plan ${count ? `${count.done}/${count.total}` : ""}`.trim();
  return (
    <div
      className={cls}
      role="note"
      aria-label={isRecap ? "Claude Code's recap" : `Session note: ${tag}`}
      aria-description={tip}
      style={{ "--session-hue": data.hue } as React.CSSProperties}
    >
      <div className="recap-note-head" title={tip}>
        <span className="recap-note-mark"><NoteMark recap={isRecap} />{tag}</span>
        <span className="recap-note-age" title={written.title}>{written.label}</span>
        {/* The click stops here: a click on the node is App's, and selects
            the session the note belongs to. */}
        <button
          type="button"
          className="glyph-btn recap-note-close"
          aria-label={isRecap ? "Hide the recap" : note ? "Hide this note" : "Hide the plan"}
          title="Hide — the mark on the card brings it back"
          onClick={e => { e.stopPropagation(); dismissRecap(data.noteKey); }}
        >×</button>
      </div>
      {/* Its whole text on hover: a status note holds three lines here, a
          running turn often says more, and the hover card that holds the rest
          does not open at this zoom, so the title is the only way to read it. */}
      {note && <p className="recap-note-text" title={faceTitle(note.text, tip)}>{note.text}</p>}
      {/* Claude Code's guess at the answer to the question above, shown as a
          guess — muted, quoted — and never typed for anybody. One line, so a
          long one is cut, and carries itself whole on hover. */}
      {note?.reply && <p className="recap-note-reply" title={`suggested reply “${note.reply}”`}>suggested reply “{note.reply}”</p>}
      {plan && <NotePlan plan={plan} head={note != null} />}
      {/* The note at a distance, drawn in screen pixels over its own box the
          way a card's face is (AgentNode's NodeFace): its mark and age, and as
          many lines of the note as the box has room for at 1:1. Without it the
          note below the full card was an empty box around a 3px "recap". The
          whole text is the hover card's, beside the pointer, which opens at
          every distance this face is drawn at — so nothing here carries a
          title, or the browser's tooltip would open on top of it with the same
          words. Hidden from assistive technology, which has the note itself. */}
      <div className="lod-face recap-face" aria-hidden>
        <div className="lod-id">
          <span className="recap-note-mark"><NoteMark recap={isRecap} />{tag}</span>
          <span className="recap-face-age">{written.label}</span>
        </div>
        {note && <p className="recap-face-text">{note.text}</p>}
        {plan && <NotePlan plan={plan} head={note != null} face />}
      </div>
      <Handle type="source" position={Position.Right} style={{ background: "transparent", border: "none" }} />
    </div>
  );
}

const PLAN_WORD: Record<PlanStatus, string> = { completed: "done", in_progress: "now", pending: "to do" };

/**
 * The plan on the note: its count, then the steps, marked done, under way or
 * to do the way the details panel marks them — at most five, around the step
 * being worked on, with how many more there are above and below. One line a
 * step, cut rather than wrapped, so the note keeps its height as the work
 * moves down the list and nothing beside it is pushed about. A finished
 * plan is its count alone: the list is history, and the details panel keeps
 * it. On the face it is the same list in screen pixels, cut by the face's
 * height, so a note seen from further away shows fewer steps rather than
 * smaller ones.
 */
function NotePlan({ plan, head, face = false }: { plan: AgentPlan; head: boolean; face?: boolean }) {
  const s = planSummary(plan);
  if (!s) return null;
  const win = planWindow(plan.items);
  return (
    <div className={face ? "recap-face-plan" : "recap-note-plan"} title={face ? undefined : planTitle(plan.items)}>
      {head && (
        <div className="recap-note-plan-head">
          Plan <span className="recap-note-plan-count">{s.done}/{s.total}{s.allDone ? " · done" : ""}</span>
        </div>
      )}
      {!s.allDone && (
        <ol className="plan-list">
          {win.shown.map((item, k) => (
            <li key={item.id ?? `${k}:${item.text}`} className="plan-item" data-status={item.status}>
              <span className="plan-mark" aria-hidden />
              {!face && <span className="vis-hidden">{PLAN_WORD[item.status]}: </span>}
              <span className="plan-text">{item.status === "in_progress" && item.active ? item.active : item.text}</span>
              {item.status === "in_progress" && <span className="plan-now" aria-hidden>now</span>}
            </li>
          ))}
          {/* One line for what the window leaves out, above and below, so a
              long plan is the same height at every step it is on. */}
          {(win.before > 0 || win.after > 0) && (
            <li className="recap-note-plan-more">
              {[win.before > 0 ? `${win.before} earlier` : null, win.after > 0 ? `+${win.after} more` : null].filter(Boolean).join(" · ")}
            </li>
          )}
        </ol>
      )}
    </div>
  );
}
