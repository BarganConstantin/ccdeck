import { codexCommandResult, codexItemText, codexToolOutcome } from "./codex-translate.mjs";
import { budgetDetail, cappedOutput, ESCAPES, isThinking, stampOf, thinkingTurn, toolResultDetail } from "./transcript-results.mjs";

// A Claude Code transcript's lines, as the turns Chat draws: what you typed
// (and how many images came with it), each slash command you ran with what it
// printed, what the assistant said, one row per tool call (with its error, or
// the change an edit made), a card for each set of questions it asked you, its
// task list, each sub-agent it started, and a line where you interrupted it or
// the API failed. Pure: lines in, turns out, nothing read from disk and
// nothing remembered between calls.
//
// WHEN. Each turn carries `at`, the time of the line it came from (ms since
// the epoch), when the line has one: Chat says when you wrote and how long
// the work took from it. A thinking block is a turn of its own, with its text
// and, when its line holds nothing else, how long it took (`took`, from the
// line before it). What a call printed or found rides on its row
// (transcript-results.mjs).
//
// WHAT IS LEFT OUT, ON PURPOSE. Sidechain lines (a subagent's own talk: the
// call that started it is the one line it gets), meta lines (text Claude Code
// wrote for itself), and a user line that only carries a tool's answer: that
// is the tool replying, not you typing.
//
// BOUNDED. Chat has no virtualisation, so the answer is the last MAX_TURNS
// turns, what you typed is cut at MAX_TEXT and what the assistant said at
// MAX_PROSE (and says so: `cut`), because the transcript's own size says
// nothing about how much a page can draw.
export const MAX_TURNS = 200;
export const MAX_TEXT = 4000;
export const MAX_PROSE = 16000;
export const MAX_ARG = 120;

// The input fields a tool call is summed up by, in the order they are tried:
// what a command ran, then which file, folder, pattern or address it touched.
const ARG_FIELDS = ["command", "file_path", "path", "pattern", "url", "description"];

const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** One line of a tool call's input, or an empty string. */
export function toolArg(input) {
  if (!input || typeof input !== "object") return "";
  for (const field of ARG_FIELDS) {
    const value = input[field];
    if (typeof value !== "string") continue;
    const first = value.split(/\r?\n/).find(line => line.trim() !== "");
    if (first !== undefined) return cut(first.trim(), MAX_ARG);
  }
  return "";
}

// A QUESTION CLAUDE ASKED IS NOT A TOOL ROW. AskUserQuestion's input holds the
// questions and their options, and its answer the choices: Chat draws them as
// a card, so the person reads what was asked without opening Term. Claude Code
// allows 1–4 questions of 2–4 options (a question that asks for text or a
// number has none); the caps are a little wider so a later version still
// draws, and every text is cut.
export const ASK_TOOL = "AskUserQuestion";
export const MAX_QUESTIONS = 4;
export const MAX_OPTIONS = 6;
const MAX_HEADER = 40;
const MAX_QUESTION = 1000;
const MAX_OPTION_NOTE = 400;
const MAX_ANSWER = 1000;
// What Claude Code records for a question that only got a note, no choice.
const NOTES_ONLY = "(notes only)";
// What it hands the model when the person wrote back instead of choosing.
const RESPONDED = /^The user responded: ([\s\S]*)$/;
// What it hands the model when the person picked "Chat about this" (2.1.8 and
// later), inside its refusal of the call: the questions were set aside to talk
// them over, and the card says so rather than "Not answered".
const CLARIFY = /\bThe user wants to clarify these questions\./;

const bounded = (value, max) => (typeof value === "string" && value.trim() ? cut(value.trim(), max) : "");

// A PLAN TO APPROVE IS NOT A TOOL ROW EITHER. Claude Code 2.1 has the model put
// the whole plan, in Markdown, in ExitPlanMode's `plan`: Chat draws it as prose,
// so the person reads what they approve without opening Term. A plan longer
// than MAX_PLAN is cut and says so (`cut`); one kept elsewhere (a version that
// leaves `plan` out) is drawn as its header only. Its answer starts "User has
// approved…" when it was approved; anything else (No, keep planning, Esc) is not.
export const PLAN_TOOL = "ExitPlanMode";
export const MAX_PLAN = 12000;
const APPROVED = /^User has approved\b/;

/** The plan turn of an ExitPlanMode call, with its answer when there is one. */
function planTurn(input, result) {
  const plan = input && typeof input === "object" && typeof input.plan === "string" ? input.plan.trim() : "";
  const turn = { kind: "plan", text: cut(plan, MAX_PLAN) };
  if (plan.length > MAX_PLAN) turn.cut = true;
  if (result) turn.approved = APPROVED.test(result.text.trim());
  else turn.running = true;
  return turn;
}

// THE TASK LIST IS NOT A TOOL ROW. Each TodoWrite call hands over the whole
// list as it stands, so every call is a full snapshot: Chat draws the last one
// as a checklist and the earlier ones as a line each (which one is last is the
// client's to say, since it sees the whole conversation). An input with no
// list stays a tool row.
export const TODO_TOOL = "TodoWrite";
export const MAX_TODOS = 50;
export const MAX_TODO_TEXT = 200;
const TODO_STATUS = { pending: "pending", in_progress: "active", completed: "done" };

/** The todo turn of a TodoWrite call, or null when its input carries no list. */
export function todoTurn(input) {
  const list = input && typeof input === "object" && Array.isArray(input.todos) ? input.todos : null;
  if (!list) return null;
  const items = [];
  for (const entry of list) {
    if (items.length >= MAX_TODOS) break;
    if (!entry || typeof entry !== "object") continue;
    const text = bounded(entry.content, MAX_TODO_TEXT) || bounded(entry.activeForm, MAX_TODO_TEXT);
    if (!text) continue;
    const known = typeof entry.status === "string" && Object.hasOwn(TODO_STATUS, entry.status);
    items.push({ text, status: known ? TODO_STATUS[entry.status] : "pending" });
  }
  return { kind: "todo", items };
}

// A SUB-AGENT IS ONE LINE. Agent (Claude Code 2.1) or Task (older) starts a
// sub-agent whose own lines are sidechain and stay out: what Chat keeps is the
// call, its type and description, and whether it still runs or failed. A
// running one can put a permission prompt on screen, as a running call can.
export const AGENT_TOOLS = new Set(["Agent", "Task"]);
export const MAX_AGENT_TEXT = 120;
const MAX_AGENT_TYPE = 60;

function agentTurn(input, result) {
  const given = input && typeof input === "object" ? input : {};
  const prompt = typeof given.prompt === "string" ? given.prompt.split(/\r?\n/).find(line => line.trim() !== "") : undefined;
  const turn = {
    kind: "agent",
    type: bounded(given.subagent_type, MAX_AGENT_TYPE),
    description: bounded(given.description, MAX_AGENT_TEXT) || bounded(prompt, MAX_AGENT_TEXT),
  };
  if (!result) turn.running = true;
  else if (result.declined) turn.declined = true;
  else if (result.error) turn.failed = true;
  else if (launchedInBackground(result)) turn.background = true;
  return turn;
}

// A SUB-AGENT STARTED IN THE BACKGROUND is answered at once, with a note that
// it was launched (Claude Code 2.1 records status "async_launched"): it has
// not finished, so it is not "Done".
const ASYNC_LAUNCHED = /^Async agent launched/;

function launchedInBackground(result) {
  return result.own?.status === "async_launched" || ASYNC_LAUNCHED.test(result.text.trim());
}

// A DECLINED CALL DID NOT FAIL. When you answer No at the permission prompt,
// Claude Code hands the model an error that opens with this sentence: the row
// says Declined, with nothing to open, rather than Failed with the note meant
// for the model.
const DECLINED = /^The user doesn't want to proceed with this tool use/;

// A FAILED CALL SAYS WHY. A result marked is_error keeps the call's row and
// carries the text Claude Code handed the model, cut at MAX_ERROR; the wrapper
// Claude Code puts round its own refusals is left off.
export const MAX_ERROR = 2000;
const ERROR_WRAPPER = /^<tool_use_error>([\s\S]*)<\/tool_use_error>$/;

function errorText(text) {
  const trimmed = text.trim();
  return cut((ERROR_WRAPPER.exec(trimmed)?.[1] ?? trimmed).trim(), MAX_ERROR);
}

// AN EDIT SHOWS ITS CHANGE. Edit, MultiEdit and Write carry the change as diff
// lines (" " kept, "-" removed, "+" added), and the row's note counts them
// ("+4 −1"). The patch Claude Code recorded for the result is preferred, its
// hunks joined by a "…" line; without one (still running, or an older
// version) the change is read from the input: what was replaced as "-", what
// replaces it as "+", and a whole new file as "+". The counts are the whole
// change's; the lines stop at MAX_DIFF_LINES or MAX_DIFF_CHARS and say so
// (`cut`). A failed call changed nothing, so it has no diff.
export const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);
export const MAX_DIFF_LINES = 400;
export const MAX_DIFF_CHARS = 12000;
export const DIFF_GAP = "…";

/** A text's lines, without the empty one a final newline leaves. */
function textLines(text) {
  if (typeof text !== "string" || text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The diff lines of a recorded structuredPatch, or null when there is none. */
function patchLines(own) {
  const hunks = own && typeof own === "object" && Array.isArray(own.structuredPatch) ? own.structuredPatch : null;
  if (!hunks) return null;
  const lines = [];
  for (const hunk of hunks) {
    const body = hunk && typeof hunk === "object" && Array.isArray(hunk.lines) ? hunk.lines.filter(l => typeof l === "string") : [];
    if (!body.length) continue;
    if (lines.length) lines.push(DIFF_GAP);
    lines.push(...body);
  }
  return lines.length ? lines : null;
}

/** The diff lines an edit's input describes. */
function inputLines(name, input) {
  if (!input || typeof input !== "object") return [];
  const change = (from, to) => [...textLines(from).map(l => `-${l}`), ...textLines(to).map(l => `+${l}`)];
  if (name === "Write") return textLines(input.content).map(l => `+${l}`);
  if (name === "Edit") return change(input.old_string, input.new_string);
  const lines = [];
  for (const edit of Array.isArray(input.edits) ? input.edits : []) {
    const part = edit && typeof edit === "object" ? change(edit.old_string, edit.new_string) : [];
    if (!part.length) continue;
    if (lines.length) lines.push(DIFF_GAP);
    lines.push(...part);
  }
  return lines;
}

/** The diff and note of an Edit, MultiEdit or Write call, or null when it changed nothing. */
export function editDiff(name, input, own) {
  const all = patchLines(own) ?? inputLines(name, input);
  if (!all.length) return null;
  let added = 0;
  let removed = 0;
  for (const line of all) {
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  const lines = [];
  let chars = 0;
  let over = false;
  for (const line of all) {
    if (lines.length >= MAX_DIFF_LINES) { over = true; break; }
    const room = MAX_DIFF_CHARS - chars;
    if (line.length > room) {
      // A line longer than what is left is cut to fit, so one minified line still shows.
      if (room > 1) lines.push(cut(line, room));
      over = true;
      break;
    }
    lines.push(line);
    chars += line.length;
  }
  const diff = over ? { lines, cut: true } : { lines };
  return { diff, note: `+${added} −${removed}` };
}

/** The questions of an AskUserQuestion call, or null when its input is not one. */
export function askQuestions(input) {
  const list = input && typeof input === "object" && Array.isArray(input.questions) ? input.questions : null;
  if (!list) return null;
  const questions = [];
  for (const entry of list.slice(0, MAX_QUESTIONS)) {
    if (!entry || typeof entry !== "object") continue;
    const question = bounded(entry.question, MAX_QUESTION);
    if (!question) continue;
    const given = (Array.isArray(entry.options) ? entry.options : []).slice(0, MAX_OPTIONS);
    const options = given
      .map(option => ({ label: bounded(option?.label, MAX_ARG), description: bounded(option?.description, MAX_OPTION_NOTE) }))
      .filter(option => option.label);
    const turn = { header: bounded(entry.header, MAX_HEADER), question, multi: entry.multiSelect === true, options };
    // Options with a preview are drawn side by side, and answered with other
    // keys (ask-keys.ts): only that they have one is kept, never the preview.
    if (given.some(option => bounded(option?.preview, 1))) turn.preview = true;
    // A question that asks for text or a number has no options to pick.
    if (typeof entry.kind === "string" && entry.kind !== "choice") turn.options = [];
    questions.push(turn);
  }
  return questions.length ? questions : null;
}

/** The text of a tool_result part: a string, or its text parts joined. */
function resultText(part) {
  const content = part?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(item => item?.type === "text" && typeof item.text === "string").map(item => item.text).join("\n");
}

// Claude Code answers the model with `"<question>"="<answer>"` pairs, or
// `"<question>"=(no option selected)`, joined by ", ". Read back only by the
// questions the call asked, so a quote inside an answer cannot start a new
// pair: an answer runs up to the next asked question's pair, or to the last
// quote before the sentence that follows.
function answersFromText(said, questions) {
  const found = [];
  for (const { question } of questions) {
    const at = said.indexOf(`"${question}"=`);
    if (at >= 0) found.push({ question, at, start: at + question.length + 3 });
  }
  found.sort((a, b) => a.at - b.at);
  const answers = {};
  found.forEach((entry, i) => {
    if (said[entry.start] !== '"') return;
    const next = found[i + 1];
    const stretch = said.slice(entry.start + 1, next ? next.at : said.length);
    const close = stretch.lastIndexOf('"');
    if (close >= 0) answers[entry.question] = stretch.slice(0, close);
  });
  return answers;
}

/** One answer as text: a choice, or several joined as Claude Code joins them. */
function answerText(value) {
  const said = Array.isArray(value) ? value.filter(item => typeof item === "string").join(", ") : value;
  return said === NOTES_ONLY ? "" : bounded(said, MAX_ANSWER);
}

/**
 * What the person chose, per question in the order asked, and what they wrote
 * back instead of choosing: from the line's own record of the result when it
 * carries one, else read from the text the model was handed. An empty string
 * for a question left unanswered.
 */
function askAnswers(questions, result) {
  const own = result.own && typeof result.own === "object" ? result.own : null;
  const answers = own?.answers && typeof own.answers === "object" ? own.answers : answersFromText(result.text, questions);
  const reply = own ? bounded(own.response, MAX_ANSWER) : bounded(RESPONDED.exec(result.text.trim())?.[1], MAX_ANSWER);
  return { answers: questions.map(({ question }) => answerText(answers[question])), reply };
}

function parse(line) {
  if (!line) return null;
  try {
    const rec = JSON.parse(line);
    return rec && typeof rec === "object" ? rec : null;
  } catch { return null; }
}

// CLAUDE CODE'S OWN BOOKKEEPING IS NOT WHAT THE PERSON TYPED. A slash
// command's wrappers, a local command's output, an interruption note, the
// notice a background task sends when it finishes, and the summary written
// when a conversation is compacted are all user lines in the file, but none
// was typed, and the summary alone runs to thousands of characters. They would
// be drawn as "you said". An interruption is still worth a line of its own (a
// notice turn), since it says why the assistant stopped.
const WRAPPERS = /<(command-name|command-message|command-args|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g;
// The notice has to OPEN the line, as the rail reads it (injected-prompt.ts):
// a person who mentions the tag mid-sentence typed it.
const TASK_NOTICE = /^\s*<task-notification>[\s\S]*?<\/task-notification>/;
const INTERRUPTED = /^\[Request interrupted by user/;
const SUMMARY_LEAD = /^This session is being continued from a previous conversation/;

/** A user line's text as written: a string, or its text parts joined. */
function rawUserText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(part => part && part.type === "text" && typeof part.text === "string")
    .map(part => part.text)
    .join("\n");
}

/** The text a user line carries: a string, or its text parts joined, without the bookkeeping. */
function userText(content) {
  return rawUserText(content).replace(WRAPPERS, "").trim().replace(TASK_NOTICE, "").trim();
}

// A SLASH COMMAND YOU RAN IS A LINE OF ITS OWN. Claude Code 2.1 writes `/model
// opus` as one user line holding nothing but its wrappers:
// <command-message>model</command-message>, <command-name>/model</command-name>
// and, when there are any, <command-args>opus</command-args>. Chat draws it as
// you typed it. A local command's result follows as a line of its own,
// <local-command-stdout> (or -stderr when it failed), and is drawn under the
// command; output with no command just before it is left out. A skill's
// expanded prompt and the caveat before a local command are meta lines, so
// they stay out as every meta line does. What a command printed is plain
// text: its colours (ANSI escapes) go, and it is cut at MAX_COMMAND_OUTPUT.
export const MAX_COMMAND_ARGS = 200;
export const MAX_COMMAND_OUTPUT = 2000;
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const COMMAND_OUTPUT = /<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/g;

/** The command turn of a line that only holds a command's wrappers, or null. */
function commandTurn(raw) {
  const name = COMMAND_NAME.exec(raw)?.[1].trim();
  if (!name) return null;
  const turn = { kind: "command", name: cut(name, MAX_ARG) };
  const args = COMMAND_ARGS.exec(raw)?.[1].trim();
  if (args) turn.args = cut(args, MAX_COMMAND_ARGS);
  return turn;
}

/** What the local-command outputs on a line printed, and whether any of it was stderr. */
function commandOutput(raw) {
  const parts = [];
  let failed = false;
  for (const [, stream, body] of raw.matchAll(COMMAND_OUTPUT)) {
    const text = body.replace(ESCAPES, "").trim();
    if (!text) continue;
    parts.push(text);
    if (stream === "stderr") failed = true;
  }
  return { text: parts.join("\n"), failed };
}

/** Adds what a command printed to its turn: lines after the first join with "\n". */
function attachOutput(turn, output) {
  if (!output.text) return;
  turn.output = cut(turn.output ? `${turn.output}\n${output.text}` : output.text, MAX_COMMAND_OUTPUT);
  if (output.failed) turn.failed = true;
}

// AN IMAGE YOU SENT IS COUNTED, NEVER CARRIED. A pasted or attached image is
// an image part beside the line's text: the turn says how many there were,
// and none of their data goes out. An image inside a tool's result is the
// tool's, not something you sent, so a line that answers a call counts none.
function imageCount(content) {
  if (!Array.isArray(content) || content.some(part => part?.type === "tool_result")) return 0;
  return content.filter(part => part?.type === "image").length;
}

// AN API ERROR IS NOT THE ASSISTANT TALKING. Claude Code writes a failed
// request as an assistant line flagged isApiErrorMessage ("API Error: 529
// {...}"): Chat draws its first line as a notice, cut at MAX_NOTICE.
export const MAX_NOTICE = 200;

function apiErrorTurn(content) {
  const parts = typeof content === "string" ? [content]
    : Array.isArray(content) ? content.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text) : [];
  const first = parts.join("\n").split(/\r?\n/).find(line => line.trim() !== "");
  const turn = { kind: "notice", what: "error" };
  if (first) turn.text = cut(first.trim(), MAX_NOTICE);
  return turn;
}

/**
 * The turns in `lines`, oldest first.
 *
 * A tool call with no answer anywhere in `lines` is `running`. The answer is
 * looked for in every line, a sidechain's included, since only the id ties
 * them together.
 */
export function transcriptTurns(lines) {
  return transcriptWindow(lines).turns;
}

/** The same turns, and whether the cap on them dropped any from the front. */
export function transcriptWindow(lines) {
  const records = [];
  // Each answered call's result: the text the model was handed, whether it was
  // marked an error and, when the line answers that call alone, the line's own
  // record of it.
  const answered = new Map();
  for (const line of lines) {
    const rec = parse(line);
    if (!rec) continue;
    records.push(rec);
    const content = rec.message?.content;
    if (rec.type === "user" && Array.isArray(content)) {
      const results = content.filter(part => part?.type === "tool_result" && typeof part.tool_use_id === "string");
      for (const part of results) {
        answered.set(part.tool_use_id, {
          text: resultText(part),
          own: results.length === 1 ? rec.toolUseResult : undefined,
          error: part.is_error === true,
          declined: part.is_error === true && DECLINED.test(resultText(part).trim()),
        });
      }
    }
  }
  const turns = [];
  let afterCompaction = false;
  // The turns of each line take its time once the line is done with.
  let from = 0;
  let stamp;
  const stampTurns = () => {
    if (stamp !== undefined) for (let i = from; i < turns.length; i++) turns[i].at = stamp;
    from = turns.length;
  };
  // The time of the last line of yours or the assistant's in the main
  // conversation: where a thinking block that follows it started.
  let lastStamp;
  for (const rec of records) {
    stampTurns();
    stamp = stampOf(rec);
    const before = lastStamp;
    if (stamp !== undefined && rec.isSidechain !== true && (rec.type === "user" || rec.type === "assistant")) lastStamp = stamp;
    if (rec.type === "system") afterCompaction = rec.subtype === "compact_boundary";
    if (rec.isSidechain === true || rec.isMeta === true) continue;
    const content = rec.message?.content;
    if (rec.type === "user") {
      const summary = rec.isCompactSummary === true || (afterCompaction && SUMMARY_LEAD.test(userText(content)));
      afterCompaction = false;
      if (summary) continue;
      const text = userText(content);
      const images = imageCount(content);
      const raw = text ? "" : rawUserText(content);
      const command = text ? null : commandTurn(raw);
      if (INTERRUPTED.test(text)) {
        // Esc during a call writes two notes in a row; they are one interruption.
        const last = turns.at(-1);
        if (last?.kind !== "notice" || last.what !== "interrupted") turns.push({ kind: "notice", what: "interrupted" });
      } else if (text || (images && !command)) {
        const turn = { kind: "user", text: cut(text, MAX_TEXT) };
        if (images) turn.images = images;
        turns.push(turn);
      } else if (command) {
        attachOutput(command, commandOutput(raw));
        turns.push(command);
      } else if (raw) {
        // A command's output, under the command it answers: the last turn.
        const last = turns.at(-1);
        if (last?.kind === "command") attachOutput(last, commandOutput(raw));
      }
    } else if (rec.type === "assistant" && rec.isApiErrorMessage === true) {
      turns.push(apiErrorTurn(content));
    } else if (rec.type === "assistant" && Array.isArray(content)) {
      // Claude Code writes each block of a reply as a line of its own, when
      // the block is done: a line of thinking alone ends where it ended, and
      // began where the line before it was written.
      const thinkingOnly = content.length > 0 && content.every(isThinking);
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
          const said = part.text.trim();
          turns.push(said.length > MAX_PROSE ? { kind: "assistant", text: cut(said, MAX_PROSE), cut: true } : { kind: "assistant", text: said });
        } else if (isThinking(part)) {
          turns.push(thinkingTurn(part, thinkingOnly && stamp !== undefined && before !== undefined ? stamp - before : undefined));
        } else if (part.type === "tool_use" && typeof part.name === "string") {
          const result = typeof part.id === "string" ? answered.get(part.id) : undefined;
          if (part.name === PLAN_TOOL) {
            turns.push(planTurn(part.input, result));
            continue;
          }
          const questions = part.name === ASK_TOOL ? askQuestions(part.input) : null;
          if (questions) {
            const turn = { kind: "ask", questions };
            if (result) {
              const { answers, reply } = askAnswers(questions, result);
              turn.answers = answers;
              if (reply) turn.reply = reply;
              if (CLARIFY.test(result.text)) turn.chat = true;
            } else turn.running = true;
            turns.push(turn);
            continue;
          }
          const todo = part.name === TODO_TOOL ? todoTurn(part.input) : null;
          if (todo) {
            turns.push(todo);
            continue;
          }
          if (AGENT_TOOLS.has(part.name)) {
            turns.push(agentTurn(part.input, result));
            continue;
          }
          const turn = { kind: "tool", name: cut(part.name, MAX_ARG), arg: toolArg(part.input) };
          if (!result) turn.running = true;
          else if (result.declined) turn.declined = true;
          else if (result.error) turn.error = errorText(result.text);
          if (EDIT_TOOLS.has(part.name) && !result?.error) {
            const change = editDiff(part.name, part.input, result?.own);
            if (change) {
              turn.note = change.note;
              turn.diff = change.diff;
            }
          } else Object.assign(turn, toolResultDetail(part.name, result));
          turns.push(turn);
        }
      }
    }
  }
  stampTurns();
  return capTurns(turns);
}

function capTurns(turns) {
  const kept = turns.length > MAX_TURNS ? { turns: turns.slice(-MAX_TURNS), cut: true } : { turns, cut: false };
  budgetDetail(kept.turns);
  return kept;
}

/** Prefer Codex's conversation events. The model-facing response items repeat
 * these messages and can also carry injected user-role context. Tool calls are
 * read from the response items, which are the only record of them. */
export function codexTranscriptWindow(lines) {
  return capTurns(codexTurns(lines));
}

// ─── Codex ───────────────────────────────────────────────────────────────────
// A Codex rollout's lines, as the turns Chat draws: what you typed and what
// Codex said (its conversation events), one row per tool call with how it
// went, the change an apply_patch makes, its plan (update_plan) as the task
// list, and a line where you interrupted a turn.
//
// A CALL AND ITS RESULT ARE TWO RECORDS. Codex writes the call as a
// `response_item` when it is made and the result as another, tied by
// `call_id`: a `function_call` (arguments as JSON text), a `custom_tool_call`
// (a bare string: a patch, a script) or a `local_shell_call` (an argv). What a
// result says is read in codex-translate.mjs (codexToolOutcome). A web search
// is a `web_search_call`, with no result of its own. A call with no result is
// running until its turn ends (task_complete, turn_aborted): after that Codex
// will not answer it.

/** The tools that run a command: their row wears the terminal mark. */
const CODEX_COMMAND_TOOLS = new Set(["exec_command", "shell", "shell_command", "local_shell", "exec", "write_stdin"]);
const CODEX_PATCH_TOOL = "apply_patch";
const CODEX_PLAN_TOOL = "update_plan";
// Named as Claude Code names its own web search, so both read the same in Chat.
const CODEX_SEARCH_TOOL = "WebSearch";

/** The first line of a text that says something, cut; or "". */
function firstLine(text) {
  const first = typeof text === "string" ? text.split(/\r?\n/).find(line => line.trim() !== "") : undefined;
  return first === undefined ? "" : cut(first.trim(), MAX_ARG);
}

// A shell's own argv, ["bash", "-lc", "<command>"]: the command is what
// follows its script flag.
const SHELL_PROGRAM = /(?:^|[\\/])(?:(?:ba|z|da|k)?sh|powershell|pwsh|cmd)(?:\.exe)?$/i;
const SCRIPT_FLAG = /^(?:-[a-z]*c|-command|\/c)$/i;

function argvCommand(argv) {
  const words = argv.filter(word => typeof word === "string");
  const flag = SHELL_PROGRAM.test(words[0] ?? "") ? words.findIndex(word => SCRIPT_FLAG.test(word)) : -1;
  return flag > 0 && flag + 1 < words.length ? words[flag + 1] : words.join(" ");
}

// The `exec` tool's input is a short JavaScript program that calls Codex's
// tools. What it ran is the `cmd` it hands tools.exec_command, as the board
// reads it (codexScriptCommand, tool-taxonomy.ts), else the tool it calls.
const SCRIPT_CMD = /\btools\.exec_command\s*\(\s*\{[^{}]*?\bcmd\s*:\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/;
const SCRIPT_CALL = /\btools\.([A-Za-z_$][\w$]*)\s*\(/;
const SCRIPT_ESCAPE = /\\(["'`\\nrt])/g;

function scriptArg(script) {
  const cmd = SCRIPT_CMD.exec(script)?.[2].replace(SCRIPT_ESCAPE, (_, c) => (c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c));
  if (cmd?.trim()) return firstLine(cmd);
  const call = SCRIPT_CALL.exec(script)?.[1];
  return call ? cut(call, MAX_ARG) : firstLine(script);
}

/** One line of a Codex call's input: the command it ran, else the usual fields. */
function codexArg(name, input) {
  if (typeof input === "string") return name === "exec" ? scriptArg(input) : firstLine(input);
  if (!input || typeof input !== "object") return "";
  if (typeof input.cmd === "string") return firstLine(input.cmd);
  if (Array.isArray(input.command)) return firstLine(argvCommand(input.command));
  return toolArg(input);
}

// AN APPLY_PATCH SHOWS ITS CHANGE, as an Edit does. The patch is Codex's own
// format: "*** Add File: …", "*** Update File: …" or "*** Delete File: …"
// headers, an "@@" line before each hunk of an update, and lines that start
// " ", "-" or "+". The row's argument is the files it touches; its hunks go
// through editDiff, so the note and the caps are an Edit's.
const PATCH_FILE = /^\*\*\* (?:Add|Delete|Update) File: (.+)$/;

/** The patch text of an apply_patch call: the bare string, or its `input` or `patch` field. */
function patchText(input) {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  return [input.input, input.patch].find(value => typeof value === "string") ?? "";
}

/** The files a patch touches, and its change as hunks of diff lines. */
function patchChange(patch) {
  const files = [];
  const hunks = [];
  let hunk = null;
  for (const line of patch.split(/\r?\n/)) {
    const file = PATCH_FILE.exec(line);
    if (file) {
      files.push(file[1].trim());
      hunk = null;
    } else if (line.startsWith("@@")) {
      hunk = null;
    } else if (files.length && /^[ +-]/.test(line)) {
      if (!hunk) hunks.push(hunk = []);
      hunk.push(line);
    }
  }
  return { files, hunks: hunks.map(lines => ({ lines })) };
}

/** The todo turn of an update_plan call, or null when it carries no plan. Its
 *  steps take the same three states as TodoWrite's. */
function planTodo(input) {
  const plan = input && typeof input === "object" && Array.isArray(input.plan) ? input.plan : null;
  return plan ? todoTurn({ todos: plan.map(item => ({ content: item?.step, status: item?.status })) }) : null;
}

/** The row of one call, with its result (`answered`), the patch_apply_end
 *  Codex wrote for it, and whether its turn has ended. */
function codexToolTurn(name, input, answered, result, applied, over) {
  const patch = name === CODEX_PATCH_TOOL ? patchChange(patchText(input)) : null;
  const turn = { kind: "tool", name: cut(name, MAX_ARG), arg: patch ? cut(patch.files.join(", "), MAX_ARG) : codexArg(name, input) };
  if (CODEX_COMMAND_TOOLS.has(name)) turn.mark = "terminal";
  const outcome = answered ? codexToolOutcome(result) : null;
  const notApplied = applied?.success === false;
  if (outcome?.declined) turn.declined = true;
  else if (outcome?.failed) turn.error = errorText(outcome.text.replace(ESCAPES, ""));
  else if (notApplied) turn.error = errorText(String(applied.stderr || applied.stdout || "").replace(ESCAPES, ""));
  else if (!answered && !applied && !over) turn.running = true;
  // A command's output and exit code, as a Bash call's: from the head lines
  // Codex writes over what it printed.
  if (turn.mark === "terminal" && outcome && !outcome.declined) {
    const printed = codexCommandResult(result);
    if (printed.exit !== undefined) turn.exit = printed.exit;
    const output = outcome.failed ? null : cappedOutput(printed.text);
    if (output) turn.output = output;
  }
  if (patch && turn.error === undefined && !turn.declined) {
    const change = editDiff(name, undefined, { structuredPatch: patch.hunks });
    if (change) {
      turn.note = change.note;
      turn.diff = change.diff;
    }
  }
  return turn;
}

/** The row of a web search: what it looked for. */
function webSearchTurn(payload) {
  const action = payload.action && typeof payload.action === "object" ? payload.action : {};
  const asked = [action.query, action.url, action.pattern].find(value => typeof value === "string" && value.trim());
  return { kind: "tool", name: CODEX_SEARCH_TOOL, arg: firstLine(asked), mark: "search" };
}

/** A user or assistant turn from a conversation event, or null. */
function codexMessage(event) {
  let kind, text;
  if (event?.type === "user_message" || event?.type === "agent_message") {
    kind = event.type === "user_message" ? "user" : "assistant";
    text = event.message;
  } else if (event?.type === "item_completed") {
    if (event.item?.type === "UserMessage") {
      kind = "user";
      text = codexItemText(event.item);
    } else if (event.item?.type === "AgentMessage") {
      kind = "assistant";
      text = typeof event.item.content === "string" ? event.item.content : codexItemText(event.item);
    }
  }
  if (typeof text !== "string" || !text.trim()) return null;
  const said = text.trim();
  const max = kind === "assistant" ? MAX_PROSE : MAX_TEXT;
  return said.length > max && kind === "assistant" ? { kind, text: cut(said, max), cut: true } : { kind, text: cut(said, max) };
}

/** The turns in a Codex rollout's `lines`, oldest first. */
function codexTurns(lines) {
  const records = [];
  // Each answered call's result, the patch_apply_end of each patch, and where
  // the last turn ended.
  const results = new Map();
  const applied = new Map();
  let ended = -1;
  for (const line of lines) {
    const record = parse(line);
    if (!record) continue;
    const payload = record.payload;
    if (record.type === "response_item" && (payload?.type === "function_call_output" || payload?.type === "custom_tool_call_output")) {
      if (typeof payload.call_id === "string") results.set(payload.call_id, payload.output);
    } else if (record.type === "event_msg" && payload?.type === "patch_apply_end") {
      if (typeof payload.call_id === "string") applied.set(payload.call_id, payload);
    } else if (record.type === "event_msg" && (payload?.type === "task_complete" || payload?.type === "turn_aborted")) {
      ended = records.length;
    }
    records.push(record);
  }
  const turns = [];
  // Each turn takes the time of the record it came from, as Claude's do.
  let from = 0;
  const stampTurns = record => {
    const stamp = stampOf(record);
    if (stamp !== undefined) for (let i = from; i < turns.length; i++) turns[i].at = stamp;
    from = turns.length;
  };
  records.forEach((record, at) => {
    if (at > 0) stampTurns(records[at - 1]);
    const payload = record.payload;
    if (record.type === "event_msg") {
      const message = codexMessage(payload);
      if (message) turns.push(message);
      // A turn you stopped (Esc) says so, as Claude Code's does. Only that
      // reason: a turn Codex replaced or a review that ended was not stopped.
      else if (payload?.type === "turn_aborted" && payload.reason === "interrupted") {
        const last = turns[turns.length - 1];
        if (last?.kind !== "notice" || last.what !== "interrupted") turns.push({ kind: "notice", what: "interrupted" });
      }
      return;
    }
    if (record.type !== "response_item" || !payload || typeof payload !== "object") return;
    if (payload.type === "web_search_call") {
      turns.push(webSearchTurn(payload));
      return;
    }
    let name, input;
    if (payload.type === "function_call") {
      name = payload.name;
      input = payload.arguments;
      if (typeof input === "string") {
        try { input = JSON.parse(input); } catch { /* kept as written */ }
      }
    } else if (payload.type === "custom_tool_call") {
      name = payload.name;
      input = payload.input;
    } else if (payload.type === "local_shell_call") {
      name = "local_shell";
      input = { command: payload.action?.command };
    }
    if (typeof name !== "string" || !name) return;
    const todo = name === CODEX_PLAN_TOOL ? planTodo(input) : null;
    if (todo) {
      turns.push(todo);
      return;
    }
    const id = typeof payload.call_id === "string" ? payload.call_id : undefined;
    turns.push(codexToolTurn(name, input, id !== undefined && results.has(id), results.get(id), id === undefined ? undefined : applied.get(id), at < ended));
  });
  if (records.length) stampTurns(records[records.length - 1]);
  return turns;
}
