import { codexItemText } from "./codex-translate.mjs";

// A Claude Code transcript's lines, as the turns Chat draws: what you typed,
// what the assistant said, one row per tool call, and a card for each set of
// questions it asked you. Pure: lines in, turns out, nothing read from disk
// and nothing remembered between calls.
//
// WHAT IS LEFT OUT, ON PURPOSE. Thinking blocks (they are not part of the
// conversation a reader follows), sidechain lines (a subagent's own talk),
// meta lines (text Claude Code wrote for itself), and a user line that only
// carries a tool's answer: that is the tool replying, not you typing.
//
// BOUNDED. Chat has no virtualisation, so the answer is the last MAX_TURNS
// turns and each text is cut at MAX_TEXT, because the transcript's own size
// says nothing about how much a page can draw.
export const MAX_TURNS = 200;
export const MAX_TEXT = 4000;
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

const bounded = (value, max) => (typeof value === "string" && value.trim() ? cut(value.trim(), max) : "");

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
// be drawn as "you said".
const WRAPPERS = /<(command-name|command-message|command-args|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g;
// The notice has to OPEN the line, as the rail reads it (injected-prompt.ts):
// a person who mentions the tag mid-sentence typed it.
const TASK_NOTICE = /^\s*<task-notification>[\s\S]*?<\/task-notification>/;
const INTERRUPTED = /^\[Request interrupted by user/;
const SUMMARY_LEAD = /^This session is being continued from a previous conversation/;

/** The text a user line carries: a string, or its text parts joined, without the bookkeeping. */
function userText(content) {
  let text;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content
      .filter(part => part && part.type === "text" && typeof part.text === "string")
      .map(part => part.text)
      .join("\n");
  } else return "";
  text = text.replace(WRAPPERS, "").trim().replace(TASK_NOTICE, "").trim();
  return INTERRUPTED.test(text) ? "" : text;
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
  // Each answered call's result: the text the model was handed and, when the
  // line answers that call alone, the line's own record of it.
  const answered = new Map();
  for (const line of lines) {
    const rec = parse(line);
    if (!rec) continue;
    records.push(rec);
    const content = rec.message?.content;
    if (rec.type === "user" && Array.isArray(content)) {
      const results = content.filter(part => part?.type === "tool_result" && typeof part.tool_use_id === "string");
      for (const part of results) {
        answered.set(part.tool_use_id, { text: resultText(part), own: results.length === 1 ? rec.toolUseResult : undefined });
      }
    }
  }
  const turns = [];
  let afterCompaction = false;
  for (const rec of records) {
    if (rec.type === "system") afterCompaction = rec.subtype === "compact_boundary";
    if (rec.isSidechain === true || rec.isMeta === true) continue;
    const content = rec.message?.content;
    if (rec.type === "user") {
      const summary = rec.isCompactSummary === true || (afterCompaction && SUMMARY_LEAD.test(userText(content)));
      afterCompaction = false;
      if (summary) continue;
      const text = userText(content);
      if (text) turns.push({ kind: "user", text: cut(text, MAX_TEXT) });
    } else if (rec.type === "assistant" && Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
          turns.push({ kind: "assistant", text: cut(part.text.trim(), MAX_TEXT) });
        } else if (part.type === "tool_use" && typeof part.name === "string") {
          const result = typeof part.id === "string" ? answered.get(part.id) : undefined;
          const questions = part.name === ASK_TOOL ? askQuestions(part.input) : null;
          if (questions) {
            const turn = { kind: "ask", questions };
            if (result) {
              const { answers, reply } = askAnswers(questions, result);
              turn.answers = answers;
              if (reply) turn.reply = reply;
            } else turn.running = true;
            turns.push(turn);
            continue;
          }
          const turn = { kind: "tool", name: cut(part.name, MAX_ARG), arg: toolArg(part.input) };
          if (!result) turn.running = true;
          turns.push(turn);
        }
      }
    }
  }
  return capTurns(turns);
}

function capTurns(turns) {
  return turns.length > MAX_TURNS ? { turns: turns.slice(-MAX_TURNS), cut: true } : { turns, cut: false };
}

/** Prefer Codex's conversation events. The model-facing response items repeat
 * these messages and can also carry injected user-role context. */
export function codexTranscriptWindow(lines) {
  const turns = [];
  for (const line of lines) {
    const record = parse(line);
    if (record?.type !== "event_msg") continue;
    const event = record.payload;
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
    if (typeof text === "string" && text.trim()) turns.push({ kind, text: cut(text.trim(), MAX_TEXT) });
  }
  return capTurns(turns);
}
