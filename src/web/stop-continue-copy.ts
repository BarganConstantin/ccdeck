// The words for continuing a turn that stopped on an expired login or a usage
// limit (#2193) — the card's Continue button and the line it leaves, and the
// detail panel's section — so every surface says one thing about one continue.
// What a continue IS is src/server/stop-continue.mjs's, and when one may run is
// src/server/stop-continue-gate.mjs's; this is only how the page words them.
import type { StopKind } from "../server/stop-failure.mjs";
import type { GateReason } from "../server/stop-continue-gate.mjs";
import { CONTINUE_PROMPT } from "../server/stop-continue-gate.mjs";
import { shortAgo } from "./relative-time";
import { t, type TFunction } from "./i18n";

/** What the server kept about the last continue of a session — a press or the
 *  automatic one — as GET /api/stop-continue answers it. */
export interface ContinueOutcome {
  at: number;
  auto: boolean;
  ok: boolean;
  /** "continued" in place, or "copied" when Claude Code started a copy. */
  outcome: "continued" | "copied" | null;
  /** Why it did not, when it did not: stop-continue.mjs's refusal codes. */
  reason: string | null;
  /** What the command said, one line. */
  detail: string;
  /** The deck stopped the session's process before the resume failed. */
  stopped: boolean;
}

/** Why Continue is not ready yet, as one sentence. */
export function gateSentence(reason: GateReason | null, tr: TFunction = t): string {
  switch (reason) {
    case "before-stop": return tr("board.continue.gate.beforeStop");
    case "no-room": return tr("board.continue.gate.noRoom");
    case "no-login": return tr("board.continue.gate.noLogin");
    default: return "";
  }
}

/** A press or an automatic continue that did not run, as one sentence. */
export function refusalSentence(reason: string | null, detail = "", stopped = false, tr: TFunction = t): string {
  // The command's own line, without the full stop it may already end on.
  const said = detail ? tr("board.continue.said", { detail: detail.replace(/[.\s]+$/, "") }) : "";
  switch (reason) {
    case "interactive": return tr("board.continue.refusal.interactive");
    case "not_listed": return tr("board.continue.refusal.notListed");
    case "working": return tr("board.continue.refusal.working");
    case "waiting": return tr("board.continue.refusal.waiting");
    case "not_held": return tr("board.continue.refusal.notHeld");
    case "no_dir": return tr("board.continue.refusal.noDir");
    case "unreadable": return tr("board.continue.refusal.unreadable");
    case "cli_failed": return tr("board.continue.refusal.cliFailed", { said });
    case "stop_failed": return tr("board.continue.refusal.stopFailed", { said });
    case "still_running": return tr("board.continue.refusal.stillRunning");
    case "resume_failed": return stopped
      ? tr("board.continue.refusal.resumeFailedStopped", { said })
      : tr("board.continue.refusal.resumeFailed", { said });
    case "busy": return tr("board.continue.refusal.busy");
    // The gate refused it on the server, which words its own reason.
    case "not_ready": return detail || tr("board.continue.refusal.notReady");
    case "unreachable": return tr("board.continue.refusal.unreachable");
    default: return tr("board.continue.refusal.refused");
  }
}

/** "Continued automatically 2m ago", "Continued 2m ago", "Continue failed 2m
 *  ago" — the card's line, and the panel's. */
export function outcomeLabel(o: ContinueOutcome, now: number, tr: TFunction = t): string {
  const ago = shortAgo(now - o.at);
  if (!o.ok) return tr(o.auto ? "board.continue.outcome.failedAuto" : "board.continue.outcome.failed", { ago });
  if (o.outcome === "copied") return tr(o.auto ? "board.continue.outcome.copiedAuto" : "board.continue.outcome.copied", { ago });
  return tr(o.auto ? "board.continue.outcome.continuedAuto" : "board.continue.outcome.continued", { ago });
}

/** What the line's tooltip adds: what was sent, or what went wrong. */
export function outcomeTooltip(o: ContinueOutcome, tr: TFunction = t): string {
  if (!o.ok) return refusalSentence(o.reason, o.detail, o.stopped, tr);
  const prompt = CONTINUE_PROMPT;
  const sent = tr(o.auto ? "board.continue.tooltip.sentAuto" : "board.continue.tooltip.sent", { prompt });
  const copy = o.outcome === "copied"
    ? `\n${o.detail ? tr("board.continue.tooltip.copyWhy", { detail: o.detail }) : tr("board.continue.tooltip.copy")}`
    : "";
  return `${sent}${copy}`;
}

/** What the automatic continue will do, or why it will not, while the stop is
 *  on the card. Empty when the setting is off. */
export function autoSentence({ auto, kind, held, tried }: { auto: boolean; kind: StopKind; held: boolean; tried: boolean }, tr: TFunction = t): string {
  if (!auto || (kind !== "login" && kind !== "usage-limit")) return "";
  if (held) return tr("board.continue.auto.held");
  if (tried) return "";
  return tr("board.continue.auto.will");
}

/** The panel's instruction for a session ccdeck cannot type into. */
export function interactiveSentence(kind: StopKind, tr: TFunction = t): string {
  return tr(kind === "login" ? "board.continue.interactive.login"
    : kind === "usage-limit" ? "board.continue.interactive.limit" : "board.continue.interactive.plain");
}

/** The commands a background continue runs, for somebody who would rather
 *  run them: the stop only while its process is alive. */
export function continueCommands(jobId: string, sessionId: string): string {
  return [`claude stop ${jobId}`, `claude --resume ${sessionId} --bg "${CONTINUE_PROMPT}"`].join("\n");
}
