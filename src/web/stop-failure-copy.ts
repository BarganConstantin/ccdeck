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
import { t, type TFunction } from "./i18n";

/** "login expired", "usage limit", "API error" — after "Stopped ·". */
export function stopLabel(kind: StopKind, tr: TFunction = t): string {
  switch (kind) {
    case "login": return tr("board.stop.label.login");
    case "usage-limit": return tr("board.stop.label.limit");
    default: return tr("board.stop.label.api");
  }
}

/** The card's row and the small face's long line: "Stopped · login expired". */
export function stopRowLabel(stop: StopFacts, tr: TFunction = t): string {
  return tr("board.stop.row", { label: stopLabel(stop.kind, tr) });
}

/** The small face's word or two: "Login expired", "Usage limit", "API error". */
export function stopShortLabel(stop: StopFacts, tr: TFunction = t): string {
  switch (stop.kind) {
    case "login": return tr("board.stop.short.login");
    case "usage-limit": return tr("board.stop.short.limit");
    default: return tr("board.stop.short.api");
  }
}

/** What to do about it, as one sentence: press Continue for a background
 *  session, type "continue" in any other. */
export function stopAdvice(kind: StopKind, background = false, tr: TFunction = t): string {
  const way = background ? "press" : "type";
  switch (kind) {
    case "login": return tr(`board.stop.advice.${way}.login`);
    case "usage-limit": return tr(`board.stop.advice.${way}.limit`);
    default: return tr(`board.stop.advice.${way}.api`);
  }
}

/** What happened, in a sentence: the error by name, and Claude Code's own
 *  value for an API error, which the label alone does not carry. */
function stopWhat(stop: StopFacts, tr: TFunction): string {
  switch (stop.kind) {
    case "login": return tr("board.stop.what.login");
    case "usage-limit": return tr("board.stop.what.limit");
    default: return tr("board.stop.what.api", { error: stop.error.replace(/_/g, " ") });
  }
}

/** The line Claude Code printed, quoted, when it printed one. */
function stopSaid(stop: StopFacts, tr: TFunction): string {
  return stop.message ? tr("board.stop.said", { message: stop.message }) : "";
}

/** The card row's tooltip: what happened, what Claude Code said, what to do. */
export function stopTooltip(stop: StopFacts, background = false, tr: TFunction = t): string {
  return [stopWhat(stop, tr), stopSaid(stop, tr), stopAdvice(stop.kind, background, tr)].filter(Boolean).join("\n");
}

/** The session's note: "Login expired. Type “continue” in this session once a
 *  working login is active." */
export function stopNoteText(stop: StopFacts, background = false, tr: TFunction = t): string {
  return tr("board.stop.note", { label: stopShortLabel(stop, tr), advice: stopAdvice(stop.kind, background, tr) });
}

/** Who wrote the note, for its tooltip: the hook, and the line it carried. */
export function stopNoteSource(stop: StopFacts | undefined, tr: TFunction = t): string {
  return stop?.message ? tr("board.stop.source.said", { message: stop.message }) : tr("board.stop.source");
}

/** The card's accessible name gets this, where a reader on the node hears it:
 *  one clause among the name's others, so no full stop inside it. */
export function stopSpoken(stop: StopFacts, background = false, tr: TFunction = t): string {
  const advice = stopAdvice(stop.kind, background, tr).replace(/[.。]$/, "");
  return tr("board.stop.spoken", { label: stopLabel(stop.kind, tr), advice: `${advice.charAt(0).toLowerCase()}${advice.slice(1)}` });
}
