// What a rail row says, as data: its glyph, its clock, its second line and its
// tooltip, and what a session is called on every surface that names one. Pure,
// so the suite can ask each state what it reads without drawing the rail.
// components/RailParts.tsx only lays these out.
import { isAlarming } from "./ambient-counts";
import { blockedToolTooltip, waitingSentence } from "./agent-copy";
import { fmtCost } from "./pricing";
import { sessionSpendLabel } from "./board-usage";
import { currentLanguage, t, type TFunction } from "./i18n";
import { noteSource, noteTag, promptLine } from "./session-note";
import { planSpoken } from "./agent-plan";
import { salientField } from "./tool-input";
import type { Row } from "./components/SessionList";
import { agoShort, elapsedShort } from "./elapsed-short";
import type { RailGroup } from "./rail-model";
import { distinctIdTail } from "./session-id-tail";
import { sessionDisplay, sessionListName } from "./session-display";
import { injectedPrompt } from "./injected-prompt";
import type { AgentNodeData, PromptEntry } from "./types";

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

/**
 * WHAT A SESSION IS CALLED, ONE RULE FOR EVERY SURFACE THAT NAMES IT (owner's
 * critique, 2026-11-11): the board's pill and hover card, the navigator's
 * tile, the Sessions list, the Inspector's head, the command menu and the
 * stage. One session read "CCDECK · 2886" on the board, "ccdeck" over "7d4a"
 * in the list and "ccdeck · 2886" under a floating "retention job" in the
 * navigator.
 *
 * `title` is the session's name, else Claude Code's title, else its folder
 * (session-display.ts sessionListName). `folder` is there only when the title
 * is something else. `task` is what a person last asked it (sessionTask), left
 * out when it only says the title again.
 */
export interface SessionNames {
  title: string;
  folder?: string;
  task?: string;
}

type Nameable = Pick<AgentNodeData, "label" | "cwdBasename" | "sessionName" | "sessionTitle" | "prompts" | "firstPrompt">;

export function sessionNames(a: Nameable): SessionNames {
  const title = sessionListName(a) ?? t("board.kind.session");
  const folder = a.cwdBasename && !sameWords(a.cwdBasename, title) ? a.cwdBasename : "";
  const asked = sessionTask(a);
  const task = asked && !sameWords(asked, title) ? asked : "";
  return { title, ...(folder ? { folder } : null), ...(task ? { task } : null) };
}

/**
 * The session's task: the newest prompt a person typed, else the first one the
 * deck kept, as its first line. A background task's notice arrives on the hook
 * a person's typing does and is skipped (injected-prompt.ts), so a session whose
 * latest prompt is a notice reads by the prompt before it, and one with only
 * notices has no task. Empty when nothing was asked.
 */
export function sessionTask(a: Pick<AgentNodeData, "prompts" | "firstPrompt">): string {
  const text = lastTypedPrompt(a);
  return text ? promptLine(text) : "";
}

/**
 * What a card's face says from a distance (AgentNode's NodeFace), at every
 * distance below the full card: a root's task, else the name it was given or
 * Claude Code's title; a subagent's own task, else its name.
 *
 * Never the folder (owner's critique, round 3): the session's tag right above
 * the face names it, and a face that said it again read "ccdeck" under
 * "CCDECK". Empty when a root has been asked nothing and has no name, and the
 * face then draws its state alone.
 */
export function faceTask(a: Pick<AgentNodeData, "kind" | "label" | "sessionName" | "sessionTitle" | "prompts" | "firstPrompt" | "spawnCall">): string {
  if (a.kind !== "root") return a.spawnCall?.description || a.label;
  const said = sessionTask(a) || sessionDisplay(a.sessionName, a.sessionTitle).face || "";
  return said && !sameWords(said, a.label) ? said : "";
}

/** sessionTask's prompt whole, every line of it: for a surface that cuts it to
 *  a measure of its own. */
export function lastTypedPrompt(a: Pick<AgentNodeData, "prompts" | "firstPrompt">): string {
  let newest: PromptEntry | undefined;
  for (const p of a.prompts) if (!injectedPrompt(p.text) && (!newest || p.at >= newest.at)) newest = p;
  return newest?.text ?? (a.firstPrompt && !injectedPrompt(a.firstPrompt) ? a.firstPrompt : "");
}

/** The second line where sessions are listed (the Sessions list, the
 *  navigator's tile, the command menu): "folder · task", the task alone under a
 *  title that is the folder, the folder alone before anything was asked. Empty
 *  when there is neither, and the row is one line. */
export function namesLine(n: SessionNames): string {
  return [n.folder, n.task].filter(Boolean).join(" · ");
}

/**
 * What tells two sessions of one name apart, kept for the hover rather than
 * drawn: when it started, by the reader's clock so it never ticks while you
 * look at it, and as much of its id's tail as `peers` (the other sessions' ids)
 * leave it needing. An earlier day leads with its weekday, so yesterday's 14:32
 * is not today's.
 */
export function startedHover(startedAt: number, sessionId: string, peers: Iterable<string> = [], now = Date.now(), tr: TFunction = t): string {
  return startedLine(startedAt, distinctIdTail(sessionId, peers), now, tr);
}

/** startedHover with the id's tail already cut ("Started 14:32 · 4efa"). */
export function startedLine(startedAt: number, idTail: string, now = Date.now(), tr: TFunction = t): string {
  const lang = currentLanguage();
  const at = new Date(startedAt);
  const day = at.toDateString() === new Date(now).toDateString() ? "" : `${at.toLocaleDateString(lang, { weekday: "short" })} `;
  const time = `${day}${at.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" })}`;
  return `${tr("board.row.startedAt", { time })} · ${idTail}`;
}

/** Two names a reader takes for one: case and the space around them aside. */
export function sameWords(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** A Sessions list row's second line. A `tool` line is the tool's name in the
 *  heavier weight and what it works on (a path, a command) after it, in the
 *  mono face; `words` are in the UI face. Null leaves the line out. */
export type RailLine =
  | { kind: "tool"; name: string; rest: string }
  | { kind: "words"; text: string };

/**
 * The line under a row's name. The list is for triage, so a row waiting on you
 * says what it waits on: the question it asks, the blocked tool and what it
 * works on, or the waiting sentence. A row never given a prompt says it is
 * Ready. Every other row reads "folder · task" (namesLine), and a row with
 * neither is one line.
 */
export function railLine(r: Row, group: RailGroup): RailLine | null {
  if (group === 0 && r.waiting) {
    const sentence = waitingSentence(r.waiting);
    if (r.waiting.kind === "asked") return { kind: "words", text: t("board.row.asks", { sentence }) };
    if (r.waiting.tool) return { kind: "tool", name: r.waiting.tool.name, rest: toolRest(r.waiting.tool, r.cwd) };
    return { kind: "words", text: sentence };
  }
  const task = r.task || (r.neverPrompted ? t("board.row.ready") : "");
  const text = namesLine({ title: r.label, folder: r.folder, task });
  return text ? { kind: "words", text } : null;
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
 * its backslashes.
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

/** Everything the row does not draw, whole, and who wrote the note: the
 *  tooltip is where a cut task, what it waits on or runs, when it started and
 *  its id stay readable. */
export function rowTooltip(r: Row, removed: boolean): string {
  const lines: string[] = [removed ? t("board.row.bringBack", { label: r.label }) : t("board.row.focus", { label: r.label })];
  if (r.folder) lines.push(t("board.row.inFolder", { folder: r.folder }));
  if (r.task) lines.push(r.task);
  lines.push(r.hover ?? startedHover(r.startedAt, r.sessionId));
  if (r.waiting) {
    lines.push(
      waitingSentence(r.waiting),
      blockedToolTooltip(r.waiting, waitingSentence(r.waiting)) ?? "",
      t(isAlarming(r.waiting) ? "board.row.blockedSince" : "board.row.yourTurnSince", {
        time: new Date(r.waiting.since).toLocaleTimeString(),
      }),
    );
  } else if (r.tool) {
    // The call it is running, whole.
    lines.push(r.tool.preview ? `${r.tool.name} · ${r.tool.preview}` : r.tool.name);
  } else if (r.job) {
    // A turn that ended with a job still going: the job's own line.
    const said = (r.job.state === "blocked" && r.job.needs) || r.job.detail;
    if (said) lines.push(said);
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

/** The running call, for the row's tooltip: the tool's name and the line a
 *  person reads from its input (the command, the path), the same extraction
 *  the Needs you line uses (tool-input.ts). A tool with nothing worth reading
 *  stands on its name alone: never the JSON of its input. */
export function runningTool(call: { name: string; input?: unknown }): { name: string; preview: string; path?: true } {
  const field = salientField(call.input);
  return { name: call.name, preview: field?.text ?? "", ...(field?.path ? { path: true as const } : {}) };
}

/** What the row does not draw, as words for a screen reader and for touch,
 *  where a tooltip is not reached: what it waits on, the plan's progress, the
 *  note's tag, the tool count, the spend and the suggested reply. Kept in the
 *  row's button as visually hidden text; the tooltip stays as well. */
export function rowSpoken(r: Row): string {
  const parts: string[] = [];
  if (r.waiting) parts.push(waitingSentence(r.waiting));
  if (r.plan) parts.push(planSpoken(r.plan));
  if (r.status) parts.push(`${noteTag(r.status.kind)}${r.status.reply ? t("board.row.spokenReply", { reply: r.status.reply }) : ""}`);
  else if (r.recap) parts.push(noteTag("recap"));
  parts.push(t("board.toolCount", { count: r.toolCount }));
  if (r.cost > 0) parts.push(t("board.row.spend", { cost: fmtCost(r.cost), label: sessionSpendLabel() }));
  return parts.join(". ");
}
