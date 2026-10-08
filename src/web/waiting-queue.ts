// The waiting queue on the topbar: who is waiting on you, by name, beside the
// count. The rules here are the ones a bare-node suite has to be able to call
// — how many names a width holds, and what each one says to the eye and to a
// screen reader — so they live outside the component that draws them
// (components/TopbarReadouts.tsx).
//
// THE ORDER IS W'S. The names come in the order blockedSessions() returns,
// longest wait first, which is the order the count's click and the W key walk
// (nextWaiting, #825): a click on a name puts W's cursor on it, so the next W
// goes to the name after it.
import type { WaitingBlock } from "./types";
import { blockedToolTooltip, waitingSentence } from "./agent-copy";

/**
 * How many names the queue's room holds, from the left: the most names whose
 * widths, the gaps between them and — when any are left over — the gap and the
 * "+N more" after them all fit. None at all when not even the first fits: the
 * count beside the queue already says how many, and goes to the first.
 */
export function namesThatFit({ widths, room, gap, more }: {
  /** Each name's whole width, in the queue's order. */
  widths: readonly number[];
  /** The width the queue may use. */
  room: number;
  /** The space between two entries. */
  gap: number;
  /** The "+N more" button's width, at its widest. */
  more: number;
}): number {
  let used = 0;
  let fit = 0;
  for (let i = 0; i < widths.length; i++) {
    used += (i > 0 ? gap : 0) + widths[i];
    const rest = i + 1 < widths.length ? gap + more : 0;
    if (used + rest > room) break;
    fit = i + 1;
  }
  return fit;
}

/** What a queued session is stopped on, in a word: the tool the prompt is
 *  most likely about — the session list's row prints the same name — and
 *  otherwise the kind of stop. */
export function waitWhat(waiting: WaitingBlock): string {
  if (waiting.tool) return waiting.tool.name;
  return waiting.kind === "asked" ? "question" : "permission";
}

/** The longest a name stands on the bar, in characters, before its middle
 *  gives way: inside the 160px `.we-name` allows at 12px and 600 with room to
 *  spare, so the box's own end-ellipsis is a backstop for a run of wide
 *  letters and never cuts a name already cut in the middle (24 did, measured:
 *  "checkout-servi…on-work…"). */
export const QUEUE_NAME_CHARS = 20;

/** A session's name short enough for the bar, cut in the MIDDLE: folder names
 *  share their beginnings far more often than their ends ("checkout-service-
 *  payments-…-worker", "checkout-service-payments-…-api"), and an ellipsis at
 *  the end cut exactly the part that told two of them apart. The hint and the
 *  accessible name keep it whole. */
export function queueName(label: string, max: number = QUEUE_NAME_CHARS): string {
  if (label.length <= max) return label;
  const tail = Math.floor((max - 1) * 0.4);
  const head = max - 1 - tail;
  return `${label.slice(0, head)}…${label.slice(label.length - tail)}`;
}

/** A wait in words, for the ear: "less than a minute", "6 minutes",
 *  "1 hour 5 minutes". The eye gets the session list's "6m". */
export function spokenWait(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "less than a minute";
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (minutes < 60) return plural(minutes, "minute");
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? plural(h, "hour") : `${plural(h, "hour")} ${plural(m, "minute")}`;
}

/** A queued session's accessible name: who, how long, on what, and what a
 *  press does — "web-api, waiting 6 minutes on Bash; go to session". The
 *  count's own region already says how many are waiting, so nothing here
 *  speaks on its own. */
export function queueEntryName(label: string, waiting: WaitingBlock, waitedMs: number): string {
  const on = waiting.tool
    ? `on ${waiting.tool.name}`
    : waiting.kind === "asked" ? "for an answer" : "for permission";
  return `${label}, waiting ${spokenWait(waitedMs)} ${on}; go to session`;
}

/** What a queued session's hint adds under its whole name: Claude Code's own
 *  sentence, and the tool the deck inferred, hedged as the guess it is. */
export function queueEntryDetail(waiting: WaitingBlock): string {
  const said = waitingSentence(waiting);
  const guess = blockedToolTooltip(waiting, said);
  return guess ? `${said}\n${guess}` : said;
}
