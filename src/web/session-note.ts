// What a session's note says: the one sentence the deck shows beside a session
// about where it stands — on the canvas as the note tied to its card, in the
// session list under its figures, and in the detail panel.
//
// It began as Claude Code's recap alone, and the recap only speaks once a turn
// has been over for three minutes with the terminal out of focus. Everything
// before that moment is now the same note, saying something else:
//
// - WHILE A TURN RUNS: what the session is doing. A background session's job
//   folder holds Claude Code's own line for that — its classifier's words, the
//   ones `claude agents` prints — and every other session's newest reply is
//   read by the agent view's own free rule (src/server/session-activity.mjs):
//   the sentence the model wrote, or the description on the call it made.
// - ONCE THE TURN IS OVER: a background job's line says what came of it — the
//   question it is stuck on and the reply Claude Code suggests, the headline of
//   what it got done, or why it failed. An interactive session has no such
//   line, so its note keeps the last thing it did, marked as the past it now
//   is, rather than going blank for the minutes before the recap.
// - WHEN THE RECAP COMES: it takes the note's place. The newer of the two
//   speaks, and Claude Code writes its recap after the turn it summarises.
//
// The note is never about a turn a newer prompt has started: the prompt's hook
// reaches the deck before the model has written a word of the next reply, and
// a line from the last turn would describe a session that has moved on. Until
// the model answers, the note says the prompt itself, as Claude Code's agent
// view does — see statusNote.
import { recapShown } from "./session-recap";
import { recapKey } from "./recap-note";
import { injectedPrompt } from "./injected-prompt";
import type { AgentNodeData, BackgroundJob, PromptEntry } from "./types";

/** What a note can be saying. `recap` is Claude Code's recap; `now` a running
 *  turn; `last` the last thing a finished interactive turn did; the other three
 *  a background job's verdict. */
export type NoteKind = "recap" | "now" | "last" | "needs" | "done" | "failed";

export interface SessionNote {
  kind: NoteKind;
  text: string;
  /** Blocked jobs only: the reply Claude Code suggests typing. */
  reply?: string;
  /** When the words were written, epoch ms — the transcript line's clock, or
   *  the job file's. */
  at: number;
  /** Who wrote the words: Claude Code's recap, Claude Code's job classifier,
   *  the deck reading the newest reply, or the prompt that opened a turn the
   *  model has not answered yet. Said in the tooltip, because how far to trust
   *  a line depends on it. */
  source: "recap" | "job" | "activity" | "prompt";
  /** The note's identity for putting it away (recap-note.ts). A recap is its
   *  own sentence, so it keys by when it was written, as it always has. Any
   *  other note keys by the TURN and what kind of thing it says: a "now" line
   *  rewritten every few seconds must stay put away once closed, and a job that
   *  then stops to ask a question is news worth opening for again. */
  key: string;
}

type NoteLine = Pick<SessionNote, "kind" | "text" | "reply" | "at" | "source">;

/** The word in front of the note. Words and not a colour alone: the session
 *  list's row is a button whose name is its contents, so this is heard where it
 *  is seen. */
export function noteTag(kind: NoteKind): string {
  switch (kind) {
    case "recap": return "recap";
    case "needs": return "needs you";
    case "done": return "done";
    case "failed": return "failed";
    case "last": return "last";
    default: return "now";
  }
}

/** A background job's line, or null when it has none worth drawing.
 *
 *  `stopped` says nothing: somebody ended the job, or the supervisor found it
 *  dead, and either way the line it held is about work that is not happening.
 *  Each state falls back to `detail`, which Claude Code always writes, when its
 *  own field is empty. */
export function jobLine(job: BackgroundJob): NoteLine | null {
  let kind: NoteKind;
  let text: string;
  switch (job.state) {
    case "blocked": kind = "needs"; text = job.needs || job.detail; break;
    case "done": kind = "done"; text = job.result || job.detail; break;
    case "failed": kind = "failed"; text = job.detail || job.result || ""; break;
    case "working": kind = "now"; text = job.detail; break;
    default: return null;
  }
  if (!text) return null;
  const line: NoteLine = { kind, text, at: job.updatedAt, source: "job" };
  if (kind === "needs" && job.suggestedReply) line.reply = job.suggestedReply;
  return line;
}

type NoteBearing = Pick<AgentNodeData,
  "kind" | "sessionId" | "state" | "closedAt" | "startedAt" | "prompts" | "recap" | "activity" | "job">;

/** The session's newest prompt, or null when the deck has seen none. */
function newestPrompt(a: NoteBearing): PromptEntry | null {
  let newest: PromptEntry | null = null;
  for (const p of a.prompts) if (!newest || p.at > newest.at) newest = p;
  return newest;
}

/** Room for the same three lines the reply's line gets (session-activity.mjs
 *  caps it at the same 160). */
const PROMPT_MAX_CHARS = 160;

/** A prompt as a note can say it: its first line, or — for the notice Claude
 *  Code submits when a background task finishes — what the notice is, rather
 *  than the XML it arrives wrapped in (injected-prompt.ts). */
export function promptLine(text: string): string {
  const injected = injectedPrompt(text);
  if (injected) return injected.detail ? `${injected.label}: ${injected.detail}` : injected.label;
  const first = text.split("\n").map(l => l.trim()).find(Boolean) ?? "";
  const line = first.replace(/\s+/g, " ");
  return line.length > PROMPT_MAX_CHARS ? line.slice(0, PROMPT_MAX_CHARS - 1).trimEnd() + "…" : line;
}

/**
 * The status half: the job's line when it has one; else the newest reply's, as
 * long as no prompt is newer than that reply; else, while a turn runs that the
 * model has not answered yet, the prompt that started it.
 *
 * That last one is Claude Code's own move — its agent view shows the prompt
 * until the model has said something — and it is what keeps the note on the
 * canvas across a turn boundary. Without it the note went away with every
 * prompt and came back seconds later with the first reply, re-placed beside its
 * card each time.
 */
function statusNote(a: NoteBearing): SessionNote | null {
  const prompt = newestPrompt(a);
  const turn = prompt?.at ?? a.startedAt;
  // "now" and "last" are one note seen before and after the turn ended: put
  // away during the turn, it stays away once the turn ends.
  const keyed = (line: NoteLine): SessionNote =>
    ({ ...line, key: `${a.sessionId}@${line.kind === "last" ? "now" : line.kind}:${turn}` });
  const job = a.job ? jobLine(a.job) : null;
  if (job) return keyed(job);
  const act = a.activity;
  if (act && (!prompt || prompt.at <= act.at)) {
    return keyed({ kind: a.state === "active" ? "now" : "last", text: act.text, at: act.at, source: "activity" });
  }
  if (prompt && a.state === "active") {
    const text = promptLine(prompt.text);
    if (text) return keyed({ kind: "now", text, at: prompt.at, source: "prompt" });
  }
  return null;
}

/**
 * The note to show, or null.
 *
 * A session root only, and not one that has closed — by its own SessionEnd, or
 * by the sweep that settles a session silent for ninety minutes. The waiting
 * badge comes down on the same grounds, and the note explains the same things
 * it does. Then the newer of the status line and the recap (session-recap.ts
 * holds the recap's own rule), with the status line taking a tie.
 */
export function sessionNoteShown(a: NoteBearing): SessionNote | null {
  if (a.kind !== "root" || a.closedAt != null) return null;
  const status = statusNote(a);
  const r = recapShown(a);
  const recap: SessionNote | null = r
    ? { kind: "recap", text: r.text, at: r.at, source: "recap", key: recapKey(a.sessionId, r.at) }
    : null;
  if (status && recap) return recap.at > status.at ? recap : status;
  return status ?? recap;
}

/** Who wrote the note, in words, for its tooltip and its peek. */
export function noteSource(note: SessionNote): string {
  switch (note.source) {
    case "recap": return "Claude Code's recap";
    case "job": return "Claude Code's own line for this background session";
    case "prompt": return "The prompt this turn began with — the model has not answered yet";
    default: return note.kind === "last" ? "What the session did last, until Claude Code's recap" : "From the session's newest reply";
  }
}
