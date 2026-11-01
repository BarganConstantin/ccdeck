// What a rail row says, as data: its glyph, its clock, its second line and its
// tooltip. Pure, so the suite can ask each state what it reads without drawing
// the rail. components/RailParts.tsx only lays these out.
import { isAlarming } from "./ambient-counts";
import { blockedToolTooltip, waitingSentence } from "./agent-copy";
import { fmtCost } from "./pricing";
import { SESSION_SPEND_LABEL } from "./board-usage";
import { noteSource, noteTag } from "./session-note";
import { planSpoken } from "./agent-plan";
import { salientInput } from "./tool-input";
import type { Row } from "./components/SessionList";
import { elapsedShort } from "./elapsed-short";
import type { RailGroup } from "./rail-model";

/** Figma's Glyph: Waiting, Working, Done, Idle, Error. Background wears the
 *  Working mark, the session being at work while its turn has ended. */
export type RailGlyphKind = "waiting" | "working" | "done" | "idle" | "error";

export function railGlyph(r: Row, group: RailGroup): RailGlyphKind {
  if (group === 0) return "waiting";
  if (group === 1) return "working";
  if (r.state === "err") return "error";
  if (r.neverPrompted) return "idle";
  // Done · unseen is a turn that ended, whatever the root's state still says:
  // a row marked active with an idle-prompt block is "your turn", and reads Done.
  if (group === 2) return "done";
  return r.state === "done" ? "done" : "idle";
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
    if (r.waiting.kind === "asked") return { kind: "mono", text: `Asks · ${sentence}` };
    if (r.waiting.tool) return { kind: "tool", name: r.waiting.tool.name, rest: r.waiting.tool.preview };
    return { kind: "mono", text: sentence };
  }
  if (group === 1) {
    if (r.tool) return { kind: "tool", name: r.tool.name, rest: r.tool.preview };
    // A turn that ended with a job still going: the job's own line, never a
    // count it does not carry.
    if (r.state !== "active" && r.job) {
      const said = (r.job.state === "blocked" && r.job.needs) || r.job.detail;
      return { kind: "sans", text: said ? `Turn ended · ${said}` : "Turn ended" };
    }
    return note ? { kind: "mono", text: note } : null;
  }
  if (r.neverPrompted) return { kind: "sans", text: "Ready for a first prompt" };
  return note ? { kind: "mono", text: note } : null;
}

/** The clock at the row's right edge. Needs you counts the wait, in the warn
 *  tone; Working counts the turn; a finished or idle row says how long ago the
 *  turn ended; a session that never had a prompt has none. `spoken` is the
 *  word a screen reader hears first, since the number alone is not "waiting". */
export function railTime(r: Row, group: RailGroup, now: number): { text: string; tone: "warn" | "quiet"; spoken: string } | null {
  if (group === 0 && r.waiting) return { text: elapsedShort(r.waiting.since, undefined, now), tone: "warn", spoken: "waiting " };
  if (group === 1) return { text: elapsedShort(r.turnStartedAt ?? r.startedAt, undefined, now), tone: "quiet", spoken: "running " };
  if (r.neverPrompted || r.turnEndedAt == null) return null;
  return { text: `${elapsedShort(r.turnEndedAt, undefined, now)} ago`, tone: "quiet", spoken: r.waiting?.kind === "idle" ? "your turn, ended " : "ended " };
}

/** Everything the row no longer draws, whole, and who wrote the note: the
 *  tooltip is where a clamped line and the dropped figures stay readable. */
export function rowTooltip(r: Row, removed: boolean): string {
  const lines: string[] = [removed ? `Bring ${r.label} back to the board` : `Focus ${r.label}`];
  if (r.waiting) {
    lines.push(
      waitingSentence(r.waiting),
      blockedToolTooltip(r.waiting, waitingSentence(r.waiting)) ?? "",
      `${isAlarming(r.waiting) ? "Blocked" : "Your turn"} since ${new Date(r.waiting.since).toLocaleTimeString()} · started ${new Date(r.startedAt).toLocaleString()}`,
    );
  } else {
    lines.push(`Started ${new Date(r.startedAt).toLocaleString()}`);
  }
  lines.push(`${r.toolCount} ${r.toolCount === 1 ? "tool" : "tools"}${r.cost > 0 ? ` · ${fmtCost(r.cost)} ${SESSION_SPEND_LABEL}` : ""}`);
  if (r.plan) lines.push(r.planTitle);
  if (r.recap) lines.push(r.recap.text);
  if (r.status) {
    lines.push(r.status.text);
    if (r.status.reply) lines.push(`Suggested reply: ${r.status.reply}`);
    lines.push(noteSource(r.status));
  }
  return lines.filter(Boolean).join("\n");
}

/** The running call as a working row's second line has it: the tool's name and
 *  the line a person reads from its input (the command, the path), the same
 *  extraction the Needs you line uses (tool-input.ts). A tool with nothing
 *  worth reading stands on its name alone: never the JSON of its input. */
export function runningTool(call: { name: string; input?: unknown }): { name: string; preview: string } {
  return { name: call.name, preview: salientInput(call.input) ?? "" };
}

/** What the old row said that this one no longer draws, as words for a screen
 *  reader and for touch, where a tooltip is not reached: the plan's progress,
 *  the note's tag, the tool count, the spend and the suggested reply. Kept in
 *  the row's button as visually hidden text; the tooltip stays as well. */
export function rowSpoken(r: Row): string {
  const parts: string[] = [];
  if (r.plan) parts.push(planSpoken(r.plan));
  if (r.status) parts.push(`${noteTag(r.status.kind)}${r.status.reply ? `, suggested reply: ${r.status.reply}` : ""}`);
  else if (r.recap) parts.push(noteTag("recap"));
  parts.push(`${r.toolCount} ${r.toolCount === 1 ? "tool" : "tools"}`);
  if (r.cost > 0) parts.push(`${fmtCost(r.cost)} ${SESSION_SPEND_LABEL}`);
  return parts.join(". ");
}
