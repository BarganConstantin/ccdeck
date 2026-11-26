// What an alert card says about a session that waits on you, and which
// answers it offers. Pure: the board's facts in, the card's model out.
//
// THE ANSWERS ARE FEW ON PURPOSE. A permission prompt offers "Allow once"
// (the prompt's row 1, "Yes", nothing more) and "Deny" (its "No" row); a
// question with one single-choice question offers its options, four at most.
// A plan, a question with several parts or several picks, a session the deck
// cannot answer from Chat (Codex, opencode, Copilot): "Open in Chat" alone.
// Every answer is an intent (answer-intent.ts) that the prompt's own card
// presses once its words are checked, never a key sent from here.
import type { BlockedSession } from "./ambient-counts";
import type { IntentKind } from "./answer-intent";
import { t as tNow, type TFunction } from "./i18n";
import type { ToolCall } from "./types";

/** The most options a question card offers as buttons. */
export const MAX_ALERT_OPTIONS = 4;

export type AlertKind = "permission" | "question" | "plan" | "other";

/** One answer button. */
export interface AlertChoice {
  /** The button's words. */
  text: string;
  /** The words of the prompt's row it picks. */
  label: string;
  /** The row's place, from 0; null for a row found by its words (Deny). */
  index: number | null;
  intent: IntentKind;
}

export interface AlertModel {
  sessionId: string;
  /** The session's name, as the waiting queue says it. */
  name: string;
  kind: AlertKind;
  /** What it asks: "Bash: npm test", the question, "Approve the plan". */
  what: string;
  /** The call the alert names, compared against the card's (answer-intent.ts sameCall). */
  detail?: string;
  /** The block's start: another block is another alert. */
  since: number;
  /** The answer buttons; none means "Open in Chat" alone. */
  choices: AlertChoice[];
}

const ASK_TOOL = "AskUserQuestion";
const PLAN_TOOL = "ExitPlanMode";

/** A question the call asked, as the card offers it: its words and, when it
 *  is one single-choice question, its options. */
export interface AlertQuestion {
  question: string;
  options: string[];
}

/** The one question of an AskUserQuestion call's input that can be answered
 *  from an alert, or null: several questions, several picks, no options, or
 *  more than the card offers. `question` is set whenever the input has one. */
export function alertQuestion(input: unknown): { question: string; options: string[] | null } | null {
  if (!input || typeof input !== "object") return null;
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const first = questions[0] as { question?: unknown; options?: unknown; multiSelect?: unknown };
  const question = typeof first?.question === "string" ? first.question.trim() : "";
  if (!question) return null;
  if (questions.length !== 1 || first.multiSelect === true || !Array.isArray(first.options)) return { question, options: null };
  const options = first.options.map(o => (o && typeof o === "object" && typeof (o as { label?: unknown }).label === "string" ? (o as { label: string }).label.trim() : ""));
  if (options.length < 2 || options.length > MAX_ALERT_OPTIONS || options.some(o => !o)) return { question, options: null };
  return { question, options };
}

/** The session's newest call still in flight, which is the one a prompt that
 *  just went up is about (waiting-block.ts blockedCall). */
export function pendingCall(calls: Iterable<ToolCall>, owner: (agentId: string | undefined) => string | undefined, sessionId: string, since: number): ToolCall | null {
  let newest: ToolCall | null = null;
  for (const call of calls) {
    if (call.endedAt != null || owner(call.agentId) !== sessionId) continue;
    // A call that began after the block cannot be what it is about.
    if (call.startedAt > since + 1000) continue;
    if (!newest || call.startedAt > newest.startedAt) newest = call;
  }
  return newest;
}

export interface AlertFacts {
  /** The session's provider: only Claude's prompts are answered from Chat. */
  provider?: string;
  /** The session's newest call in flight (pendingCall). */
  pending?: ToolCall | null;
}

/** The card for a waiting session. */
export function alertFor(b: BlockedSession, facts: AlertFacts = {}, tr: TFunction = tNow): AlertModel {
  const name = b.name ?? b.label;
  const base = { sessionId: b.id, name, since: b.waiting.since };
  const claude = (facts.provider ?? "claude") === "claude";
  const callName = facts.pending?.name ?? b.waiting.tool?.name;
  if (callName === PLAN_TOOL) {
    return { ...base, kind: "plan", what: tr("board.chat.alert.plan"), choices: [] };
  }
  if (callName === ASK_TOOL || (b.waiting.kind === "asked" && !b.waiting.tool)) {
    const asked = facts.pending?.name === ASK_TOOL ? alertQuestion(facts.pending.input) : null;
    const what = asked?.question || b.waiting.message || tr("board.chat.alert.question");
    const choices: AlertChoice[] = claude && asked?.options
      ? asked.options.map((label, index) => ({ text: label, label, index, intent: "question" as const }))
      : [];
    return { ...base, kind: "question", what, choices };
  }
  if (b.waiting.kind === "permission") {
    const tool = b.waiting.tool;
    const what = tool ? (tool.preview ? `${tool.name}: ${tool.preview}` : tool.name) : b.waiting.message || tr("board.chat.alert.permission");
    const choices: AlertChoice[] = claude ? [
      { text: tr("board.chat.alert.allowOnce"), label: "Yes", index: 0, intent: "permission" },
      { text: tr("board.chat.alert.deny"), label: "No", index: null, intent: "permission" },
    ] : [];
    // A command is compared with the card's own line; a path may be spelled
    // another way there, and its prompt's words are checked all the same.
    return { ...base, kind: "permission", what, ...(tool?.name === "Bash" && tool.preview ? { detail: tool.preview } : null), choices };
  }
  return { ...base, kind: "other", what: b.waiting.message || tr("board.chat.alert.question"), choices: [] };
}
