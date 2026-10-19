// The words for continuing a turn that stopped on an expired login or a usage
// limit (#2193) — the card's Continue button and the line it leaves, and the
// detail panel's section — so every surface says one thing about one continue.
// What a continue IS is src/server/stop-continue.mjs's, and when one may run is
// src/server/stop-continue-gate.mjs's; this is only how the page words them.
import type { StopKind } from "../server/stop-failure.mjs";
import type { GateReason } from "../server/stop-continue-gate.mjs";
import { CONTINUE_PROMPT } from "../server/stop-continue-gate.mjs";
import { shortAgo } from "./relative-time";

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
export function gateSentence(reason: GateReason | null): string {
  switch (reason) {
    case "before-stop": return "Not yet: nothing shows a working login since it stopped. The active account's next usage reading will.";
    case "no-room": return "Not yet: the active account has no room left in its 5-hour or 7-day window.";
    case "no-login": return "Not yet: the active account's usage could not be read, so there is no sign of a working login.";
    default: return "";
  }
}

/** A press or an automatic continue that did not run, as one sentence. */
export function refusalSentence(reason: string | null, detail = "", stopped = false): string {
  // The command's own line, without the full stop it may already end on.
  const said = detail ? `: ${detail.replace(/[.\s]+$/, "")}` : "";
  switch (reason) {
    case "interactive": return "This session runs in a terminal, so ccdeck can't continue it. Type “continue” there.";
    case "not_listed": return "Claude Code doesn't list it as a background session any more, so nothing was sent.";
    case "working": return "It's working again already, so nothing was sent.";
    case "waiting": return "It's waiting on a prompt or a dialog. Answer it in agent view or with claude attach.";
    case "not_held": return "Claude Code doesn't show it as held up, so it wasn't continued automatically.";
    case "no_dir": return "Its folder is gone, so it can't be resumed there.";
    case "unreadable": return "claude agents --json printed something ccdeck couldn't read, so nothing was sent.";
    case "cli_failed": return `claude agents --json failed${said}. Nothing was sent.`;
    case "stop_failed": return `claude stop failed${said}. Nothing was sent.`;
    case "still_running": return "Claude Code still lists its process as running after claude stop, so nothing was sent.";
    case "resume_failed": return stopped
      ? `ccdeck stopped it, then claude --resume --bg failed${said}. The conversation is kept: open it from agent view.`
      : `claude --resume --bg failed${said}.`;
    case "busy": return "A continue is already running for it.";
    // The gate refused it on the server, which words its own reason.
    case "not_ready": return detail || "Not yet: there is no sign of a working login since it stopped.";
    case "unreachable": return "ccdeck's server could not be reached.";
    default: return "ccdeck refused the request.";
  }
}

/** "Continued automatically 2m ago", "Continued 2m ago", "Continue failed 2m
 *  ago" — the card's line, and the panel's. */
export function outcomeLabel(o: ContinueOutcome, now: number): string {
  const ago = shortAgo(now - o.at);
  if (!o.ok) return `${o.auto ? "Automatic continue failed" : "Continue failed"} ${ago}`;
  const how = o.outcome === "copied" ? "Continued as a copy" : "Continued";
  return `${how}${o.auto ? " automatically" : ""} ${ago}`;
}

/** What the line's tooltip adds: what was sent, or what went wrong. */
export function outcomeTooltip(o: ContinueOutcome): string {
  if (!o.ok) return refusalSentence(o.reason, o.detail, o.stopped);
  const by = o.auto ? "ccdeck continued it automatically once a working login was active" : "Continued from ccdeck";
  const copy = o.outcome === "copied" ? `\nClaude Code started a copy instead of continuing it in place${o.detail ? `: “${o.detail}”` : "."}` : "";
  // The prompt is a sentence with its own full stop, so it ends this one.
  return `${by}. It sent: “${CONTINUE_PROMPT}”${copy}`;
}

/** What the automatic continue will do, or why it will not, while the stop is
 *  on the card. Empty when the setting is off. */
export function autoSentence({ auto, kind, held, tried }: { auto: boolean; kind: StopKind; held: boolean; tried: boolean }): string {
  if (!auto || (kind !== "login" && kind !== "usage-limit")) return "";
  if (held) return "Not continued automatically: it stopped again after the last automatic continue. Press Continue to try again.";
  if (tried) return "";
  return "Continues automatically once a working login with room is active.";
}

/** The panel's instruction for a session ccdeck cannot type into. */
export function interactiveSentence(kind: StopKind): string {
  const when = kind === "login" ? " once a working login is active"
    : kind === "usage-limit" ? " once the limit resets or another account is active" : "";
  return `This session runs in a terminal, and ccdeck can't type into it. Type “continue” there${when}.`;
}

/** The commands a background continue runs, for somebody who would rather
 *  run them: the stop only while its process is alive. */
export function continueCommands(jobId: string, sessionId: string): string {
  return [`claude stop ${jobId}`, `claude --resume ${sessionId} --bg "${CONTINUE_PROMPT}"`].join("\n");
}
