// What fills a Claude Code session's context window, as Claude Code itself
// last counted it.
//
// WHAT IT IS. When someone runs `/context` in Claude Code, the grid it draws in
// the terminal is for the screen only, but the command also adds one meta user
// line to the transcript: the same breakdown as markdown, so the model can read
// it. Claude Code 2.1.332 writes it like this (bounded: the ten biggest rows of
// each list, then one "and N more" row):
//
//   ## Context Usage
//
//   **Model:** claude-opus-4-7
//   **Tokens:** 113.6k / 600k (19%)
//
//   ### Estimated usage by category
//   | Category | Tokens | Percentage |
//   |----------|--------|------------|
//   | System prompt | 3.1k | 0.5% |
//   | MCP tools (deferred) | 66.9k | 11.2% |
//   | Free space | 453.4k | 75.6% |
//   | Autocompact buffer | 33k | 5.5% |
//
//   ### MCP Tools                    | Tool | Server | Tokens |
//   ### Other MCP tools, by server   | Server | Tools | Tokens if all were loaded |
//   ### Custom Agents                | Agent Type | Source | Tokens |
//   ### Memory Files                 | Type | Path | Tokens |
//   ### Skills                       | Skill | Source | Tokens |
//   | and 12 more |  | 4.5k |
//
// `claude -p /context` prints the same markdown, unbounded, as the command's
// stdout, which a transcript keeps inside <local-command-stdout>.
//
// WHY THE DECK WANTS IT. Every other figure the Context tab shows is the deck's
// own estimate from the transcript; it cannot see the system prompt, the tools
// or the memory files inside a request. This is Claude Code's own count of
// them, so the tab shows it whenever the session has one.
//
// WHEN IT STOPS BEING TRUE. `/clear` and `/compact` (and an automatic compact)
// throw away the window it describes, so either one after it drops it. The
// turns after it only add messages, which the client shows as "Since then".

/** The cheap test every transcript line gets before anything is parsed. */
export const CONTEXT_USAGE_MARK = "## Context Usage";

/** The same /clear and /compact marker transcript-scan.mjs resets its own
 *  context counts at, and the system line an automatic compact writes. */
const RESET_RE = /<command-name>\s*\/(?:clear|compact)\s*<\/command-name>/;
const COMPACT_BOUNDARY_MARK = '"compact_boundary"';
const STDOUT_RE = /^\s*<local-command-stdout>([\s\S]*?)(?:<\/local-command-stdout>\s*)?$/;
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Bounds on what one malformed or hostile block can put on the wire. A real
 *  bounded block holds eleven rows a list; an unbounded one a few hundred. */
const MAX_ROWS = 200;
const MAX_TEXT = 300;
const MAX_TOKENS = 1e9;

/** The headings the lists are found under, lower-cased. Older and newer Claude
 *  Code builds may add others; those are skipped. */
const SECTIONS = new Map([
  ["estimated usage by category", "categories"],
  ["mcp tools", "mcpTools"],
  ["other mcp tools, by server", "mcpServers"],
  ["custom agents", "agents"],
  ["memory files", "memory"],
  ["skills", "skills"],
]);

/** "3.1k" / "86k" / "1.2m" / "512" / "12,345" as a whole number, or null.
 *  Claude Code writes its own compact figures; a leading "~" or "<" is
 *  tolerated, as is a "tokens" unit after the figure. */
export function parseTokenCount(raw) {
  if (typeof raw !== "string") return null;
  const m = /^[~<>≈]?\s*(\d[\d,]*(?:\.\d+)?)\s*([kmb])?\s*(?:tokens?|tok)?$/i.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? "").toLowerCase();
  const scale = unit === "k" ? 1e3 : unit === "m" ? 1e6 : unit === "b" ? 1e9 : 1;
  return Math.min(MAX_TOKENS, Math.round(n * scale));
}

/** "1.5%" as 1.5, or null. */
function parsePercent(raw) {
  const m = /^(\d+(?:\.\d+)?)\s*%$/.exec(String(raw ?? "").trim());
  return m ? Number(m[1]) : null;
}

const clip = (s) => {
  const text = String(s ?? "").replace(/\s+/g, " ").trim();
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 1) + "…" : text;
};

/** One markdown table row as its cells, or null for anything that is not one. */
function cellsOf(line) {
  const s = line.trim();
  if (!s.startsWith("|")) return null;
  const inner = s.endsWith("|") && s.length > 1 ? s.slice(1, -1) : s.slice(1);
  return inner.split("|").map(c => c.trim());
}

/** A header row's separator: |---|---|. */
const isSeparator = (cells) => cells.every(c => /^:?-{2,}:?$/.test(c));

/** Three cells: the first, the middle ones joined (a path may hold a "|"), and
 *  the last. Every list Claude Code writes has three columns. */
function threeCells(cells) {
  if (!cells || cells.length < 3) return null;
  return [cells[0], cells.slice(1, -1).join("|").trim(), cells[cells.length - 1]];
}

/** The text of a user line's content: a string, or the text blocks of an array. */
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") out += block.text;
    else if (typeof block === "string") out += block;
  }
  return out;
}

/** The markdown with a <local-command-stdout> wrapper taken off, and whether it
 *  had one. */
function unwrap(text) {
  const m = STDOUT_RE.exec(text);
  return m ? { body: m[1], wrapped: true } : { body: text, wrapped: false };
}

/**
 * The breakdown one `## Context Usage` block states, or null when the text is
 * not one. Never throws: a row it cannot read is skipped, a list it does not
 * know is ignored, and a list that is not there is empty.
 */
export function parseContextSnapshot(markdown) {
  try {
    return parse(markdown);
  } catch {
    return null;
  }
}

function parse(markdown) {
  if (typeof markdown !== "string") return null;
  const text = unwrap(markdown.replace(ANSI_RE, "")).body.replace(/\r\n?/g, "\n").trim();
  if (!text.startsWith(CONTEXT_USAGE_MARK)) return null;

  const snap = {
    model: "",
    used: 0,
    max: 0,
    pct: 0,
    estimated: false,
    categories: [],
    free: 0,
    buffer: null,
    mcpTools: [],
    mcpServers: [],
    agents: [],
    memory: [],
    skills: [],
    more: {},
  };
  let usedSeen = false;
  let pctSeen = false;
  let section = null;     // which list the rows below belong to, or null
  let headerDone = false; // the current table's header and separator are behind us

  for (const raw of text.split("\n").slice(1)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const heading = /^#{2,4}\s+(.*)$/.exec(line);
      section = heading ? (SECTIONS.get(heading[1].trim().toLowerCase()) ?? null) : null;
      headerDone = false;
      continue;
    }
    const model = /^\*\*Model:\*\*\s*(.+)$/.exec(line);
    if (model) { snap.model = clip(model[1]); continue; }
    const tokens = /^\*\*Tokens:\*\*\s*(.+?)\s*\/\s*(.+?)(?:\s*\((\d+(?:\.\d+)?)%\))?$/.exec(line);
    if (tokens) {
      const used = parseTokenCount(tokens[1]);
      const max = parseTokenCount(tokens[2]);
      if (used !== null && max !== null) {
        snap.used = used; snap.max = max; usedSeen = true;
        if (tokens[3] !== undefined) { snap.pct = Number(tokens[3]); pctSeen = true; }
      }
      continue;
    }
    if (/token count is an estimate/i.test(line)) { snap.estimated = true; continue; }
    if (!section) continue;
    const cells = cellsOf(line);
    if (!cells) continue;
    if (!headerDone) {
      // The column names, then the |---| row; neither is data.
      if (isSeparator(cells)) headerDone = true;
      continue;
    }
    addRow(snap, section, cells);
  }

  // A block without a readable Tokens line still says what is in the window:
  // the window is everything listed, the used part everything but the room.
  if (!usedSeen) {
    const listed = snap.categories.filter(c => !c.deferred).reduce((n, c) => n + c.tokens, 0);
    snap.used = listed;
    snap.max = listed + snap.free + (snap.buffer?.tokens ?? 0);
  }
  if (!(snap.max > 0)) return null;
  if (!pctSeen) snap.pct = Math.round((snap.used / snap.max) * 100);
  for (const c of snap.categories) if (c.pct === null) c.pct = Math.round((c.tokens / snap.max) * 1000) / 10;
  return snap;
}

function addRow(snap, section, row) {
  if (section === "categories") {
    // Category | Tokens | Percentage. A row without its share still says its
    // tokens, and the share is worked out from the window afterwards.
    if (row.length < 2) return;
    const name = clip(row[0]);
    const tokens = parseTokenCount(row[1]);
    if (!name || tokens === null) return;
    if (/^free space$/i.test(name)) { snap.free = tokens; return; }
    if (/^(?:auto-?compact|compact) buffer$/i.test(name)) { snap.buffer = { name, tokens }; return; }
    if (snap.categories.length >= MAX_ROWS) return;
    snap.categories.push({ name, tokens, pct: parsePercent(row[2]), deferred: /\(deferred\)\s*$/i.test(name) });
    return;
  }
  const cells = threeCells(row);
  if (!cells) return;
  const [first, middle, last] = cells;
  const tokens = parseTokenCount(last);
  if (tokens === null) return;
  // The bounded block's tail: | and 12 more |  | 4.5k |
  const more = /^and (\d+) more$/i.exec(first);
  if (more && !middle) {
    snap.more[section] = { count: Math.min(Number(more[1]), 1e6), tokens };
    return;
  }
  const list = snap[section];
  if (list.length >= MAX_ROWS) return;
  const a = clip(first);
  const b = clip(middle);
  if (!a) return;
  switch (section) {
    case "mcpTools": list.push({ name: a, server: b, tokens }); break;
    case "mcpServers": {
      const tools = parseTokenCount(b);
      list.push({ server: a, tools: tools ?? 0, tokens });
      break;
    }
    case "agents": list.push({ type: a, source: b, tokens }); break;
    case "memory": if (b) list.push({ type: a, path: b, tokens }); break;
    case "skills": list.push({ name: a, source: b, tokens }); break;
  }
}

/**
 * The snapshot one transcript line carries, with the line's own time, or null.
 *
 * Main chain only, and only a line Claude Code wrote for itself: the meta user
 * line `/context` adds, or a command's stdout. A person who pastes a
 * `## Context Usage` block into a prompt has written a prompt, not a snapshot.
 * The time is the line's, never the clock here, as for the recap: the deck may
 * be reading a line written while it was down.
 */
export function contextSnapshotOf(line) {
  if (!line || !line.includes(CONTEXT_USAGE_MARK)) return null;
  let obj = null;
  try { obj = JSON.parse(line); } catch { return null; }
  if (!obj || typeof obj !== "object" || obj.type !== "user" || obj.isSidechain === true) return null;
  const at = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
  if (!Number.isFinite(at)) return null;
  const msg = obj.message;
  const text = contentText(msg && typeof msg === "object" ? msg.content : obj.content);
  const { wrapped } = unwrap(text);
  if (obj.isMeta !== true && !wrapped) return null;
  const snap = parseContextSnapshot(text);
  return snap ? { ...snap, at: new Date(at).toISOString() } : null;
}

/** Does this line throw the context window away: `/clear`, `/compact`, or the
 *  boundary an automatic compact writes? */
function resetsContext(line) {
  const marked = RESET_RE.test(line);
  if (!marked && !line.includes(COMPACT_BOUNDARY_MARK)) return false;
  let obj = null;
  try { obj = JSON.parse(line); } catch { return false; }
  if (!obj || typeof obj !== "object" || obj.isSidechain === true) return false;
  if (obj.type === "system" && obj.subtype === "compact_boundary") return true;
  if (!marked || obj.type !== "user") return false;
  const msg = obj.message;
  return RESET_RE.test(contentText(msg && typeof msg === "object" ? msg.content : obj.content));
}

/**
 * Fold one transcript line into `out.contextSnapshot`: set by a newer
 * snapshot, dropped by a `/clear` or `/compact` after it.
 *
 * Pure, and shaped like foldRecapLine so the transcript cursor runs it over the
 * same line. The ordinary line costs a substring test or two; only a line that
 * carries the heading or a reset marker is parsed.
 */
export function foldContextSnapshotLine(out, line) {
  if (!line) return;
  const snap = contextSnapshotOf(line);
  if (snap) { out.contextSnapshot = snap; return; }
  if (out.contextSnapshot && resetsContext(line)) out.contextSnapshot = null;
}

/** Could this appended text move a session's snapshot? The output watch asks
 *  before it asks the cursor to fold the file. */
export function mayMoveSnapshot(text) {
  return typeof text === "string" && (
    text.includes(CONTEXT_USAGE_MARK) || text.includes(COMPACT_BOUNDARY_MARK) || RESET_RE.test(text)
  );
}
