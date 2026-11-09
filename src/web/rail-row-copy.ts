// What a rail row says, as data: its glyph, its clock, its second line and its
// tooltip. Pure, so the suite can ask each state what it reads without drawing
// the rail. components/RailParts.tsx only lays these out.
import { isAlarming } from "./ambient-counts";
import { blockedToolTooltip, waitingSentence } from "./agent-copy";
import { fmtCost } from "./pricing";
import { sessionSpendLabel } from "./board-usage";
import { t } from "./i18n";
import { noteSource, noteTag } from "./session-note";
import { planSpoken } from "./agent-plan";
import { salientField } from "./tool-input";
import type { Row } from "./components/SessionList";
import { agoShort, elapsedShort } from "./elapsed-short";
import type { RailGroup } from "./rail-model";

/** Figma's Glyph: Waiting, Working, Done, Idle, Error. Background wears the
 *  Working mark, the session being at work while its turn has ended. The
 *  hollow Idle ring is the Ready group's: a session not yet given a prompt. */
export type RailGlyphKind = "waiting" | "working" | "done" | "idle" | "error";

export function railGlyph(r: Row, group: RailGroup): RailGlyphKind {
  if (group === 0) return "waiting";
  if (group === 1) return "working";
  if (r.state === "err") return "error";
  if (r.neverPrompted) return "idle";
  // Done · new and Done are a turn that ended, whatever the root's state still
  // says: a row marked active with an idle-prompt block is "your turn", and
  // reads Done in both. CHANGED ON PURPOSE (design recommendations,
  // 2026-11-09): once seen it wore the Idle ring, under a group named Idle.
  return "done";
}

/** The row's second line. A `tool` line is the tool's name in the heavier
 *  weight and what it works on after it; `mono` is one run of text in the
 *  mono face; `sans` is a sentence in the UI face. Null leaves the line out. */
export type RailLine =
  | { kind: "tool"; name: string; rest: string }
  | { kind: "mono" | "sans"; text: string };

/** The line under a row's name. What the old row printed besides this (the
 *  tool count, the cost, the plan, the recap, the suggested reply) is in
 *  rowTooltip below. */
export function railLine(r: Row, group: RailGroup): RailLine | null {
  const note = r.recap?.text ?? r.status?.text ?? "";
  if (group === 0 && r.waiting) {
    const sentence = waitingSentence(r.waiting);
    if (r.waiting.kind === "asked") return { kind: "mono", text: t("board.row.asks", { sentence }) };
    if (r.waiting.tool) return { kind: "tool", name: r.waiting.tool.name, rest: toolRest(r.waiting.tool, r.cwd) };
    return { kind: "mono", text: sentence };
  }
  if (group === 1) {
    if (r.tool) return { kind: "tool", name: r.tool.name, rest: toolRest(r.tool, r.cwd) };
    // A turn that ended with a job still going: the job's own line, never a
    // count it does not carry.
    if (r.state !== "active" && r.job) {
      const said = (r.job.state === "blocked" && r.job.needs) || r.job.detail;
      return { kind: "sans", text: said ? t("board.row.turnEndedJob", { said }) : t("board.row.turnEnded") };
    }
    return note ? { kind: "mono", text: note } : null;
  }
  if (r.neverPrompted) return { kind: "sans", text: t("board.row.ready") };
  return note ? { kind: "mono", text: note } : null;
}

/** What a tool line prints after the tool's name: a path as rowPath shortens
 *  it, anything else (a command, a URL) as it is. */
function toolRest(tool: { preview: string; path?: true }, cwd: string | undefined): string {
  return tool.path ? rowPath(tool.preview, cwd) : tool.preview;
}

/**
 * A file's path as a row has room for it. A phone cut "Edit · /home/constantin/
 * Deskt…" off long before the file's name, which is the part that tells two
 * calls apart. Relative to the session's folder when the file is inside it
 * ("docs/install.md"), else its last two segments after "…/"; a path of two
 * segments or fewer is short already and stays as it is. A Windows path keeps
 * its backslashes. The whole path stays in the row's tooltip (rowTooltip).
 */
export function rowPath(path: string, cwd?: string): string {
  const base = cwd?.replace(/[\\/]+$/, "") ?? "";
  if (base && path.startsWith(base) && /[\\/]/.test(path.charAt(base.length))) {
    const inside = path.slice(base.length + 1);
    if (inside) return inside;
  }
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 2) return path;
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  return `…${sep}${parts.slice(-2).join(sep)}`;
}

/** The clock at the row's right edge. Needs you counts the wait, in the warn
 *  tone, and Working counts the turn, both to the second under an hour; a
 *  finished or idle row says how long ago the turn ended, to the minute; a
 *  session that never had a prompt has none. `spoken` is the word a screen
 *  reader hears first, since the number alone is not "waiting". */
export function railTime(r: Row, group: RailGroup, now: number): { text: string; tone: "warn" | "quiet"; spoken: string } | null {
  if (group === 0 && r.waiting) return { text: elapsedShort(r.waiting.since, undefined, now), tone: "warn", spoken: t("board.row.spokenWaiting") };
  if (group === 1) return { text: elapsedShort(r.turnStartedAt ?? r.startedAt, undefined, now), tone: "quiet", spoken: t("board.row.spokenRunning") };
  if (r.neverPrompted || r.turnEndedAt == null) return null;
  return {
    text: t("board.row.ago", { time: agoShort(r.turnEndedAt, undefined, now) }),
    tone: "quiet",
    spoken: r.waiting?.kind === "idle" ? t("board.row.spokenYourTurnEnded") : t("board.row.spokenEnded"),
  };
}

/** Everything the row no longer draws, whole, and who wrote the note: the
 *  tooltip is where a clamped line and the dropped figures stay readable. */
export function rowTooltip(r: Row, removed: boolean): string {
  const lines: string[] = [removed ? t("board.row.bringBack", { label: r.label }) : t("board.row.focus", { label: r.label })];
  if (r.waiting) {
    lines.push(
      waitingSentence(r.waiting),
      blockedToolTooltip(r.waiting, waitingSentence(r.waiting)) ?? "",
      t(isAlarming(r.waiting) ? "board.row.blockedSince" : "board.row.yourTurnSince", {
        time: new Date(r.waiting.since).toLocaleTimeString(),
        started: new Date(r.startedAt).toLocaleString(),
      }),
    );
  } else {
    lines.push(t("board.row.started", { started: new Date(r.startedAt).toLocaleString() }));
    // The running call's path, whole, where the row's line shortened it. A
    // waiting row has it already, in "Likely on" above.
    if (r.tool?.path && rowPath(r.tool.preview, r.cwd) !== r.tool.preview) lines.push(`${r.tool.name} · ${r.tool.preview}`);
  }
  const tools = t("board.toolCount", { count: r.toolCount });
  lines.push(r.cost > 0 ? t("board.row.toolsSpend", { tools, cost: fmtCost(r.cost), label: sessionSpendLabel() }) : tools);
  if (r.plan) lines.push(r.planTitle);
  if (r.recap) lines.push(r.recap.text);
  if (r.status) {
    lines.push(r.status.text);
    if (r.status.reply) lines.push(t("board.row.suggestedReply", { reply: r.status.reply }));
    lines.push(noteSource(r.status));
  }
  return lines.filter(Boolean).join("\n");
}

/** The running call as a working row's second line has it: the tool's name and
 *  the line a person reads from its input (the command, the path), the same
 *  extraction the Needs you line uses (tool-input.ts). A tool with nothing
 *  worth reading stands on its name alone: never the JSON of its input. A path
 *  says it is one, for the row to shorten (rowPath). */
export function runningTool(call: { name: string; input?: unknown }): { name: string; preview: string; path?: true } {
  const field = salientField(call.input);
  return { name: call.name, preview: field?.text ?? "", ...(field?.path ? { path: true as const } : {}) };
}

/** What the old row said that this one no longer draws, as words for a screen
 *  reader and for touch, where a tooltip is not reached: the plan's progress,
 *  the note's tag, the tool count, the spend and the suggested reply. Kept in
 *  the row's button as visually hidden text; the tooltip stays as well. */
export function rowSpoken(r: Row): string {
  const parts: string[] = [];
  if (r.plan) parts.push(planSpoken(r.plan));
  if (r.status) parts.push(`${noteTag(r.status.kind)}${r.status.reply ? t("board.row.spokenReply", { reply: r.status.reply }) : ""}`);
  else if (r.recap) parts.push(noteTag("recap"));
  parts.push(t("board.toolCount", { count: r.toolCount }));
  if (r.cost > 0) parts.push(t("board.row.spend", { cost: fmtCost(r.cost), label: sessionSpendLabel() }));
  return parts.join(". ");
}
