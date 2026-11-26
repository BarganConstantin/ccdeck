// What Chat's ⋯ offers for the session in its pane, and how a Compact is
// followed to its end. Pure but for the one stored choice (storage.ts); the
// stage decides (TerminalStage.tsx), the header draws (ChatMenu.tsx) and
// use-chat-compact.ts holds a run. Imports no screen: types cross from
// components/chat/, values never.
//
// WHAT IS WHOSE. A status line drawn under Claude Code's input is the
// person's own (Claude Code's statusLine setting): buttons like Review or
// Audit there run commands they wrote, and the deck neither reads nor copies
// them. What the menu offers is what the deck owns or Claude Code itself does:
//   Compact          Claude Code's /compact, sent the way the composer sends
//                    one typed in the box; Claude Code only (below).
//   Copy last reply  the words the last reply's own Copy puts on the clipboard.
//   Show on Board    the deck's jump to the session's card.
//   Show Term        the pane's own switch: the status line, the person's own
//                    commands and Claude Code's dialogs are there.
// Any other command is typed in the box, whose list offers the ones this
// session already ran (chat-compose.ts).
//
// COMPACT ONLY WHERE ITS END CAN BE SEEN. The box's slash list is Claude
// Code's built-ins, and a compaction is followed by what Claude Code shows:
// its spinner line while it runs (live-activity.ts) and the /compact line the
// transcript gains once it is over. Codex has a /compact of its own whose
// screen and record the deck does not read, so there it stays typed.
//
// A RUN ENDS ONCE. Sent, it has started when the screen says "Compacting
// conversation…". It ends when the conversation gains its /compact line: done,
// or failed when Claude Code printed an error there (a cancel is a failure that
// says so); or when the line goes and the turn says it was interrupted. A line
// gone with no record after COMPACT_SETTLE_MS is said as it is: an end the
// conversation does not show. One never seen to start ends after
// COMPACT_START_MS, or at once when the message itself was not taken, which
// Chat says already under the conversation.
import type { ChatTurn } from "./components/chat/chat-model";
import type { MessageKey, TFunction } from "./i18n";
import type { Provider } from "./types";
import { contextFigure } from "./context-figure";
import { fmtCost } from "./pricing";
import { sessionSpendLabel } from "./board-usage";
import { readStored, writeStored } from "./storage";

/** What Compact sends: Claude Code's own command, as it would be typed. */
export const COMPACT_COMMAND = "/compact";

/** How long after the compaction's line goes its record may take to be read. */
export const COMPACT_SETTLE_MS = 10_000;

/** How long a sent /compact may go without its line before the run ends. */
export const COMPACT_START_MS = 20_000;

/** Whether the menu offers Compact for a session of `provider`. */
export function compactOffered(provider: Provider | undefined): boolean {
  return provider === "claude";
}

/** Whether `text`, sent, is a /compact (with or without instructions after it). */
export function isCompactCommand(text: string): boolean {
  return /^\s*\/compact(?:\s|$)/.test(text);
}

type CommandTurn = Extract<ChatTurn, { kind: "command" }>;

const isCompactTurn = (turn: ChatTurn): turn is CommandTurn => turn.kind === "command" && turn.name === COMPACT_COMMAND;

/** How many /compact lines the conversation as read holds. */
export function compactMarks(turns: readonly ChatTurn[]): number {
  let n = 0;
  for (const turn of turns) if (isCompactTurn(turn)) n++;
  return n;
}

/** Whether the conversation holds a /compact line written at or after
 *  `since`: the compaction the screen showed from then is over, whatever the
 *  screen's last reads still hold (they let its line go only after a miss or two). */
export function compactedSince(turns: readonly ChatTurn[], since: number): boolean {
  return turns.some(turn => isCompactTurn(turn) && turn.at !== undefined && turn.at >= since);
}

/** A compaction asked for: when, how many /compact lines the conversation held
 *  then, whether its line was seen, and when that line went. */
export interface CompactRun {
  at: number;
  marks: number;
  seen: boolean;
  goneAt?: number;
}

/** A run that begins now, on the conversation as read. */
export function compactRun(turns: readonly ChatTurn[], now: number): CompactRun {
  return { at: now, marks: compactMarks(turns), seen: false };
}

/** How a run ended. `untaken`: the message was not taken, and Chat says so already. */
export type CompactEnd = "done" | "failed" | "cancelled" | "unknown" | "unseen" | "untaken";

/** What is said when a run ends; null for an end said elsewhere. */
export const COMPACT_SAID: Readonly<Record<CompactEnd, MessageKey | null>> = {
  done: "board.chat.actions.compact.done",
  failed: "board.chat.actions.compact.failed",
  cancelled: "board.chat.actions.compact.cancelled",
  unknown: "board.chat.actions.compact.unknown",
  unseen: "board.chat.actions.compact.unseen",
  untaken: null,
};

/** The words Claude Code's error uses when the compaction was called off. */
const CALLED_OFF = /cancel|abort|interrupt/i;

/** The run's record: a /compact line the conversation gained since it began,
 *  or null. Counted against the lines there were, and, since the window the
 *  conversation is read in can slide, any written after the run began. */
export function compactRecord(run: CompactRun, turns: readonly ChatTurn[]): CommandTurn | null {
  const marks = turns.filter(isCompactTurn);
  if (marks.length > run.marks) return marks[marks.length - 1];
  for (let i = marks.length - 1; i >= 0; i--) {
    const at = marks[i].at;
    if (at !== undefined && at >= run.at) return marks[i];
  }
  return null;
}

/** What a run is looked at with. */
export interface CompactFacts {
  turns: readonly ChatTurn[];
  /** The screen shows the compaction's line now. */
  compacting: boolean;
  /** The /compact sent was not taken in time (chat-progress.ts). */
  untaken?: boolean;
}

/** The run after one look: the same object when nothing moved, null once it
 *  ended (`end` says how), and `next`, when to look again with no new fact. */
export interface CompactStep {
  run: CompactRun | null;
  end?: CompactEnd;
  next?: number;
}

export function compactStep(run: CompactRun, f: CompactFacts, now: number): CompactStep {
  const record = compactRecord(run, f.turns);
  if (record) return { run: null, end: !record.failed ? "done" : CALLED_OFF.test(record.output ?? "") ? "cancelled" : "failed" };
  if (f.compacting) return { run: run.seen && run.goneAt === undefined ? run : { at: run.at, marks: run.marks, seen: true } };
  if (run.seen) {
    // Esc in Term: the turn says it was interrupted.
    if (f.turns.some(turn => turn.kind === "notice" && turn.what === "interrupted" && turn.at !== undefined && turn.at >= run.at)) {
      return { run: null, end: "cancelled" };
    }
    const gone = run.goneAt ?? now;
    if (now >= gone + COMPACT_SETTLE_MS) return { run: null, end: "unknown" };
    return { run: run.goneAt === undefined ? { ...run, goneAt: now } : run, next: gone + COMPACT_SETTLE_MS };
  }
  if (f.untaken) return { run: null, end: "untaken" };
  if (now >= run.at + COMPACT_START_MS) return { run: null, end: "unseen" };
  return { run, next: run.at + COMPACT_START_MS };
}

/** Why Compact cannot be pressed now, or null when it can: why nothing can be
 *  sent from Chat (the composer's own words), a compaction under way, or a
 *  turn at work. */
export function compactBlocked(
  o: { unavailable?: string; compacting: boolean; working: boolean },
  t: TFunction,
  agent: string,
): string | null {
  if (o.unavailable) return o.unavailable;
  if (o.compacting) return t("board.chat.actions.compacting");
  if (o.working) return t("board.chat.actions.afterTurn", { agent });
  return null;
}

/** The kinds that start a block of your own (chat-model.ts conversationBlocks). */
const OWN: ReadonlySet<string> = new Set(["user", "command", "record"]);

/** A reply's words, what its own Copy takes: its prose, paragraph by paragraph,
 *  in Markdown as the model wrote it. */
export function replyText(turns: readonly ChatTurn[]): string {
  return turns
    .filter((turn): turn is Extract<ChatTurn, { kind: "assistant" }> => turn.kind === "assistant")
    .map(turn => turn.text)
    .join("\n\n");
}

/** The words of the last reply that has any, "" when none has. */
export function lastReply(turns: readonly ChatTurn[]): string {
  let end = turns.length;
  while (end > 0) {
    let start = end - 1;
    while (start >= 0 && !OWN.has(turns[start].kind)) start--;
    const text = replyText(turns.slice(start + 1, end));
    if (text) return text;
    end = start;
  }
  return "";
}

/** What Session details says, a sentence a row: how full the context window
 *  is, as the header's chip names it, and the session's spend, as its row in
 *  the Sessions list says it. A figure the deck does not have is left out,
 *  never drawn as a zero. */
export function sessionDetails(o: { context?: { used: number; window: number } | null; spend?: number }, t: TFunction): string[] {
  const rows: string[] = [];
  if (o.context && o.context.used > 0) rows.push(t("board.stage.contextShort", { pct: contextFigure(o.context.used, o.context.window) }));
  if (o.spend !== undefined && o.spend > 0) rows.push(t("board.row.spend", { cost: fmtCost(o.spend), label: sessionSpendLabel() }));
  return rows;
}

/** Whether Session details is open: one choice per browser, closed until it is opened. */
export const CHAT_DETAILS_KEY = "agent-dag.chatDetails";

export function readDetailsOpen(): boolean {
  return readStored(CHAT_DETAILS_KEY) === "1";
}

export function writeDetailsOpen(open: boolean): void {
  writeStored(CHAT_DETAILS_KEY, open ? "1" : "0");
}
