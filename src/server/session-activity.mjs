// What a session is doing right now, in one line, read off its transcript.
//
// WHERE THE RULE COMES FROM. Claude Code's agent view (`claude agents`) prints
// one line beside every background session saying what it is doing, and while
// a turn is running that line is not a summary at all. It is the newest
// assistant message, read for the first thing a person can read: a text block
// of more than eight characters, and failing that the `description` the model
// wrote on its tool call — "Run the API tests" — and failing that what the call
// is touching. Read off the 2.1.289 bundle on 2026-10-05; the model-written
// summary that replaces it a minute into a long turn is the half that costs a
// request, and the deck takes that half from the job's own file when there is
// one (see claude-jobs.mjs). This half costs nothing, needs only the transcript
// the output watch is already reading, and is as true of an interactive
// session as of a background one.
//
// WHY THE MESSAGE AND NOT THE LINE. Claude Code writes one transcript line per
// content block, and the blocks of one reply share `message.id`: "Now I'll read
// the reducer" lands a moment before the Read it introduces. Folded by message,
// the sentence outranks the call it explains, as it does in the agent view;
// folded by line, the call would replace the sentence a second after it
// appeared, and the line would read like a tool log.
//
// WHEN A MESSAGE SAYS NOTHING. A reply holding only thinking, or a call this
// cannot name, leaves the line where it was. Thinking is the model working on
// what the line already says, and a blank line would claim it had stopped.
//
// What it does NOT decide is whether the line is still true. A line describes
// the turn that wrote it, and the next prompt makes it history; the client
// holds that rule (session-status.ts), because a prompt reaches the deck
// through its hook before the model has written a word.

/** The cheap test every line gets before anything is parsed. */
const ASSISTANT_MARK = '"type":"assistant"';

/** Claude Code's own floor for a text block worth showing: "ok", "Done." and
 *  "Let me" say nothing about what is happening, and its line skips them. */
const MIN_SAID_CHARS = 8;

/** A row is one line of a 300px sidebar, three at most. Past this the text is
 *  cut at a word and marked, so a model that opens with a paragraph does not
 *  push the row's own figures off the panel. */
const ACTIVITY_MAX_CHARS = 160;

/**
 * The first line of what the model wrote, as plain words.
 *
 * Markdown is the model's formatting for a terminal and reads as noise in a
 * one-line row: `**bold**`, backticks, a heading's hashes, a bullet's dash. Only
 * the first non-empty line is taken — the rest of a long reply is the answer,
 * not the activity.
 */
export function cleanSaid(raw) {
  if (typeof raw !== "string") return "";
  const first = raw.split("\n").map(l => l.trim()).find(Boolean) ?? "";
  let text = first
    .replace(/^#{1,6}\s+/, "")
    .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > ACTIVITY_MAX_CHARS) {
    const cut = text.slice(0, ACTIVITY_MAX_CHARS - 1);
    const space = cut.lastIndexOf(" ");
    text = (space > ACTIVITY_MAX_CHARS * 0.6 ? cut.slice(0, space) : cut).trimEnd() + "…";
  }
  return text;
}

/** The last path segment, for a call whose subject is a file. */
function baseName(path) {
  if (typeof path !== "string" || !path) return "";
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/** A host, for a fetch: the whole address is a query string as often as not. */
function hostOf(url) {
  if (typeof url !== "string") return "";
  try { return new URL(url).host; } catch { return ""; }
}

/**
 * What one tool call is doing, in words, or "" when it says nothing a person
 * could read.
 *
 * The model's own `description` first: it is a sentence written for exactly
 * this reader, and Bash, Task and Agent carry one on nearly every call. The
 * rest are the calls that carry none but name their subject plainly — a file,
 * a pattern, a host. Anything else is left unnamed rather than printed as a
 * tool id: "Using mcp__github__list_pulls" is a log line, not an activity.
 */
export function toolActivity(name, input) {
  const desc = typeof input?.description === "string" ? input.description : "";
  if (desc.trim()) return cleanSaid(desc);
  const say = (verb, subject) => (subject ? cleanSaid(`${verb} ${subject}`) : "");
  switch (name) {
    case "Read": return say("Reading", baseName(input?.file_path));
    case "Edit":
    case "MultiEdit": return say("Editing", baseName(input?.file_path));
    case "Write": return say("Writing", baseName(input?.file_path));
    case "NotebookEdit": return say("Editing", baseName(input?.notebook_path));
    case "Grep": return say("Searching for", typeof input?.pattern === "string" ? input.pattern : "");
    case "Glob": return say("Finding", typeof input?.pattern === "string" ? input.pattern : "");
    case "WebFetch": return say("Fetching", hostOf(input?.url));
    case "WebSearch": return say("Searching the web for", typeof input?.query === "string" ? input.query : "");
    default: return "";
  }
}

/**
 * What one transcript line adds to the line, or null for a line that is not
 * the main chain's model writing.
 *
 * `said` is the newest readable text block on the line, `did` the newest
 * nameable call; either may be "" when the line carries neither. A subagent's
 * sidechain is not the session's own reply — current Claude Code writes those
 * to their own files anyway, and the parent's Task call already says what the
 * subagent was sent to do.
 */
export function activityOfLine(line) {
  if (!line || !line.includes(ASSISTANT_MARK)) return null;
  let rec;
  try { rec = JSON.parse(line); } catch { return null; }
  if (!rec || rec.type !== "assistant" || rec.isSidechain === true) return null;
  const content = rec.message?.content;
  if (!Array.isArray(content)) return null;
  let said = "";
  let did = "";
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      const text = cleanSaid(block.text);
      if (text.length > MIN_SAID_CHARS) said = text;
    } else if (block?.type === "tool_use") {
      const text = toolActivity(block.name, block.input);
      if (text) did = text;
    }
  }
  const at = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
  return {
    messageId: typeof rec.message?.id === "string" ? rec.message.id : null,
    said,
    did,
    at: Number.isFinite(at) ? at : null,
  };
}

/** A session's fold, before it has read anything. */
export function newActivityState() {
  return { messageId: null, said: "", did: "", shown: null };
}

/**
 * Fold one transcript line into `st.shown` — `{ text, source, at }`, or null
 * until something readable has been written.
 *
 * Pure apart from `st`, and shaped like foldRecapLine beside it so the output
 * watch's tap can run both over the same tail. A new `message.id` starts a new
 * reply; within one reply what was said outranks what was done, whichever line
 * came last. A line with no message id is its own reply, which is what an
 * older transcript or a hand-written fixture looks like.
 */
export function foldActivityLine(st, line) {
  const a = activityOfLine(line);
  if (!a) return;
  if (!a.messageId || a.messageId !== st.messageId) {
    st.messageId = a.messageId;
    st.said = "";
    st.did = "";
  }
  if (a.said) st.said = a.said;
  if (a.did) st.did = a.did;
  const text = st.said || st.did;
  if (!text) return;
  if (st.shown && st.shown.text === text) return;
  st.shown = { text, source: st.said ? "said" : "tool", at: a.at ?? Date.now() };
}
