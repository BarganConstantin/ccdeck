import { codexItemText } from "./codex-translate.mjs";

// A Claude Code transcript's lines, as the turns Chat draws: what you typed,
// what the assistant said, one row per tool call (with its error, or the change
// an edit made), a card for each set of questions it asked you, its task list,
// each sub-agent it started, and a line where you interrupted it or the API
// failed. Pure: lines in, turns out, nothing read from disk and nothing
// remembered between calls.
//
// WHAT IS LEFT OUT, ON PURPOSE. Thinking blocks (they are not part of the
// conversation a reader follows), sidechain lines (a subagent's own talk: the
// call that started it is the one line it gets), meta lines (text Claude Code
// wrote for itself), and a user line that only carries a tool's answer: that
// is the tool replying, not you typing.
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
  return text.replace(WRAPPERS, "").trim().replace(TASK_NOTICE, "").trim();
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
  for (const rec of records) {
    if (rec.type === "system") afterCompaction = rec.subtype === "compact_boundary";
    if (rec.isSidechain === true || rec.isMeta === true) continue;
    const content = rec.message?.content;
    if (rec.type === "user") {
      const summary = rec.isCompactSummary === true || (afterCompaction && SUMMARY_LEAD.test(userText(content)));
      afterCompaction = false;
      if (summary) continue;
      const text = userText(content);
      if (INTERRUPTED.test(text)) {
        // Esc during a call writes two notes in a row; they are one interruption.
        const last = turns.at(-1);
        if (last?.kind !== "notice" || last.what !== "interrupted") turns.push({ kind: "notice", what: "interrupted" });
      } else if (text) turns.push({ kind: "user", text: cut(text, MAX_TEXT) });
    } else if (rec.type === "assistant" && rec.isApiErrorMessage === true) {
      turns.push(apiErrorTurn(content));
    } else if (rec.type === "assistant" && Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
          turns.push({ kind: "assistant", text: cut(part.text.trim(), MAX_TEXT) });
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
          }
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
