// What `ccdeck accounts`, `ccdeck usage` and `ccdeck sessions` print (#2183).
//
// Pure — rows, a palette, glyphs and a width in; lines out — so the layout can
// be pinned at 40 columns and at 120 without a terminal, and so the same rows a
// running deck serves and the rows read in this process draw identically. The
// palette and glyphs are the boot's own (term.mjs), which is what makes these
// lines look like the product rather than like a script beside it: the same
// colour tier, the same ASCII fallback on a console that cannot draw a block.
import { sinceLabel, stripAnsi } from "./term.mjs";

/**
 * Text that came from somewhere else — a session's title and folder, the
 * question Claude Code passed on, an alias somebody typed — on one line and
 * without the bytes a terminal acts on. A newline would break the row it is
 * in, and an ESC would reach the terminal as a command rather than as text.
 */
export function oneLine(s) {
  return String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
}

// The columns a character takes: two for the wide ones (CJK, Hangul, the
// fullwidth forms, the pictographic emoji), none for combining marks, joiners
// and variation selectors, one otherwise. Enough of wcwidth that a title in
// Japanese, or with an emoji in it, does not wrap the row it was clipped to.
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1f300}-\u{1f64f}\u{1f680}-\u{1f6ff}\u{1f900}-\u{1f9ff}\u{20000}-\u{3fffd}]/u;
const ZERO = /[\p{Mn}\p{Me}​-‏︀-️]/u;
const cellsOf = (ch) => (ZERO.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1);

/** How many columns `s` takes on a terminal, its colour codes not counted. */
export function textWidth(s) {
  let w = 0;
  for (const ch of stripAnsi(String(s))) w += cellsOf(ch);
  return w;
}

/** The longest start of `s` that fits in `n` columns. */
function takeCells(s, n) {
  let out = "";
  let w = 0;
  for (const ch of s) {
    const c = cellsOf(ch);
    if (w + c > n) break;
    out += ch;
    w += c;
  }
  return out;
}

/** A ten-cell meter, or `cells` of them. Blocks where the terminal can draw
 *  them, `#` and `.` where it cannot. */
export function meter(pct, { cells = 10, unicode = true } = {}) {
  const p = Math.min(100, Math.max(0, Number(pct) || 0));
  const full = Math.round((p / 100) * cells);
  const [on, off] = unicode ? ["█", "░"] : ["#", "."];
  return on.repeat(full) + off.repeat(cells - full);
}

/** The tone a percentage is drawn in: the panel's thresholds, near the limit
 *  in warn and at it in err. */
export function pctTone(pct, tone) {
  return pct >= 90 ? tone.err : pct >= 75 ? tone.warn : tone.ok;
}

/** "1h 12m" until a reset given in epoch SECONDS, or "" when there is none or
 *  it has passed — a reset in the past is a reading that is out of date, and
 *  "resets in 0s" would claim otherwise. */
export function untilReset(resetAt, now = Date.now()) {
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt)) return "";
  const ms = resetAt * 1000 - now;
  return ms > 0 ? sinceLabel(ms) : "";
}

const padEnd = (s, n) => s + " ".repeat(Math.max(0, n - textWidth(s)));
const padStart = (s, n) => " ".repeat(Math.max(0, n - textWidth(s))) + s;
// Cut to `n` columns with the glyph tier's own ellipsis, which is three
// characters on a console that cannot draw the one-character one.
export const clip = (s, n, ellipsis = "…") => (textWidth(s) <= n ? s
  : n <= textWidth(ellipsis) ? takeCells(s, n) : `${takeCells(s, n - textWidth(ellipsis))}${ellipsis}`);

/** What is wrong with an account, in words, or null when nothing is. */
export function accountTrouble(a) {
  if (a.disabled) return { word: "disabled", tone: "muted" };
  if (a.error && !a.staleCopy) return { word: "sign-in needed", tone: "err" };
  if (a.stopped) return { word: "not collecting usage", tone: "warn" };
  return null;
}

function lanesText(a, { tone, g, unicode, now, wide }) {
  const lanes = (a.lanes ?? []).filter(l => l.id === "five_hour" || l.id === "seven_day");
  if (!lanes.length) {
    return a.fetchedAt == null ? `${tone.muted}not read yet${tone.reset}` : `${tone.muted}no usage reading${tone.reset}`;
  }
  return lanes.map(l => {
    const pct = `${Math.round(l.pct)}%`;
    const until = untilReset(l.resetAt, now);
    const bar = wide ? ` ${pctTone(l.pct, tone)}${meter(l.pct, { unicode })}${tone.reset}` : "";
    const reset = wide && until ? ` ${tone.muted}${g.restart} ${padEnd(until, 7)}${tone.reset}` : wide ? "          " : "";
    return `${tone.muted}${l.label}${tone.reset}${bar} ${pctTone(l.pct, tone)}${padStart(pct, 4)}${tone.reset}${reset}`;
  }).join("  ");
}

/**
 * The roster, one account per line, the active one marked.
 *
 * Three widths. From 104 columns each lane has its meter and its reset; from 64
 * the percentages stand alone; below that the alias goes and the email is
 * clipped. Nothing wraps: a row that wrapped would put one account's usage
 * under another's name.
 */
export function accountLines(accounts, { tone, g, unicode = true, columns = 80, now = Date.now() } = {}) {
  const rows = Array.isArray(accounts) ? accounts : [];
  if (!rows.length) return [`  ${tone.muted}${g.dash}  no Claude accounts yet${tone.reset}`];
  const wide = columns >= 104;
  const aliasOf = (a) => oneLine(a.alias);
  const emailOf = (a) => oneLine(a.email) || "(no email)";
  const showAlias = columns >= 64 && rows.some(a => aliasOf(a));
  const numW = Math.max(...rows.map(a => String(a.num).length));
  const aliasW = showAlias ? Math.min(14, Math.max(...rows.map(a => textWidth(aliasOf(a))))) : 0;
  // What is left for the email once the mark, the slot, the alias and the
  // lanes have their room; never less than 12, which still shows whose it is.
  const lanesW = wide ? 66 : 20;
  const emailRoom = Math.max(12, columns - 2 - 2 - numW - 2 - (showAlias ? aliasW + 2 : 0) - 2 - lanesW);
  const emailW = Math.min(emailRoom, Math.max(...rows.map(a => textWidth(emailOf(a)))));
  return rows.map(a => {
    const mark = a.active ? `${tone.ok}${g.pulse}${tone.reset}` : " ";
    const num = `${a.active ? tone.bold : ""}${padStart(String(a.num), numW)}${tone.reset}`;
    const alias = showAlias ? `${tone.accent}${padEnd(clip(aliasOf(a), aliasW, g.ellipsis), aliasW)}${tone.reset}  ` : "";
    const email = padEnd(clip(emailOf(a), emailW, g.ellipsis), emailW);
    const trouble = accountTrouble(a);
    const status = trouble
      ? `${tone[trouble.tone]}${trouble.word}${tone.reset}`
      : lanesText(a, { tone, g, unicode, now, wide });
    // The last lane's reset is padded for the column after it, which the last
    // lane does not have: the padding goes, and the colour reset behind it stays.
    const line = `  ${mark} ${num}  ${alias}${email}  ${status}`.replace(/ +((?:\x1b\[[0-9;]*m)*)$/, "$1");
    // How old the reading is, where it fits: the one part of a row that can be
    // left off without the row saying something else.
    const age = !trouble && a.stale && a.fetchedAt != null
      ? `  ${tone.muted}read ${sinceLabel(now - a.fetchedAt)} ago${tone.reset}`
      : "";
    return textWidth(line) + textWidth(age) <= columns ? line + age : line;
  });
}

/** One account's lanes, at length, for `ccdeck usage`: every lane the roster
 *  holds, the model-scoped ones included, each with a twenty-cell meter. */
export function usageLines(a, { tone, g, unicode = true, columns = 80, now = Date.now() } = {}) {
  const alias = oneLine(a.alias);
  const head = `  ${tone.ok}${g.pulse}${tone.reset} ${tone.bold}#${a.num} ${oneLine(a.email) || "(no email)"}${tone.reset}`
    + `${alias ? ` ${tone.accent}(${alias})${tone.reset}` : ""}`;
  const out = [head, ""];
  const trouble = accountTrouble(a);
  if (trouble) out.push(`    ${tone[trouble.tone]}${trouble.word}${tone.reset}`);
  const lanes = a.lanes ?? [];
  const labelW = Math.max(2, ...lanes.map(l => String(l.label).length));
  const cells = columns >= 70 ? 20 : 10;
  for (const l of lanes) {
    const until = untilReset(l.resetAt, now);
    out.push(`    ${tone.muted}${padEnd(String(l.label), labelW)}${tone.reset}  ${pctTone(l.pct, tone)}${meter(l.pct, { cells, unicode })}`
      + `${padStart(`${Math.round(l.pct)}%`, 5)}${tone.reset}${until ? `   ${tone.muted}resets in ${until}${tone.reset}` : ""}`);
  }
  if (!lanes.length) out.push(`    ${tone.muted}${a.fetchedAt == null ? "not read yet" : "no usage reading"}${tone.reset}`);
  if (a.fetchedAt != null) out.push("", `    ${tone.muted}read ${sinceLabel(now - a.fetchedAt)} ago${tone.reset}`);
  return out;
}

/** "opus-4-1" for "claude-opus-4-1-20250805": the part a person says. */
export function shortModel(model) {
  if (typeof model !== "string" || !model) return "";
  return oneLine(model).replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/\[.*\]$/, "");
}

const STATE_WORDS = { waiting: "waiting", working: "working", idle: "your turn", ended: "ended" };

/**
 * The sessions, one per line, the ones waiting on a human first and their
 * question underneath in their own words.
 */
export function sessionLines(sessions, { tone, g, columns = 80, now = Date.now() } = {}) {
  const rows = Array.isArray(sessions) ? sessions : [];
  if (!rows.length) return [`  ${tone.muted}${g.dash}  no sessions right now${tone.reset}`];
  const label = (s) => oneLine(s.name) || oneLine(s.project) || oneLine(s.id).slice(0, 8);
  const agentOf = (s) => (s.provider === "codex" ? "Codex" : "Claude");
  // The mark, the state word and the age take 23 columns; the label gets what
  // the agent column leaves, and on a narrow terminal the agent column gives
  // way first — the model, then the agent — so the label, which is how a person
  // tells two sessions apart, keeps at least eight.
  const LEAD = 23;
  const tails = [
    (s) => `${agentOf(s)}${shortModel(s.model) ? ` ${g.bullet} ${shortModel(s.model)}` : ""}`,
    (s) => agentOf(s),
    () => "",
  ];
  const longestLabel = Math.max(...rows.map(s => textWidth(label(s))));
  const tailOf = tails.find(t => columns - LEAD - 2 - Math.max(...rows.map(s => textWidth(t(s)))) >= 8) ?? tails[2];
  const tailW = Math.max(...rows.map(s => textWidth(tailOf(s))));
  const labelW = Math.max(1, Math.min(longestLabel, columns - LEAD - (tailW ? tailW + 2 : 0)));
  const out = [];
  for (const s of rows) {
    const icon = s.state === "waiting" ? `${tone.warn}${g.warn}${tone.reset}`
      : s.state === "working" ? `${tone.ok}${g.pulse}${tone.reset}`
      : s.state === "idle" ? `${tone.accent}${g.bullet}${tone.reset}`
      : `${tone.muted}${g.dash}${tone.reset}`;
    const word = STATE_WORDS[s.state] ?? s.state;
    const wordTone = s.state === "waiting" ? tone.warn : s.state === "ended" ? tone.muted : "";
    const age = sinceLabel(now - (s.since ?? s.lastEventAt ?? now));
    const tail = tailOf(s);
    const named = padEnd(clip(label(s), labelW, g.ellipsis), labelW);
    out.push((`  ${icon} ${wordTone}${padEnd(word, 9)}${tone.reset} ${tone.muted}${padStart(age, 7)}${tone.reset}  `
      + `${tail ? `${named}  ${tone.muted}${tail}${tone.reset}` : named}`).replace(/ +((?:\x1b\[[0-9;]*m)*)$/, "$1"));
    if (s.state === "waiting" && s.waiting) {
      const what = oneLine(s.waiting.message) || (s.waiting.kind === "asked" ? "asked a question" : "needs your permission");
      // The tool the prompt is most likely about, unless Claude Code's own
      // sentence already names it — "permission to use Bash (Bash)" says
      // nothing twice over.
      const tool0 = oneLine(s.waiting.tool);
      const toolText = tool0 && !what.includes(tool0) ? ` (${tool0})` : "";
      const room = Math.max(8, columns - 6 - textWidth(toolText));
      const tool = toolText ? `${tone.muted}${toolText}${tone.reset}` : "";
      out.push(`      ${tone.warn}${clip(what, room, g.ellipsis)}${tone.reset}${tool}`);
    }
  }
  return out;
}
