// The words for a turn that stopped on an error — the card's row, its note, the
// session list's line, the small face and the card's accessible name — so all
// of them say one thing about one stop. What the stop IS is
// src/server/stop-failure.mjs's; this is only how the page words it.
//
// WHAT TO DO IS PART OF EVERY ONE, because it is the part Claude Code does not
// do by itself. A running session picks up a working login on its own, seconds
// after one is active again; the turn that failed is not run again until
// somebody types "continue" in that session. A BACKGROUND session (`claude
// --bg`, agent view) is the exception the deck can act on (#2193): nobody is
// watching its terminal, and the card's Continue runs the turn again through
// Claude Code's own commands (src/server/stop-continue.mjs), so its words say
// to press that instead.
import type { StopFacts, StopKind } from "../server/stop-failure.mjs";

/** "login expired", "usage limit", "API error" — after "Stopped ·". */
export function stopLabel(kind: StopKind): string {
  switch (kind) {
    case "login": return "login expired";
    case "usage-limit": return "usage limit";
    default: return "API error";
  }
}

/** The card's row and the small face's long line: "Stopped · login expired". */
export function stopRowLabel(stop: StopFacts): string {
  return `Stopped · ${stopLabel(stop.kind)}`;
}

/** The small face's word or two: "Login expired", "Usage limit", "API error". */
export function stopShortLabel(stop: StopFacts): string {
  const label = stopLabel(stop.kind);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** What to do about it, as one sentence: press Continue for a background
 *  session, type "continue" in any other. */
export function stopAdvice(kind: StopKind, background = false): string {
  if (background) {
    switch (kind) {
      case "login": return "Press Continue once a working login is active.";
      case "usage-limit": return "Press Continue once the limit resets or another account is active.";
      default: return "Press Continue to run the turn again.";
    }
  }
  switch (kind) {
    case "login": return "Type “continue” in this session once a working login is active.";
    case "usage-limit": return "Type “continue” in this session once the limit resets or another account is active.";
    default: return "Type “continue” in this session to run the turn again.";
  }
}

/** What happened, in a sentence: the error by name, and Claude Code's own
 *  value for an API error, which the label alone does not carry. */
function stopWhat(stop: StopFacts): string {
  switch (stop.kind) {
    case "login": return "Claude Code stopped this turn: the login expired.";
    case "usage-limit": return "Claude Code stopped this turn: a usage limit was reached.";
    default: return `Claude Code stopped this turn on an API error (${stop.error.replace(/_/g, " ")}).`;
  }
}

/** The line Claude Code printed, quoted, when it printed one. */
function stopSaid(stop: StopFacts): string {
  return stop.message ? `It said: “${stop.message}”` : "";
}

/** The card row's tooltip: what happened, what Claude Code said, what to do. */
export function stopTooltip(stop: StopFacts, background = false): string {
  return [stopWhat(stop), stopSaid(stop), stopAdvice(stop.kind, background)].filter(Boolean).join("\n");
}

/** The session's note: "Login expired. Type “continue” in this session once a
 *  working login is active." */
export function stopNoteText(stop: StopFacts, background = false): string {
  return `${stopShortLabel(stop)}. ${stopAdvice(stop.kind, background)}`;
}

/** Who wrote the note, for its tooltip: the hook, and the line it carried. */
export function stopNoteSource(stop: StopFacts | undefined): string {
  const said = stop?.message ? `: “${stop.message}”` : "";
  return `Claude Code's StopFailure hook${said}`;
}

/** The card's accessible name gets this, where a reader on the node hears it:
 *  one clause among the name's others, so no full stop inside it. */
export function stopSpoken(stop: StopFacts, background = false): string {
  const advice = stopAdvice(stop.kind, background).replace(/\.$/, "");
  return `stopped, ${stopLabel(stop.kind)} — ${advice.charAt(0).toLowerCase()}${advice.slice(1)}`;
}
