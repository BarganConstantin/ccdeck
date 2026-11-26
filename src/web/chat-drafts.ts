// What is typed in Chat's box and not sent yet, one draft per session (its
// `provider:session` key), held for the page's life rather than a stage's.
// Leaving Workspace takes the stage down (the view switch, Chat's Show on
// Board), and a session can move to another pane: the words are found where
// they were, in whichever pane shows the session. Memory only: nothing is
// written to the browser's storage, and a reload starts with empty boxes.

const kept = new Map<string, string>();

/** The draft for `key`, "" when there is none. */
export function draftFor(key: string): string {
  return kept.get(key) ?? "";
}

/** Holds `text` as the draft for `key`; an empty one is no draft. */
export function keepDraft(key: string, text: string): void {
  if (text) kept.set(key, text);
  else kept.delete(key);
}

/** Every draft gone, as a reload leaves them: for a test's next case. */
export function forgetDraftsForTest(): void {
  kept.clear();
}
