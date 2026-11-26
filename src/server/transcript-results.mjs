// What a call's answer says, for Chat (transcript-turns.mjs): what a command
// printed and how it ended, how many lines a read file had, what a search
// found, what a fetch brought back; and the assistant's thinking. Pure: the
// call, its answer and the line's own record of it in, a few fields out.
//
// BOUNDED, EACH AND ALL. An output keeps its first MAX_OUTPUT_LINES lines and
// at most MAX_OUTPUT_CHARS characters, with the count of all its lines and
// `cut` when it is longer; a thinking text is cut at MAX_THINKING. Across one
// answer of the route, outputs and thinking share MAX_DETAIL_TOTAL characters,
// the newest first: an older one past it keeps its counts and loses its text.

/** Terminal escapes (colours, titles, cursor moves): what a command printed is plain text here. */
export const ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

export const MAX_OUTPUT_LINES = 40;
export const MAX_OUTPUT_CHARS = 6 * 1024;
export const MAX_THINKING = 8000;
export const MAX_DETAIL_TOTAL = 256 * 1024;
/** A thinking span longer than this is not a span the line's times can tell. */
export const MAX_THINKING_MS = 60 * 60 * 1000;

const isText = value => typeof value === "string";
const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : undefined);

/** A text cut at `max` characters, never inside a surrogate pair. */
function sliceText(text, max) {
  if (text.length <= max) return text;
  const end = /[\ud800-\udbff]/.test(text[max - 1]) ? max - 1 : max;
  return text.slice(0, end);
}

/** What a call printed, as plain text: colours gone, what a carriage return
 *  wrote over gone (a progress bar keeps its last state), no blank lines
 *  before or after it. */
export function plainOutput(text) {
  return text.replace(ESCAPES, "").replace(/\r\n/g, "\n").split("\n")
    .map(line => line.slice(line.lastIndexOf("\r") + 1)).join("\n").replace(/^(?:[ \t]*\n)+/, "").trimEnd();
}

/**
 * The first lines of an output and how many it had: `{ text, lines, cut? }`,
 * or null when it printed nothing.
 */
export function cappedOutput(raw) {
  if (!isText(raw)) return null;
  const text = plainOutput(raw);
  if (!text.trim()) return null;
  const all = text.split("\n");
  let kept = all.length > MAX_OUTPUT_LINES ? all.slice(0, MAX_OUTPUT_LINES).join("\n") : text;
  let over = all.length > MAX_OUTPUT_LINES;
  if (kept.length > MAX_OUTPUT_CHARS) {
    kept = sliceText(kept, MAX_OUTPUT_CHARS);
    over = true;
  }
  const output = { text: kept, lines: all.length };
  if (over) output.cut = true;
  return output;
}

// The tools whose answer is worth reading in Chat: a command's output, what a
// search matched, what a fetch said. A read file is counted, never carried;
// an edit shows its change instead (transcript-turns.mjs).
const COMMAND_TOOLS = new Set(["Bash", "BashOutput", "TaskOutput"]);
const EXIT_CODE = /^Exit code (-?\d+)\b/;
// The note Claude Code puts first in a Read answer's lines: "   12→text".
const NUMBERED_LINE = /^\s*\d+→/;
const FOUND_FILES = /^Found (\d+) files?\b/;
const NO_FILES = /^No files found\b/;

/** stdout and stderr of a command's own record, joined, or null when it has neither. */
function streams(own) {
  if (!own || typeof own !== "object" || (!isText(own.stdout) && !isText(own.stderr))) return null;
  return [own.stdout, own.stderr].filter(part => isText(part) && part.trim()).map(part => part.trimEnd()).join("\n");
}

/** The links a WebSearch found, one "title — url" line each. */
function searchLinks(own) {
  const links = [];
  for (const entry of Array.isArray(own?.results) ? own.results : []) {
    for (const hit of Array.isArray(entry?.content) ? entry.content : []) {
      if (hit && isText(hit.url)) links.push(isText(hit.title) && hit.title.trim() ? `${hit.title.trim()} — ${hit.url}` : hit.url);
    }
  }
  return links;
}

/** The fields one stat object keeps: whole counts only. */
function statOf(fields) {
  const stat = {};
  for (const [key, value] of Object.entries(fields)) {
    const n = count(value);
    if (n !== undefined) stat[key] = n;
  }
  return Object.keys(stat).length ? stat : undefined;
}

/**
 * What the answer of a call adds to its row: `output` (what it printed or
 * found, capped), `exit` (a command's exit code, when the answer tells it),
 * `interrupted`, and `stat` (counts: lines, files, matches, results, status,
 * bytes). Empty for a call still running or one you declined.
 */
export function toolResultDetail(name, result) {
  if (!result || result.declined) return {};
  const own = result.own && typeof result.own === "object" ? result.own : null;
  const detail = {};
  if (COMMAND_TOOLS.has(name)) {
    if (own?.interrupted === true) detail.interrupted = true;
    if (result.error) {
      const code = EXIT_CODE.exec(result.text.trim())?.[1];
      if (code !== undefined && !detail.interrupted) detail.exit = Number(code);
      return detail;
    }
    // A code Claude Code read as no failure (grep's 1, "No matches found") is
    // not a 0; a command sent to the background has not ended.
    if (name === "Bash" && !detail.interrupted && !own?.returnCodeInterpretation && !own?.backgroundTaskId) detail.exit = 0;
    const output = cappedOutput(streams(own) ?? result.text);
    if (output) detail.output = output;
    return detail;
  }
  if (result.error) return detail;
  if (name === "Read") {
    const lines = own?.file && typeof own.file === "object" ? count(own.file.numLines)
      : (own ? undefined : result.text.split("\n").filter(line => NUMBERED_LINE.test(line)).length || undefined);
    const stat = statOf({ lines });
    if (stat) detail.stat = stat;
    return detail;
  }
  if (name === "Grep") {
    const files = Array.isArray(own?.filenames) ? own.filenames.filter(isText) : [];
    const mode = own?.mode;
    detail.stat = own
      ? statOf(mode === "content" ? { lines: own.numLines } : mode === "count" ? { matches: own.numMatches, files: own.numFiles } : { files: own.numFiles })
      : statOf({ files: Number(FOUND_FILES.exec(result.text.trim())?.[1]) });
    const output = cappedOutput(isText(own?.content) && own.content.trim() ? own.content : files.length ? files.join("\n") : own ? "" : result.text);
    if (output) detail.output = output;
    if (!detail.stat) delete detail.stat;
    return detail;
  }
  if (name === "Glob") {
    const files = Array.isArray(own?.filenames) ? own.filenames.filter(isText) : null;
    const listed = files ?? (NO_FILES.test(result.text.trim()) ? [] : result.text.split("\n").filter(line => line.trim()));
    const stat = statOf({ files: own ? own.numFiles ?? files?.length : listed.length });
    if (stat) detail.stat = stat;
    const output = cappedOutput(listed.join("\n"));
    if (output) detail.output = output;
    return detail;
  }
  if (name === "WebFetch") {
    const stat = statOf({ status: own?.code, bytes: own?.bytes });
    if (stat) detail.stat = stat;
    const output = cappedOutput(isText(own?.result) ? own.result : result.text);
    if (output) detail.output = output;
    return detail;
  }
  if (name === "WebSearch") {
    const links = own ? searchLinks(own) : [];
    if (own) detail.stat = statOf({ results: links.length });
    const output = cappedOutput(links.length ? links.join("\n") : result.text);
    if (output) detail.output = output;
    if (!detail.stat) delete detail.stat;
    return detail;
  }
  // A tool from an MCP server answers in text written for the model to read.
  if (name.startsWith("mcp__")) {
    const output = cappedOutput(result.text);
    if (output) detail.output = output;
  }
  return detail;
}

/**
 * A thinking block as a turn: its text (cut) when the line carries one, and
 * how long it took when the line's times tell it. A redacted block, or one
 * whose text was left out, is the mark alone.
 */
export function thinkingTurn(part, took) {
  const turn = { kind: "thinking" };
  const text = part?.type === "thinking" && isText(part.thinking) ? part.thinking.trim() : "";
  if (text) {
    turn.text = text.length > MAX_THINKING ? `${sliceText(text, MAX_THINKING - 1)}…` : text;
    if (text.length > MAX_THINKING) turn.cut = true;
  }
  if (Number.isFinite(took) && took >= 0 && took <= MAX_THINKING_MS) turn.took = Math.round(took);
  return turn;
}

export const isThinking = part => part?.type === "thinking" || part?.type === "redacted_thinking";

/** Holds outputs and thinking to MAX_DETAIL_TOTAL characters, the newest first. */
export function budgetDetail(turns) {
  let spent = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.kind === "tool" && turn.output) {
      spent += turn.output.text.length;
      if (spent > MAX_DETAIL_TOTAL) turn.output = { text: "", lines: turn.output.lines, cut: true };
    } else if (turn.kind === "thinking" && turn.text) {
      spent += turn.text.length;
      if (spent > MAX_DETAIL_TOTAL) {
        delete turn.text;
        turn.cut = true;
      }
    }
  }
  return turns;
}

/** A line's time, in ms since the epoch, or undefined when it has none. */
export function stampOf(rec) {
  if (!isText(rec?.timestamp)) return undefined;
  const ms = Date.parse(rec.timestamp);
  return Number.isFinite(ms) ? ms : undefined;
}
