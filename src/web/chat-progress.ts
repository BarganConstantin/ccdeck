// Where a message sent from Chat stands, and what its session is doing: what
// Chat says under the conversation's last line (ChatView draws ChatOutgoing
// and ChatActivity; the stage holds one pending message per session, as it
// holds the drafts).
//
// A SEND IS NOT A DELIVERY. The composer's "sent" (use-terminal-session.ts
// sendPrompt) is the terminal's socket taking the paste and the Enter. The
// text can still sit in the agent's input, or have gone to a dialog that was
// on screen. So the message shows as on its way until the session itself says
// it took it: the board's prompt count moves (Claude Code's UserPromptSubmit,
// Codex's user_message, the same event that makes the board say working), or
// the conversation shows it. If neither comes within CONFIRM_MS of the
// session being free to take it, Chat says it was not taken and points to
// Term. It never sends it again: the first may still be in Term's input, and
// a second would be the same message twice.
//
// THE SESSION'S STATE IS THE HEADER'S. Working, and what with, is the board's
// sentence as the pane's header has it (headerStatus), so Chat, the header and
// Term say one thing. Waiting is drawn only when no card in Chat asks the
// question already. A session at work with no call open that has been silent
// for QUIET_MS says so: from the outside that is a model thinking, a lost
// connection, or (for Codex, which writes no approval request to its rollout,
// codex-approval.ts) a prompt only Term shows.
//
// A TURN YOU STOPPED IS OVER. Claude Code sends no Stop hook for an Esc, so
// the board can go on saying working after one; the conversation's own
// "Interrupted" line, written after the turn's last step, says it ended.
//
// A /COMPACT IS TAKEN WHEN ITS LINE SHOWS. Claude Code says no prompt for it
// and writes its line into the conversation only once it is over, so the
// screen's "Compacting conversation…" (live-activity.ts) is the session taking
// it. Chat's live row speaks for the compaction then, not the working row,
// whose clock is a turn's.
//
// A message Chat's ⋯ sent (`action`), not one typed, is never put back into
// the box when it is not taken (use-chat-returned.ts): the box is the person's.
//
// Imports no screen: this is the stage's half, and ChatView only draws.
import { useEffect, useState } from "react";
import type { ChatActivity, ChatOutgoing, ChatTurn } from "./components/chat/chat-model";
import { clockShort } from "./elapsed-short";
import { isCompactCommand } from "./chat-actions";

/** How long a message the session is free to take may go untaken before Chat says so. */
export const CONFIRM_MS = 10_000;

/** How long a message the session took stays drawn here while the conversation is read again. */
export const TAKEN_GRACE_MS = 5_000;

/** How long a session at work with no call open may go unheard before Chat says so. */
export const QUIET_MS = 120_000;

/** A message sent from Chat that the session has not yet been seen to take, or whose turn is not over. */
export interface ChatPending {
  /** What was sent, as typed. */
  text: string;
  /** The pictures sent with it, when there were any. */
  images?: number;
  /** From when it counts as late: when it went, or when the turn it waited behind ended. */
  since: number;
  /** The board's prompt count when it went. */
  prompts: number;
  /** How many of the conversation's own lines said the same when it went. */
  echoes: number;
  /** The session was at work when it went: it takes the message once that turn ends. */
  behind: boolean;
  /** When the session was first seen to take it. */
  takenAt?: number;
  /** The board said working after it was taken: the next rest ends its turn. */
  worked?: boolean;
  /** Sent by an action of Chat's ⋯, not typed in the box. */
  action?: boolean;
}

/** What the stage knows of the session shown, for its Chat. */
export interface ChatFacts {
  /** The conversation as read (none while it is not). */
  turns: readonly ChatTurn[];
  /** The board's prompt count. */
  prompts: number;
  /** The header's state: "working", "waiting", "idle"… */
  state: string;
  /** The header's tool, argument and time. */
  detail?: string;
  /** A call is open. */
  tool?: boolean;
  /** When the board last heard from the session. */
  heardAt?: number;
  /** The pane takes keys now. */
  connected: boolean;
  /** A card in Chat asks what the session waits on. */
  asked: boolean;
  /** What the agent's own screen says it is doing (use-screen-status.ts). */
  status?: string;
  /** When the turn at work began: the board's last prompt. */
  since?: number;
  /** The screen shows the conversation being compacted (use-live-compaction.ts). */
  compacting?: boolean;
}

/** What Chat draws now, and when that changes by itself. */
export interface ChatShown {
  outgoing?: ChatOutgoing;
  activity?: ChatActivity;
  /** When to look again with no new facts: a message gets late, a grace ends, a silence grows. */
  next?: number;
}

const norm = (text: string) => text.replace(/\s+/g, " ").trim();

/** Whether a turn of the conversation is the message `want` (normalised): what
 *  was typed, or a slash command as typed. The route cuts a long text with "…". */
function says(turn: ChatTurn, want: string): boolean {
  const said = turn.kind === "user" ? turn.text : turn.kind === "command" ? (turn.args ? `${turn.name} ${turn.args}` : turn.name) : null;
  if (said === null) return false;
  const got = norm(said);
  return got === want || (got.endsWith("…") && got.length > 1 && want.startsWith(got.slice(0, -1).trimEnd()));
}

/** How many of the conversation's own lines say `text`. */
export function echoes(turns: readonly ChatTurn[], text: string): number {
  const want = norm(text);
  let n = 0;
  for (const turn of turns) if (says(turn, want)) n++;
  return n;
}

/** The conversation's last line says you stopped the turn. */
export function stoppedInChat(turns: readonly ChatTurn[]): boolean {
  const last = turns[turns.length - 1];
  return last?.kind === "notice" && last.what === "interrupted";
}

/** The session is in a turn: the board says working, and the conversation
 *  does not end on that turn being stopped. */
const atWork = (facts: Pick<ChatFacts, "turns" | "state">) => facts.state === "working" && !stoppedInChat(facts.turns);

/** The record of a message the composer, or an action of Chat's ⋯ (`action`),
 *  just sent, with the pictures it carries. */
export function pendingFor(
  text: string,
  facts: Pick<ChatFacts, "turns" | "prompts" | "state">,
  now: number,
  sent: { action?: boolean; images?: number } = {},
): ChatPending {
  const pending: ChatPending = { text, since: now, prompts: facts.prompts, echoes: echoes(facts.turns, text), behind: atWork(facts) };
  if (sent.action) pending.action = true;
  if (sent.images && sent.images > 0) pending.images = sent.images;
  return pending;
}

/** Whether the session has said it took the message: a /compact, by
 *  compacting. */
export function wasTaken(pending: ChatPending, facts: Pick<ChatFacts, "turns" | "prompts" | "compacting">): boolean {
  return pending.takenAt !== undefined || facts.prompts > pending.prompts || echoes(facts.turns, pending.text) > pending.echoes
    || (facts.compacting === true && isCompactCommand(pending.text));
}

/** The last turn is a question or a plan still waiting: its own card asks it. */
export function waitsInChat(turns: readonly ChatTurn[]): boolean {
  const last = turns[turns.length - 1];
  return (last?.kind === "ask" || last?.kind === "plan") && last.running === true;
}

/** The record after what the session says now: the same object when nothing
 *  moved, a new one when it did, undefined once its turn is over. */
export function settlePending(pending: ChatPending, facts: ChatFacts, now: number): ChatPending | undefined {
  if (!wasTaken(pending, facts)) {
    // The turn it waited behind is over: from now it is the session's to take.
    return pending.behind && !atWork(facts) ? { ...pending, behind: false, since: now } : pending;
  }
  if (pending.takenAt === undefined) return { ...pending, takenAt: now, ...(atWork(facts) ? { worked: true } : {}) };
  if (atWork(facts)) return pending.worked ? pending : { ...pending, worked: true };
  // Its turn is over, or the board never said it began and the grace ran out.
  return pending.worked || now >= pending.takenAt + TAKEN_GRACE_MS ? undefined : pending;
}

const earliest = (a: number | undefined, b: number | undefined) => (a === undefined ? b : b === undefined ? a : Math.min(a, b));

/** What Chat draws at `now`. */
export function chatShown(pending: ChatPending | undefined, facts: ChatFacts, now: number): ChatShown {
  const out: ChatShown = {};
  const taken = pending ? wasTaken(pending, facts) : false;
  if (pending && !taken) {
    const due = pending.since + CONFIRM_MS;
    const late = !facts.connected || (!pending.behind && now >= due);
    out.outgoing = {
      text: pending.text, state: late ? "unconfirmed" : "sending", ...(pending.behind && !late ? { queued: true } : {}),
      ...(pending.action ? { action: true } : {}), ...(pending.images ? { images: pending.images } : {}),
    };
    if (!late && !pending.behind) out.next = due;
  } else if (pending && echoes(facts.turns, pending.text) <= pending.echoes
    && !(pending.takenAt !== undefined && now >= pending.takenAt + TAKEN_GRACE_MS)) {
    // Taken, and the conversation not read again since: drawn here meanwhile.
    out.outgoing = { text: pending.text, state: "taken", ...(pending.action ? { action: true } : {}), ...(pending.images ? { images: pending.images } : {}) };
  }
  if (pending && taken && !pending.worked && pending.takenAt !== undefined) out.next = pending.takenAt + TAKEN_GRACE_MS;
  // Taken, and the board has not said working yet: the session is on it. Not
  // a /compact, which the board never says: the live row speaks for that.
  const working = atWork(facts) || (taken && !pending?.worked && !isCompactCommand(pending?.text ?? ""));
  if (working) {
    const activity: ChatActivity = { state: "working" };
    if (facts.detail) activity.detail = facts.detail;
    if (facts.status) activity.status = facts.status;
    if (facts.since !== undefined) activity.since = facts.since;
    if (!facts.tool && facts.heardAt !== undefined) {
      const silent = now - facts.heardAt;
      if (silent >= QUIET_MS) {
        activity.quiet = clockShort(Math.floor(silent / 1000), false);
        out.next = earliest(out.next, facts.heardAt + (Math.floor(silent / 60_000) + 1) * 60_000);
      } else {
        out.next = earliest(out.next, facts.heardAt + QUIET_MS);
      }
    }
    out.activity = activity;
  } else if (facts.state === "waiting" && !facts.asked) {
    out.activity = { state: "waiting" };
  }
  return out;
}

/**
 * What Chat draws for the session shown, kept true over time: `pending` is
 * that session's record, and `setPending` replaces it (undefined ends it).
 */
export function useChatProgress(
  pending: ChatPending | undefined,
  facts: ChatFacts,
  setPending: (next: ChatPending | undefined) => void,
): ChatShown {
  const [now, setNow] = useState(() => Date.now());
  const shown = chatShown(pending, facts, now);
  // The record follows the session: taken, its turn over, or late from now.
  useEffect(() => {
    if (!pending) return;
    const settled = settlePending(pending, facts, Date.now());
    if (settled !== pending) setPending(settled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, facts.turns, facts.prompts, facts.state, facts.compacting, now]);
  // And Chat looks again when something gets late with no new fact to say so.
  useEffect(() => {
    if (shown.next === undefined) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, shown.next - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [shown.next]);
  return shown;
}
