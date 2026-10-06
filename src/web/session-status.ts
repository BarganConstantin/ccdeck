// The one line a session's row says about where it stands, in words.
//
// Two sources, one rule about which speaks:
//
// - A BACKGROUND session's job folder, which holds Claude Code's own line —
//   written by its classifier, the same words `claude agents` prints: what the
//   job is doing, the question it is stuck on and the reply Claude Code would
//   suggest, or the headline of what it got done. When there is one, it is the
//   better line and it wins: the deck has nothing that knows more.
// - Every other session's newest reply, read by the agent view's own free rule
//   (src/server/session-activity.mjs): the sentence the model wrote, or the
//   description on the call it made. That is a line about a turn that is
//   RUNNING, so it is shown only while one is, and never once a prompt newer
//   than it exists — the prompt's hook reaches the deck before the model has
//   written a word of the next reply, and a line from the last turn would
//   describe a session that has already moved on.
//
// The recap is the third thing a row can say, and session-list rows ask this
// and session-recap.ts side by side; see `rowLines` for which one wins.
import type { AgentNodeData, BackgroundJob, SessionRecap } from "./types";

export type StatusKind = "now" | "needs" | "done" | "failed";

export interface StatusLine {
  kind: StatusKind;
  text: string;
  /** Blocked jobs only: the reply Claude Code suggests typing. */
  reply?: string;
  /** When the words were written, epoch ms — the job file's clock, or the
   *  transcript line's. */
  at: number;
  /** Where the words came from, for the tooltip: a reader deciding how much to
   *  trust a line should know whether a classifier wrote it. */
  source: "job" | "activity";
}

/** The word in front of the line. Words and not a colour alone: the row is a
 *  button whose name is its contents, so this is heard where it is seen. */
export function statusTag(kind: StatusKind): string {
  switch (kind) {
    case "needs": return "needs you";
    case "done": return "done";
    case "failed": return "failed";
    default: return "now";
  }
}

/** A background job's line, or null when it has none worth drawing.
 *
 *  `stopped` says nothing: somebody ended the job, or the supervisor found it
 *  dead, and either way the line it held is about work that is not happening.
 *  Each state falls back to `detail`, which Claude Code always writes, when its
 *  own field is empty. */
export function jobLine(job: BackgroundJob): StatusLine | null {
  let kind: StatusKind;
  let text: string;
  switch (job.state) {
    case "blocked": kind = "needs"; text = job.needs || job.detail; break;
    case "done": kind = "done"; text = job.result || job.detail; break;
    case "failed": kind = "failed"; text = job.detail || job.result || ""; break;
    case "working": kind = "now"; text = job.detail; break;
    default: return null;
  }
  if (!text) return null;
  const line: StatusLine = { kind, text, at: job.updatedAt, source: "job" };
  if (kind === "needs" && job.suggestedReply) line.reply = job.suggestedReply;
  return line;
}

type StatusBearing = Pick<AgentNodeData, "kind" | "state" | "closedAt" | "prompts" | "activity" | "job">;

/**
 * The line to show, or null.
 *
 * - A session root only, and not one that has closed: SessionEnd, or the sweep
 *   that settles a session silent for ninety minutes. The waiting badge comes
 *   down on the same grounds, and this line explains the same things it does.
 * - The job's line whenever it has one.
 * - Otherwise the activity line, only while a turn is running and only while
 *   no prompt is newer than it.
 */
export function statusShown(a: StatusBearing): StatusLine | null {
  if (a.kind !== "root" || a.closedAt != null) return null;
  if (a.job) {
    const line = jobLine(a.job);
    if (line) return line;
  }
  const act = a.activity;
  if (!act || a.state !== "active") return null;
  for (const p of a.prompts) if (p.at > act.at) return null;
  return { kind: "now", text: act.text, at: act.at, source: "activity" };
}

/**
 * What a row draws under its figures: the status line, the recap, or neither —
 * never both, because they answer the same question and the row has three
 * lines of room.
 *
 * They rarely meet. The activity line needs a running turn and the recap needs
 * a finished one, so an interactive session can only ever have one of them. A
 * background job can have both — a "done" headline, and a recap Claude Code
 * wrote when somebody opened the job later — and then the newer one speaks,
 * because it was written knowing everything the older one did.
 */
export function rowLines(status: StatusLine | null, recap: SessionRecap | null): {
  status: StatusLine | null;
  recap: SessionRecap | null;
} {
  if (status && recap) return recap.at > status.at ? { status: null, recap } : { status, recap: null };
  return { status, recap };
}
