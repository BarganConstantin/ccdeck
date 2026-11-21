// What Chat draws, as props, and how adjacent replies are grouped. Turns come from
// the session's transcript (src/server/transcript-turns.mjs) and read through
// use-session-transcript.ts. A test hands ChatView a stand-in; every line below
// is transcript text, so none of it is held in src/.
import type { AskPick } from "../../ask-keys";
import type { AskSendResult } from "../../use-terminal-session";

/** One line of the conversation. */
export type ChatTurn =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | {
      kind: "tool";
      /** "Read", "Edit", "Bash"… */
      name: string;
      /** Its argument, one line: "src/server/routes.ts". */
      arg: string;
      /** The note at the row's end: "182 lines", "+4 −1", "running". */
      note?: string;
      /** The call is still in flight. */
      running?: boolean;
      /** Which mark the row wears. */
      mark?: "file" | "search" | "terminal";
    }
  /** Questions the assistant asked you (AskUserQuestion), with their options. */
  | {
      kind: "ask";
      questions: ChatQuestion[];
      /** Still waiting for your answer. */
      running?: boolean;
      /** Once answered: what was chosen, per question in order; "" when left unanswered. */
      answers?: string[];
      /** What you wrote back instead of choosing. */
      reply?: string;
    }
  /** A plan the assistant asks you to approve (ExitPlanMode), in Markdown. */
  | {
      kind: "plan";
      /** The plan; "" when the call kept it elsewhere. */
      text: string;
      /** The plan was longer than the transcript keeps: the rest is in Term. */
      cut?: boolean;
      /** Still waiting for your answer. */
      running?: boolean;
      /** Once answered: whether it was approved. */
      approved?: boolean;
    }
  /** What you answered and how long it took, after the card folds. */
  | { kind: "record"; text: string };

export interface ChatQuestion {
  /** The short tag over the question: "Scope". May be "". */
  header: string;
  question: string;
  /** Several options may be chosen. */
  multi: boolean;
  /** Its options carry a preview, which Claude Code lays out side by side. */
  preview?: boolean;
  /** None when it asks for text or a number: then it is answered in Term. */
  options: { label: string; description: string }[];
}

/** How Chat answers a waiting question: the stage's, handed down to the card. */
export interface ChatAsk {
  /** Why an answer cannot go from here right now; none when it can. */
  blocked?: string;
  /** Sends the picks as the keys a person would press, once Term shows the question. */
  send(questions: ChatQuestion[], picks: AskPick[]): Promise<AskSendResult>;
  onShowTerm?(): void;
}

export interface ChatSince {
  toolCalls: number;
  /** "now asking", or what the session is doing now. */
  label: string;
}

export type ChatSource =
  | { state: "loading" }
  | { state: "error"; message: string; onRetry?(): void }
  | { state: "ready"; turns: ChatTurn[]; since?: ChatSince };

export type ConversationBlock =
  | { kind: "user" | "record"; text: string; index: number }
  | { kind: "assistant"; turns: ChatTurn[]; index: number };

/** Keep an assistant's prose and tool calls together, in transcript order. */
export function conversationBlocks(turns: ChatTurn[]): ConversationBlock[] {
  const blocks: ConversationBlock[] = [];
  turns.forEach((turn, index) => {
    if (turn.kind === "user" || turn.kind === "record") {
      blocks.push({ kind: turn.kind, text: turn.text, index });
      return;
    }
    const last = blocks.at(-1);
    if (last?.kind === "assistant") last.turns.push(turn);
    else blocks.push({ kind: "assistant", turns: [turn], index });
  });
  return blocks;
}
