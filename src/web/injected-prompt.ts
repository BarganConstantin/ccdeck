// Claude Code submits some text on the user's behalf through the same
// UserPromptSubmit hook a human's typing arrives on. The one this deck has met
// is the notice a background task sends when it finishes:
//
//   <task-notification>
//   <task-id>b055gq9k8</task-id>
//   <status>completed</status>
//   <summary>Background command "Watch CI" completed (exit code 0)</summary>
//   </task-notification>
//
// Listed verbatim among the prompts, it was noise in the one place a reader
// reads their own words, and it inflated the count (#834). This names it, so
// the rail can show it as what it is — a system event — and count only what was
// typed.

export interface InjectedPrompt {
  /** What happened, in the deck's words: "background task finished". */
  label: string;
  /** The wrapper's own one-line summary, when it carried one. */
  detail?: string;
}

/** The wrapper has to OPEN the submission. A prompt that mentions the tag
 *  mid-sentence is the human's own text and stays a prompt. */
const TASK_NOTIFICATION = /^\s*<task-notification>([\s\S]*?)<\/task-notification>/;

function tag(body: string, name: string): string | undefined {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1].trim() || undefined;
}

const STATUS_LABEL: Record<string, string> = {
  completed: "background task finished",
  failed: "background task failed",
  killed: "background task stopped",
};

/** The system event this submission is, or null when a human typed it. */
export function injectedPrompt(text: string): InjectedPrompt | null {
  const m = TASK_NOTIFICATION.exec(text);
  if (!m) return null;
  const status = tag(m[1], "status");
  return {
    label: (status && Object.hasOwn(STATUS_LABEL, status) ? STATUS_LABEL[status] : undefined) ?? "background task update",
    detail: tag(m[1], "summary"),
  };
}

/** Only what a human typed — what a prompt count and a first prompt read. */
export function typedPrompts<T extends { text: string }>(prompts: readonly T[]): T[] {
  return prompts.filter(p => !injectedPrompt(p.text));
}
