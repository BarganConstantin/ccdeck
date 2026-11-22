// What Chat draws, as props, and how adjacent replies are grouped. Turns come from
// the session's transcript (src/server/transcript-turns.mjs) and read through
// use-session-transcript.ts. A test hands ChatView a stand-in; every line below
// is transcript text, so none of it is held in src/.
import type { AskPick } from "../../ask-keys";
import type { AskSendResult } from "../../use-terminal-session";

/** One line of the conversation. */
export type ChatTurn =
  | {
      kind: "user";
      /** What you typed; "" when you sent only images. */
      text: string;
      /** How many images you sent with it; none are carried, only counted. */
      images?: number;
    }
  /** A slash command you ran ("/model opus"), with what a local command printed. */
  | {
      kind: "command";
      /** As typed: "/model", "/plugin:skill". */
      name: string;
      args?: string;
      /** What it printed, as plain text, cut. */
      output?: string;
      /** It printed on stderr: it failed. */
      failed?: boolean;
    }
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
      /** The call failed: what it said, trimmed and cut. May be "" when it said nothing. */
      error?: string;
      /** You answered No at its permission prompt: it did not run. */
      declined?: boolean;
      /** What an edit changed (Edit, MultiEdit, Write), as diff lines. */
      diff?: ChatDiff;
    }
  /** The assistant's task list (TodoWrite): each call is the whole list as it stands. */
  | { kind: "todo"; items: ChatTodo[] }
  /** Why the assistant stopped: you interrupted it, or a request to the API failed. */
  | {
      kind: "notice";
      what: "interrupted" | "error";
      /** An error's first line: "API Error: 529 …". */
      text?: string;
    }
  /** A sub-agent the assistant started (Agent, or Task in older versions). */
  | {
      kind: "agent";
      /** Its subagent_type: "Explore". May be "". */
      type: string;
      /** What it was asked to do, one line. */
      description: string;
      /** Still working. */
      running?: boolean;
      /** It ended with an error. */
      failed?: boolean;
      /** You answered No at its permission prompt: it did not start. */
      declined?: boolean;
      /** It was started in the background: launched, not finished. */
      background?: boolean;
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

/** An edit's change. Lines start " " (kept), "-" (removed) or "+" (added);
 *  a "…" line parts two hunks. */
export interface ChatDiff {
  lines: string[];
  /** The change was longer than the transcript keeps. */
  cut?: boolean;
}

/** One item of the task list. */
export interface ChatTodo {
  text: string;
  status: "pending" | "active" | "done";
}

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

/** The part of the conversation before the turns held, offered on request. */
export interface ChatOlder {
  /** Reads it and puts it in front of the turns. */
  load(): void;
  loading?: boolean;
  /** The last try could not read it; pressing again tries again. */
  failed?: boolean;
}

export type ChatSource =
  | { state: "loading" }
  | { state: "error"; message: string; onRetry?(): void }
  /** A session whose conversation the deck does not read at all (opencode,
   *  Copilot): a fact about the session, said as calmly as an empty
   *  conversation is, never as an error, and never retried. */
  | { state: "absent"; message: string }
  | {
      state: "ready";
      turns: ChatTurn[];
      since?: ChatSince;
      /** Offered only while an older part exists and the host keeps fewer turns than it may. */
      older?: ChatOlder;
      /** Moves by the turns put in front of (or taken from before) the ones
       *  there were: the view keeps the line being read in place, and its keys
       *  steady, by it. */
      head?: number;
    };

/** A turn drawn on your side of the conversation, or a record of it: a block of its own. */
type OwnTurn = Extract<ChatTurn, { kind: "user" | "command" | "record" }>;

export type ConversationBlock =
  | (OwnTurn & { index: number })
  | { kind: "assistant"; turns: ChatTurn[]; index: number };

/** The kinds that start the assistant's block. */
const ASSISTANT_KINDS: ReadonlySet<string> = new Set(["assistant", "tool", "todo", "notice", "agent", "ask", "plan"]);

/** Keep an assistant's prose and tool calls together, in transcript order. A
 *  kind this build does not know (a newer host's) is drawn as nothing: it
 *  starts no block, and inside one it keeps its place so the turns after it
 *  keep their index. */
export function conversationBlocks(turns: ChatTurn[]): ConversationBlock[] {
  const blocks: ConversationBlock[] = [];
  turns.forEach((turn, index) => {
    if (turn.kind === "user" || turn.kind === "command" || turn.kind === "record") {
      blocks.push({ ...turn, index });
      return;
    }
    const last = blocks.at(-1);
    if (last?.kind === "assistant") last.turns.push(turn);
    else if (ASSISTANT_KINDS.has(turn.kind)) blocks.push({ kind: "assistant", turns: [turn], index });
  });
  return blocks;
}
