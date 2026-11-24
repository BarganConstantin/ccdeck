// The keys that answer Claude Code's question prompt (AskUserQuestion) the way a
// person at the terminal would, planned from what Chat shows and what was
// picked there. Pure: questions and picks in, steps out.
//
// WHAT THE PROMPT TAKES (Claude Code 2.1, read from its own code):
// - one choice: the option's digit picks it and moves on; with one question
//   that also submits. Options with a preview are laid out side by side, where
//   a digit only moves the cursor, so Enter follows.
// - several choices: each digit toggles its option and stays; Tab moves on.
// - your own words: the digit after the last option opens "Type something";
//   the words go in, then Enter. Enter on an empty box cancels the question,
//   so it is sent only once the words show.
// - two or more questions, or one with several choices, end on a review
//   screen where "1" submits.
// - "Chat about this": a last row under every question, one choice or
//   several, set apart from the answers by a line (Claude Code 2.1.8 and
//   later). It answers nothing: Claude Code turns the call down with "The user
//   wants to clarify these questions…" and what was answered so far, and
//   Claude asks what you would like to clarify. Its number comes after "Type
//   something" (the options' count + 2), and since about 2.1.160 that digit
//   picks it from anywhere in the list (2.1.162 has it; up to 2.1.150 the
//   number was drawn but only Down and Enter reached the row, and a digit there
//   does nothing). Beside options with a preview the row has no number: the
//   last option's digit moves the cursor to it, Down goes on to the row, and
//   Enter picks it. A screen reader's layout puts the row in the list instead,
//   with the same number, and leaves it out beside several choices; so its
//   step waits for the row's words too, and a prompt that does not draw them
//   takes no key.
//
// EACH STEP WAITS FOR THE SCREEN. Before its keys go, the terminal must show
// what the step expects: the question's opening words and every option's
// label, the typed words, or the review screen. A screen that shows anything
// else stops the answer where it is, so a key never lands on a prompt it was
// not meant for. Keys also go apart, as a person's do (ASK_KEY_GAP_MS in
// use-terminal-session.ts): the prompt reads each one before the next comes,
// and the words go only once "Type something" had time to open its box.
import type { ChatQuestion } from "./components/chat/chat-model";

/** What was picked for one question: options by index, or your own words. */
export interface AskPick {
  options: number[];
  text?: string;
}

/** One key, or text pasted as the terminal pastes it. */
export type AskKey = { input: string } | { paste: string };

export interface AskStep {
  /** Words the screen must show before the keys go; none checks nothing. */
  expect: string[];
  keys: AskKey[];
}

/** The review screen's button: the last step waits for it. */
export const SUBMIT_WORDS = "Submit answers";
/** The row under the options that sets the questions aside to talk them over. */
export const CHAT_WORDS = "Chat about this";
/** The down arrow, as the terminal sends it (sendAsk turns it into ESC O B for
 *  a program that asked for application cursor keys, as a typed arrow is). */
export const DOWN_ARROW = "\x1b[B";
/** Words for one answer: one line, as long as a person would type there. */
export const MAX_ASK_TEXT = 1000;
const LEAD = 32;

/** The opening of a text, whole words, as the screen draws it with any wrap. */
export function lead(text: string, max = LEAD): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return space > 8 ? cut.slice(0, space) : cut;
}

/** The screen's text as one line, so a wrapped line still reads whole. */
export function flatScreen(screen: string): string {
  return screen.replace(/\s+/g, " ");
}

/** Whether the screen shows every expected text. */
export function screenShows(screen: string, expect: readonly string[]): boolean {
  const flat = flatScreen(screen);
  return expect.every(text => flat.includes(text));
}

/** One answer's words as the box takes them: one line, bounded. */
export function askText(text: string | undefined): string {
  return (text ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, MAX_ASK_TEXT);
}

/** Whether a question can be answered from Chat: it has options to pick. */
export function answerable(question: ChatQuestion): boolean {
  return question.options.length > 0;
}

/** Whether every question has a pick that can be sent. */
export function picksComplete(questions: readonly ChatQuestion[], picks: readonly (AskPick | undefined)[]): boolean {
  return questions.every((question, i) => {
    const pick = picks[i];
    if (!pick || !answerable(question)) return false;
    if (askText(pick.text)) return !question.multi && !question.preview;
    return pick.options.length > 0 && pick.options.every(n => n >= 0 && n < question.options.length)
      && (question.multi || pick.options.length === 1);
  });
}

/** The steps that answer `questions` with `picks`, or null when they cannot be sent from here. */
export function askSteps(questions: readonly ChatQuestion[], picks: readonly (AskPick | undefined)[]): AskStep[] | null {
  if (!questions.length || !picksComplete(questions, picks)) return null;
  const steps: AskStep[] = [];
  questions.forEach((question, i) => {
    const pick = picks[i]!;
    const shows = [lead(question.question), ...question.options.map(option => lead(option.label))];
    const text = askText(pick.text);
    if (text) {
      steps.push({ expect: shows, keys: [{ input: String(question.options.length + 1) }] });
      steps.push({ expect: [], keys: [{ paste: text }] });
      steps.push({ expect: [lead(text)], keys: [{ input: "\r" }] });
    } else if (question.multi) {
      const digits = [...new Set(pick.options)].sort((a, b) => a - b).map(n => ({ input: String(n + 1) }));
      steps.push({ expect: shows, keys: [...digits, { input: "\t" }] });
    } else if (question.preview) {
      steps.push({ expect: shows, keys: [{ input: String(pick.options[0] + 1) }, { input: "\r" }] });
    } else {
      steps.push({ expect: shows, keys: [{ input: String(pick.options[0] + 1) }] });
    }
  });
  if (questions.length > 1 || questions[0].multi) steps.push({ expect: [SUBMIT_WORDS], keys: [{ input: "1" }] });
  return steps;
}

/** The step that picks "Chat about this" on the prompt's first question, the
 *  one it opens on; null when the row has no one-digit way there (a question
 *  with no options, or more options than a digit reaches). The step waits for
 *  the question, its options and the row, as an answer's first step does. */
export function chatSteps(questions: readonly ChatQuestion[]): AskStep[] | null {
  const first = questions[0];
  if (!first || !answerable(first)) return null;
  const count = first.options.length;
  const expect = [lead(first.question), ...first.options.map(option => lead(option.label)), CHAT_WORDS];
  if (first.preview) {
    return count <= 9 ? [{ expect, keys: [{ input: String(count) }, { input: DOWN_ARROW }, { input: "\r" }] }] : null;
  }
  return count + 2 <= 9 ? [{ expect, keys: [{ input: String(count + 2) }] }] : null;
}

/** Whether Chat can offer "Chat about this" for these questions. */
export function offersChat(questions: readonly ChatQuestion[]): boolean {
  return chatSteps(questions) !== null;
}
