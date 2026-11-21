// Claude Code's permission prompt and its plan approval, read off the live
// screen, as the Decision card draws them and as the keys that answer them.
// Pure: a screen's text in, a prompt out; a prompt and a pick in, keys out.
//
// WHY THE SCREEN AND NOT THE TRANSCRIPT. The transcript says a tool call is
// waiting, never what the prompt offers: the options change with the tool,
// the folder, the session's mode and the version (2.1 builds the plan's rows
// from its settings: "Yes, clear context… and auto-accept edits", "Yes,
// auto-accept edits", "Yes, manually approve edits", sometimes Ultraplan, and
// "No, keep planning"). So the rows are the screen's own, word for word, and a
// screen this file cannot read draws no card at all.
//
// WHAT CHAT MAY ANSWER (the Decision card's design: a row that changes the
// session's rules or mode is shown and locked, "only in the terminal"):
// - permission: "Yes" runs the call once; "No…" refuses it, and Claude stops
//   for your next message. "Yes, and don't ask again…", "Yes, allow…" and
//   "Yes, and always allow…" change the rules: locked.
// - plan: "Yes, manually approve edits" starts the plan and every edit still
//   asks; "No, keep planning" takes your words. Every other row changes the
//   mode or clears the context: locked.
//
// THE KEYS ARE THE PROMPT'S OWN (Claude Code 2.1's select, as in ask-keys.ts):
// a row's digit picks it; on a row that takes words ("No, keep planning") the
// digit opens the box, the words go in, then Enter once they show. Each step
// waits until the screen shows what it answers (use-terminal-session.ts).
import { flatScreen, lead, MAX_ASK_TEXT, type AskStep } from "./ask-keys";

export type PromptKind = "permission" | "plan";

export interface ScreenPrompt {
  kind: PromptKind;
  /** The prompt's question, the last sentence above its rows: "Do you want to proceed?". */
  question: string;
  /** The rows in order, as the screen draws them; row i is picked with digit i + 1. */
  options: string[];
}

/** What Chat may do with a row. */
export type RowRole = "answer" | "words" | "locked";

/** The question at the end of the text over the rows: a permission prompt's
 *  ("Do you want to proceed?", "Do you want to make this edit to a.ts?") and
 *  the plan's ("Claude has written up a plan and is ready to execute. Would you
 *  like to proceed?"). The last one on the text wins, a path's dots included. */
const PERMISSION_QUESTION = /.*(Do you want to [^?]*\?)$/;
const PLAN_QUESTION = /.*(Would you like to proceed\?)$/;
/** A row: an optional pointer, its number, then its label. The prompt's
 *  pointer sits on exactly one row; a list in the assistant's own text has none. */
const ROW = /^([❯›]\s*)?(\d{1,2})\.\s+(\S.*?)\s*$/;
/** A frame's sides, which some prompts draw. */
const SIDES = /^[│┃|]\s?|\s?[│┃|]$/g;
/** Lines between two rows that are not rows (a description under its row). */
const MAX_GAP = 2;
/** Lines over the rows that may hold the question, a wrapped one included. */
const MAX_QUESTION_LINES = 4;

const clean = (line: string) => line.replace(SIDES, "").trim();

/** The rows of the last numbered list on screen that starts at 1, with the line it starts on. */
function lastRows(lines: string[]): { start: number; end: number; options: string[] } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const first = ROW.exec(lines[i]);
    if (!first || first[2] !== "1") continue;
    const options = [first[3]];
    let pointers = first[1] ? 1 : 0;
    let end = i;
    let gap = 0;
    for (let j = i + 1; j < lines.length; j++) {
      const row = ROW.exec(lines[j]);
      if (row && Number(row[2]) === options.length + 1) {
        options.push(row[3]);
        if (row[1]) pointers++;
        end = j;
        gap = 0;
        continue;
      }
      if (row || !lines[j] || ++gap > MAX_GAP) break;
    }
    if (options.length >= 2 && pointers === 1) return { start: i, end, options };
  }
  return null;
}

/** The lines just over the rows, as one line: the question, wrapped or not, and what leads to it. */
function textOver(lines: string[], start: number): string {
  const above: string[] = [];
  let i = start - 1;
  while (i >= 0 && !lines[i]) i--;
  for (; i >= 0 && lines[i] && above.length < MAX_QUESTION_LINES; i--) above.unshift(lines[i]);
  return above.join(" ").replace(/\s+/g, " ").trim();
}

/** The permission prompt or plan approval the screen shows, or null for anything else. */
export function readScreenPrompt(screen: string): ScreenPrompt | null {
  const lines = screen.split("\n").map(clean);
  const rows = lastRows(lines);
  if (!rows) return null;
  // Nothing may follow the rows but their notes and help line: a list higher
  // up is an old frame the program has moved on from.
  const after = lines.slice(rows.end + 1).filter(Boolean);
  if (after.length > MAX_GAP + 3) return null;
  const text = textOver(lines, rows.start);
  const permission = PERMISSION_QUESTION.exec(text);
  if (permission) return { kind: "permission", question: permission[1], options: rows.options };
  const plan = PLAN_QUESTION.exec(text);
  if (plan && /\bplan\b/i.test(text)) return { kind: "plan", question: plan[1], options: rows.options };
  return null;
}

/** What Chat may do with row `label` of a `kind` prompt. */
export function rowRole(kind: PromptKind, label: string): RowRole {
  if (kind === "permission") return /^Yes$/.test(label) || /^No\b/.test(label) ? "answer" : "locked";
  if (/^Yes, manually approve edits$/.test(label)) return "answer";
  return /^No, keep planning\b/.test(label) ? "words" : "locked";
}

/** The words a row takes: one line, bounded. */
export function promptText(text: string | undefined): string {
  return (text ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, MAX_ASK_TEXT);
}

/** Whether two reads show the same prompt: the same kind, question and rows. */
export function samePrompt(a: ScreenPrompt | null, b: ScreenPrompt | null): boolean {
  return !!a && !!b && a.kind === b.kind && a.question === b.question
    && a.options.length === b.options.length && a.options.every((label, i) => label === b.options[i]);
}

/** Whether `b` is prompt `a` as it reads while an answer goes in: the same
 *  question and rows, but for a row that takes words, which then shows them. */
export function sameAsAnswered(a: ScreenPrompt, b: ScreenPrompt): boolean {
  return a.kind === b.kind && a.question === b.question && a.options.length === b.options.length
    && a.options.every((label, i) => label === b.options[i] || rowRole(a.kind, label) === "words");
}

/** A key that names the prompt: a different one starts the card over. */
export function promptId(prompt: ScreenPrompt): string {
  return `${prompt.kind}\n${prompt.question}\n${prompt.options.join("\n")}`;
}

/** Whether the screen shows `prompt`, read again. */
export function screenShowsPrompt(screen: string, prompt: ScreenPrompt): boolean {
  return samePrompt(readScreenPrompt(screen), prompt);
}

/** The steps that pick row `index`, with `text` for a row that takes words; null when Chat may not. */
export function promptSteps(prompt: ScreenPrompt, index: number, text?: string): AskStep[] | null {
  const label = prompt.options[index];
  if (label === undefined) return null;
  const role = rowRole(prompt.kind, label);
  const shows = [lead(prompt.question), ...prompt.options.map(option => lead(option))];
  const digit = { input: String(index + 1) };
  if (role === "answer") return text === undefined ? [{ expect: shows, keys: [digit] }] : null;
  if (role !== "words") return null;
  const words = promptText(text);
  if (!words) return null;
  return [
    { expect: shows, keys: [digit] },
    { expect: [], keys: [{ paste: words }] },
    { expect: [lead(words)], keys: [{ input: "\r" }] },
  ];
}

/** The screen as one line: for a test or a check that reads it whole. */
export { flatScreen };
