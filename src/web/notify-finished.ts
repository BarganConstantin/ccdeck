// The second thing worth telling somebody who is not looking: a session that
// FINISHED, beside the one that is blocked (notify.ts). herdr, the tool the deck
// learns from here, alerts for exactly these two, and never for the session you
// are looking at.
//
// The same discipline as the blocked notice, rule for rule: only while the
// page is hidden, once per turn end, never for history, `tag` = key so a second
// deck replaces rather than stacks, and the one switch silences both. The DOM
// half is in use-os-notifications.ts beside the blocked one.
//
// A SIBLING OF notify.ts RATHER THAN MORE OF IT, for one reason: the words of a
// finished notice are the rail's (its name, its mark, its second line), and
// rail-row-copy.ts reaches notify.ts through agent-copy.ts, so the rail's
// helpers imported into notify.ts would close a cycle. Pure and DOM-free for
// the reason notify.ts gives: the suite calls exactly what ships.
import { isAlarming } from "./ambient-counts";
import { t, type TFunction } from "./i18n";
import { sessionMark } from "./node-face";
import type { BlockNotice } from "./notify";
import { namesLine, sameWords, sessionNames } from "./rail-row-copy";
import { turnEndedAt } from "./session-seen";
import type { AgentNodeData } from "./types";

/** What a finished notice reads off its session's root. */
export type FinishedFacts = Pick<
  AgentNodeData,
  "kind" | "state" | "stopFailure" | "toolErrorCount" | "label" | "cwdBasename" | "sessionName" | "sessionTitle" | "prompts" | "firstPrompt"
>;

/** A session whose latest turn has ended. */
export interface FinishedTurn {
  /** The session, which is what a click lands on. */
  id: string;
  /** The title, as the blocked notice names the session (ambient-counts.ts). */
  label: string;
  /** When the turn ended: session-seen.ts `turnEndedAt`, the moment the rail's
   *  Done · new is keyed on. */
  endedAt: number;
  /** When it began: the newest prompt, as SessionList.tsx buildRows reads it. */
  startedAt: number;
  /** The identity and the `tag`: see `finishedKey`. */
  key: string;
  /** Why it is not said, or null when it may be. "job": a background job still
   *  at work, which the rail draws as Working; said once the job settles.
   *  "block": a permission prompt or a question on it, which the blocked notice
   *  speaks for, so this turn's end is never said as well. */
  held: "job" | "block" | null;
  facts: FinishedFacts;
}

/** The turns already told, by session: the key said and when that turn began.
 *  One entry per session at most, and only while its turn is the latest. */
export type FinishedTold = ReadonlyMap<string, { key: string; startedAt: number }>;

/** The session and the moment its turn ended, as blockKey is for a block. The
 *  `#done` keeps it apart from a block's key, which is a tag in the same tray. */
export function finishedKey(sessionId: string, endedAt: number): string {
  return `${sessionId}#done@${endedAt}`;
}

/**
 * Every session whose latest turn has ended, as far as a notice cares.
 *
 * Roots only. Left out, never said and never held: a session never given a
 * prompt (the facts node-face.ts `neverPrompted` reads, without the state and
 * the block a turn end changes, so an idle prompt on an untouched session is
 * not a finished turn), and a session that is over — `closedAt`, which
 * SessionEnd writes, and the stale sweep writes for a session it gave up on
 * after 90 minutes of silence. Quitting a terminal, or the deck's guess that it
 * was quit, is not a turn that finished.
 */
export function finishedTurns(agents: Iterable<AgentNodeData>): FinishedTurn[] {
  const out: FinishedTurn[] = [];
  for (const a of agents) {
    if (a.kind !== "root") continue;
    const endedAt = turnEndedAt(a);
    if (endedAt == null) continue;
    if (a.prompts.length === 0 && a.toolCount === 0) continue;
    if (a.closedAt != null) continue;
    // The rail's own reading (SessionList.tsx rank): a block on you outranks
    // everything, and a job still going is Working though its turn has ended.
    const held = isAlarming(a.waiting) ? "block"
      : a.job && (a.job.state === "working" || a.job.state === "blocked") ? "job"
      : null;
    out.push({
      id: a.sessionId, label: a.label, endedAt,
      startedAt: a.prompts.at(-1)?.at ?? a.startedAt,
      key: finishedKey(a.sessionId, endedAt), held, facts: a,
    });
  }
  return out;
}

/**
 * The body: the state word, then what the session was doing.
 *
 * The word is the one its row and its card wear (node-face.ts sessionMark):
 * Done; "Done · 1 failed" for a turn whose calls failed, which the rail and the
 * Inspector print the same way; Failed for a turn that stopped on an error.
 * The second line is the rail row's own (rail-row-copy.ts namesLine), less a
 * folder the title above it already says.
 */
export function finishedBody(a: FinishedFacts, tr: TFunction = t): string {
  const mark = sessionMark(a);
  const word = mark === "err" ? tr("board.card.stateFailed")
    : mark === "partial" ? `${tr("board.card.stateDone")} · ${tr("board.failedCount", { n: a.toolErrorCount ?? 0 })}`
    : tr("board.card.stateDone");
  const names = sessionNames(a);
  const folder = names.folder && !sameWords(names.folder, a.label) ? names.folder : undefined;
  const line = namesLine({ ...names, folder });
  return line ? `${word}\n${line}` : word;
}

/**
 * Whether this turn has been said: its own key, or the same turn under a later
 * end.
 *
 * THE SECOND HALF IS WHAT STOPS A RESTART BURST. The reducer stamps the end
 * again without a new turn: a deck that restarts reads every running Claude
 * session back from disk, and one it finds idle is ended again at that moment
 * (session-recovery.ts → applyTurnEnd), as is a second Stop with no prompt
 * between. Keyed on the end alone, a deck left open in a hidden tab across an
 * update would say "Done" once for every idle session on the machine. A turn
 * that began at the same prompt is the turn already told.
 */
function alreadyTold(f: FinishedTurn, told: FinishedTold): boolean {
  const was = told.get(f.id);
  return was != null && (was.key === f.key || was.startedAt === f.startedAt);
}

/**
 * The finished turns that deserve a notification now: the blocked notice's
 * gates (notify.ts noticesFor), in its order. The mute first, then not while
 * the page is visible, then once per turn; and never for a turn `held`.
 */
export function finishedNoticesFor(
  turns: readonly FinishedTurn[],
  told: FinishedTold,
  pageVisible: boolean,
  on = true,
): BlockNotice[] {
  if (!on) return [];
  if (pageVisible) return [];
  const out: BlockNotice[] = [];
  for (const f of turns) {
    if (f.held || alreadyTold(f, told)) continue;
    out.push({ key: f.key, title: f.label, body: finishedBody(f.facts), sessionId: f.id });
  }
  return out;
}

/**
 * What is told after a hidden page's pass, as notify.ts nextRaised is for
 * blocks: what was just raised, what the blocked notice spoke for, and what was
 * told before and is still the session's latest turn. A session that is
 * working again, closed or gone is forgotten, which is what keeps this as long
 * as the board and no longer; forgetting is safe because its next turn ends at
 * a new moment from a new prompt.
 */
export function nextFinishedTold(
  turns: readonly FinishedTurn[],
  justRaised: readonly BlockNotice[],
  told: FinishedTold,
): Map<string, { key: string; startedAt: number }> {
  const raised = new Set(justRaised.map(n => n.key));
  const next = new Map<string, { key: string; startedAt: number }>();
  for (const f of turns) {
    if (raised.has(f.key) || f.held === "block" || alreadyTold(f, told)) next.set(f.id, { key: f.key, startedAt: f.startedAt });
  }
  return next;
}

/**
 * The world as found, adopted as told: every seed notify.ts seedRaised makes
 * (mount, the permission answered, the first replay's end, the switch turned
 * on) and a visible page's pass. Everything on screen as Done is history.
 *
 * A background job still at work is not adopted: the board draws it as
 * Working, so its settling later is news. Unless it was told already, which
 * `told` keeps.
 */
export function seedFinishedTold(
  turns: readonly FinishedTurn[],
  told: FinishedTold = new Map(),
): Map<string, { key: string; startedAt: number }> {
  const next = new Map<string, { key: string; startedAt: number }>();
  for (const f of turns) {
    if (f.held !== "job" || alreadyTold(f, told)) next.set(f.id, { key: f.key, startedAt: f.startedAt });
  }
  return next;
}
