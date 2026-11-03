// A Claude Code transcript's lines, as the turns Chat draws: what you typed,
// what the assistant said, and one row per tool call. Pure: lines in, turns
// out, nothing read from disk and nothing remembered between calls.
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

function parse(line) {
  if (!line) return null;
  try {
    const rec = JSON.parse(line);
    return rec && typeof rec === "object" ? rec : null;
  } catch { return null; }
}

// CLAUDE CODE'S OWN BOOKKEEPING IS NOT WHAT THE PERSON TYPED. A slash
// command's wrappers, a local command's output, an interruption note and the
// summary written when a conversation is compacted are all user lines in the
// file, but none was typed, and the summary alone runs to thousands of
// characters. They would be drawn as "you said".
const WRAPPERS = /<(command-name|command-message|command-args|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g;
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
  text = text.replace(WRAPPERS, "").trim();
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
  const answered = new Set();
  for (const line of lines) {
    const rec = parse(line);
    if (!rec) continue;
    records.push(rec);
    const content = rec.message?.content;
    if (rec.type === "user" && Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === "tool_result" && typeof part.tool_use_id === "string") answered.add(part.tool_use_id);
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
          const turn = { kind: "tool", name: cut(part.name, MAX_ARG), arg: toolArg(part.input) };
          if (typeof part.id !== "string" || !answered.has(part.id)) turn.running = true;
          turns.push(turn);
        }
      }
    }
  }
  return turns.length > MAX_TURNS ? { turns: turns.slice(-MAX_TURNS), cut: true } : { turns, cut: false };
}
