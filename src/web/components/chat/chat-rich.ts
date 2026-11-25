// The words and figures Chat's richer rows are drawn with, as pure functions:
// how long something took, the time a line was written, what a call's answer
// counted, the one line a command's output is previewed by, how a run of
// calls is summed up, and how long each answer took. The components that draw
// them are ChatCode, ChatDiff, ChatToolOutput, ChatThinking and ChatTime.
import { currentLanguage, type TFunction } from "../../i18n";
import { clockTime, formatNumber } from "../../i18n/format";
import type { ChatOutput, ChatStat, ChatTurn, ConversationBlock } from "./chat-model";

type Tool = Extract<ChatTurn, { kind: "tool" }>;

/** A span as Chat says it: "6s", "1m 27s", "2h 05m". Under a second reads 1s. */
export function durationText(ms: number, t: TFunction): string {
  const total = Math.max(1, Math.round(ms / 1000));
  if (total < 60) return t("board.chat.rich.dur.s", { s: total });
  if (total < 3600) return t("board.chat.rich.dur.ms", { m: Math.floor(total / 60), s: total % 60 });
  return t("board.chat.rich.dur.hm", { h: Math.floor(total / 3600), m: String(Math.floor((total % 3600) / 60)).padStart(2, "0") });
}

/** The time of day a line was written, on the reader's own clock: "15:56". */
export function clockText(at: number, lang = currentLanguage()): string {
  return clockTime(at, false, lang);
}

/** The whole date and time, for a title: "Tuesday 25 November 2026, 15:56:12". */
export function fullTime(at: number, lang = currentLanguage()): string {
  const opts: Intl.DateTimeFormatOptions = { dateStyle: "full", timeStyle: "medium" };
  try { return new Date(at).toLocaleString(lang, opts); } catch { return new Date(at).toLocaleString(undefined, opts); }
}

/** A size in bytes as KB or MB, in the language's own digits. */
function sizeText(bytes: number, t: TFunction): string {
  if (bytes < 1024) return t("board.chat.rich.stat.bytes", { n: formatNumber(bytes, 0) });
  if (bytes < 1024 * 1024) return t("board.chat.rich.stat.kb", { n: formatNumber(bytes / 1024, bytes < 10 * 1024 ? 1 : 0) });
  return t("board.chat.rich.stat.mb", { n: formatNumber(bytes / (1024 * 1024), 1) });
}

/** What a call's answer counted, in words: "182 lines", "12 matches · 3 files", "200 · 47 KB". */
export function statText(stat: ChatStat | undefined, t: TFunction): string {
  if (!stat) return "";
  const parts: string[] = [];
  if (stat.status !== undefined) parts.push(String(stat.status));
  if (stat.matches !== undefined) parts.push(t("board.chat.rich.stat.matches", { count: stat.matches }));
  if (stat.lines !== undefined) parts.push(t("board.chat.rich.stat.lines", { count: stat.lines }));
  if (stat.files !== undefined) parts.push(t("board.chat.rich.stat.files", { count: stat.files }));
  if (stat.results !== undefined) parts.push(t("board.chat.rich.stat.results", { count: stat.results }));
  if (stat.bytes !== undefined) parts.push(sizeText(stat.bytes, t));
  return parts.join(" · ");
}

/** The line a command's output is previewed by while its row is closed: the
 *  last line that says something, which is where a test run or a build sums
 *  up; the first when the output was cut, since its last is not here. */
export function outputPreview(output: ChatOutput | undefined): string {
  if (!output?.text) return "";
  const lines = output.text.split("\n").filter(line => line.trim());
  const line = output.cut ? lines[0] : lines[lines.length - 1];
  return (line ?? "").trim();
}

/** How many of the output's lines are not shown here; 0 when all are, or when that cannot be told. */
export function linesLeft(output: ChatOutput): number {
  const shown = output.text ? output.text.split("\n").length : 0;
  return Math.max(0, output.lines - shown);
}

/** How a command ended, for its chip: by its exit code, or stopped; null when nothing says. */
export function exitState(turn: Tool): "ok" | "failed" | "interrupted" | null {
  if (turn.interrupted) return "interrupted";
  if (turn.exit === undefined) return null;
  return turn.exit === 0 ? "ok" : "failed";
}

/** A row that runs a command: a Bash call, or a Codex tool with the terminal mark. */
export const isCommand = (turn: Tool) => turn.mark === "terminal" || turn.name === "Bash";

const READ_TOOLS = new Set(["Read", "NotebookRead"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "apply_patch"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob", "LS", "Explore"]);
const WEB_TOOLS = new Set(["WebFetch", "WebSearch"]);

export type WorkKind = "run" | "read" | "edit" | "search" | "web" | "other";
const WORK_ORDER: WorkKind[] = ["run", "read", "edit", "search", "web", "other"];
/** The most kinds a summary names; the rest are counted as other calls. */
export const MAX_WORK_PARTS = 3;

export function workKind(turn: Tool): WorkKind {
  if (isCommand(turn)) return "run";
  if (READ_TOOLS.has(turn.name)) return "read";
  if (EDIT_TOOLS.has(turn.name)) return "edit";
  if (SEARCH_TOOLS.has(turn.name) || turn.mark === "search") return "search";
  if (WEB_TOOLS.has(turn.name)) return "web";
  return "other";
}

/** How many of each kind a run of calls holds. Files read or edited are
 *  counted once each, however often they were touched. */
export function workCounts(turns: readonly ChatTurn[]): Map<WorkKind, number> {
  const files = { read: new Set<string>(), edit: new Set<string>() };
  const counts = new Map<WorkKind, number>();
  for (const turn of turns) {
    if (turn.kind !== "tool") continue;
    const kind = workKind(turn);
    if (kind === "read" || kind === "edit") {
      const seen = files[kind];
      const key = turn.arg || `#${seen.size}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return counts;
}

/** "Ran 3 commands · read 2 files · edited 1 file": when there are more kinds
 *  than a head holds, edits are named first (they are what changed), then the
 *  largest; named in a fixed order, the rest counted as other calls, sentence case. */
export function workSummary(turns: readonly ChatTurn[], t: TFunction, lang = currentLanguage()): string {
  const counts = workCounts(turns);
  const kinds = WORK_ORDER.filter(kind => counts.has(kind));
  let named = kinds;
  if (kinds.length > MAX_WORK_PARTS) {
    const rank = (k: WorkKind) => (k === "edit" ? Infinity : counts.get(k) ?? 0);
    const top = new Set<WorkKind>([...kinds].filter(k => k !== "other").sort((a, b) => rank(b) - rank(a)).slice(0, MAX_WORK_PARTS - 1));
    named = kinds.filter(k => top.has(k));
    const rest = kinds.filter(k => !top.has(k)).reduce((n, k) => n + (counts.get(k) ?? 0), 0);
    counts.set("other", rest);
    named.push("other");
  }
  const text = named.map(kind => t(`board.chat.rich.work.${kind}`, { count: counts.get(kind) ?? 0 })).join(" · ");
  return text ? text.charAt(0).toLocaleUpperCase(lang) + text.slice(1) : "";
}

/** How long an answer took and when it ended: from the time of what you sent
 *  before it to its last line's. */
export interface BlockTime {
  /** When its last line was written. */
  end: number;
  /** From your message to its last line, in ms; none when either time is unknown. */
  worked?: number;
}

/** The time of each answer in `blocks`, by its index there; an answer with no
 *  time on any of its lines has none. */
export function blockTimes(blocks: readonly ConversationBlock[]): Map<number, BlockTime> {
  const times = new Map<number, BlockTime>();
  let asked: number | undefined;
  for (const block of blocks) {
    if (block.kind === "user" || block.kind === "command") {
      asked = block.at;
      continue;
    }
    if (block.kind !== "assistant") continue;
    let end: number | undefined;
    for (const turn of block.turns) if (turn.at !== undefined && (end === undefined || turn.at > end)) end = turn.at;
    if (end === undefined) continue;
    const time: BlockTime = { end };
    if (asked !== undefined && end >= asked) time.worked = end - asked;
    times.set(block.index, time);
    asked = undefined;
  }
  return times;
}
