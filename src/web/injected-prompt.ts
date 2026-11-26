// Claude Code submits some text on the user's behalf through the same
// UserPromptSubmit hook a human's typing arrives on. Two kinds reach the deck.
//
// The notice a background task sends when it finishes:
//
//   <task-notification>
//   <task-id>b055gq9k8</task-id>
//   <status>completed</status>
//   <summary>Background command "Watch CI" completed (exit code 0)</summary>
//   </task-notification>
//
// And a message from another agent: the report a subagent working in the
// background hands back to the session that started it, a teammate's message,
// another session's. Each arrives wrapped, sometimes after one line that says
// where it came from:
//
//   <agent-message from="Smell lens B13">
//   …the report…
//   </agent-message>
//
// Listed verbatim among the prompts, either was noise in the one place a reader
// reads their own words, and it inflated the count (#834). A coordinator whose
// subagents reported back had its card titled `<agent-message from="…`. This
// names them, so the rail can show each as what it is — a system event — and
// count only what was typed.

import { ownRow } from "./own-row";

export interface InjectedPrompt {
  /** What happened, in the deck's words: "background task finished". */
  label: string;
  /** The wrapper's own one-line summary, when it carried one. */
  detail?: string;
}

/** The wrapper has to OPEN the submission. A prompt that mentions the tag
 *  mid-sentence is the human's own text and stays a prompt. */
const TASK_NOTIFICATION = /^\s*<task-notification>([\s\S]*?)<\/task-notification>/;

/** Another agent's message: its opening tag, at the start or after the one
 *  line Claude Code may put before it ("Another Claude session sent a message
 *  while you were working:"), and the attributes the tag carries. */
const AGENT_MESSAGE = /^\s*(?:[^<\n]{0,120}\bsent a message\b[^<\n]{0,80}:\s*)?<(agent-message|teammate-message|cross-session-message)((?:\s+[\w-]+="[^"]*")*)\s*>/;

function tag(body: string, name: string): string | undefined {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1].trim() || undefined;
}

/** An attribute's value as the tag wrote it, entities read back. */
function attr(attrs: string, name: string): string | undefined {
  const raw = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1];
  const value = raw
    ?.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .trim();
  return value || undefined;
}

const STATUS_LABEL: Record<string, string> = {
  completed: "background task finished",
  failed: "background task failed",
  killed: "background task stopped",
};

/** Who sent the message, by the attribute its wrapper names them with. */
const SENDER_ATTR: Record<string, string> = {
  "agent-message": "from",
  "teammate-message": "teammate_id",
  "cross-session-message": "from",
};

/** The system event this submission is, or null when a human typed it. */
export function injectedPrompt(text: string): InjectedPrompt | null {
  const m = TASK_NOTIFICATION.exec(text);
  if (m) {
    const status = tag(m[1], "status");
    return {
      label: (status ? ownRow(STATUS_LABEL, status) : undefined) ?? "background task update",
      detail: tag(m[1], "summary"),
    };
  }
  const message = AGENT_MESSAGE.exec(text);
  if (!message) return null;
  const [, wrapper, attrs] = message;
  const sender = attr(attrs, SENDER_ATTR[wrapper]);
  const summary = attr(attrs, "summary");
  return {
    label: sender ? `message from ${sender}` : wrapper === "cross-session-message" ? "message from another session" : "message from another agent",
    ...(summary ? { detail: summary } : null),
  };
}

/** Only what a human typed — what a prompt count and a first prompt read. */
export function typedPrompts<T extends { text: string }>(prompts: readonly T[]): T[] {
  return prompts.filter(p => !injectedPrompt(p.text));
}
