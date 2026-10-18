// Finished sessions leaving the board on their own, after a delay the reader
// picks in Settings › General (#2156).
//
// A finished session used to stay on the canvas until more than six had
// finished (pruneDoneSessions, board-sweeps.ts), so a day with three or four
// sessions kept every one of them there for good. A user asked for "auto-close
// done sessions after a delay".
//
// HIDDEN, NOT DELETED. Hiding is Remove from board's (remove-node.ts): the
// session keeps its row in the session list (L), comes back from there, and
// comes back by itself when it starts working or needs you (#1315). Nothing is
// forgotten by the page or by the server, so a session hidden too early costs
// one click, never its history.
//
// NEVER BY DEFAULT, so nobody's board changes until they ask for it.
//
// FROM THE END OF THE LAST TURN, for a session whose every agent is done: the
// root's `endedAt` is written by `Stop`, which Claude Code fires each time it
// finishes responding, and by `SessionEnd`, and by the stale reap
// (board-sweeps.ts). A session working or blocked on a person is never hidden,
// and neither is the one the reader has selected. A session waiting with an
// empty input box (`idle`) is a turn that ended, and is hidden like one.
//
// ONCE PER TURN. A session the reader brings back is not hidden again by the
// same finished turn — only by the end of a later one. The turns already acted
// on are kept with the removals, so a reload does not undo a bring-back.
import { isAlarming } from "./ambient-counts";
import type { AgentNodeData } from "./types";
import { readStored, writeStored } from "./storage";

/** The delays on offer, in minutes; 0 is Never. */
export const HIDE_FINISHED_CHOICES = [0, 5, 15, 30, 60] as const;

/** Where the delay is kept, in minutes. */
export const HIDE_FINISHED_KEY = "agent-dag.hide-finished-after";

/** Where the turns already hidden or brought back are kept: session id → the
 *  `endedAt` of the turn. */
export const HANDLED_TURNS_KEY = "agent-dag.hide-finished-turns";

/** How many of those are kept. A session pruned from the board never returns
 *  with the same `endedAt`, so the oldest can go. */
export const HANDLED_TURNS_CAP = 300;

/** How often the board is looked over. A minute's precision is plenty for a
 *  delay counted in minutes. */
export const HIDE_CHECK_MS = 10_000;

/** The delay as stored: one of the choices, Never for anything else. */
export function resolveHideFinishedAfter(stored: string | null | undefined): number {
  const minutes = Number(stored);
  return (HIDE_FINISHED_CHOICES as readonly number[]).includes(minutes) ? minutes : 0;
}

/** What the picker says for a choice. */
export function hideFinishedLabel(minutes: number): string {
  return minutes === 0 ? "Never" : `${minutes} min`;
}

let current: number | null = null;
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) listener();
}

/** The delay as it stands now, in minutes. Read once from storage, then held. */
export function hideFinishedAfter(): number {
  if (current === null) current = resolveHideFinishedAfter(readStored(HIDE_FINISHED_KEY));
  return current;
}

/** Change it: remembered for the next load, and told to every reader. */
export function setHideFinishedAfter(minutes: number): void {
  const next = resolveHideFinishedAfter(String(minutes));
  if (current === next) return;
  current = next;
  writeStored(HIDE_FINISHED_KEY, String(next));
  announce();
}

/** Another tab changed it. */
function onStorage(event: StorageEvent): void {
  if (event.key !== HIDE_FINISHED_KEY) return;
  const next = resolveHideFinishedAfter(event.newValue);
  if (next === current) return;
  current = next;
  announce();
}

/** Hear every change; returns the unsubscribe. */
export function subscribeHideFinishedAfter(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") window.addEventListener?.("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener?.("storage", onStorage);
  };
}

/** The turns already acted on, as stored. */
export function readHandledTurns(store: Pick<Storage, "getItem"> | null): Map<string, number> {
  try {
    const value = JSON.parse(store?.getItem(HANDLED_TURNS_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return new Map();
    return new Map(Object.entries(value).filter((e): e is [string, number] => typeof e[1] === "number"));
  } catch { return new Map(); }
}

/** Store them, the newest HANDLED_TURNS_CAP only. */
export function saveHandledTurns(store: Pick<Storage, "setItem"> | null, handled: ReadonlyMap<string, number>): void {
  const kept = [...handled].sort((a, b) => b[1] - a[1]).slice(0, HANDLED_TURNS_CAP);
  try { store?.setItem(HANDLED_TURNS_KEY, JSON.stringify(Object.fromEntries(kept))); } catch { /* disabled storage */ }
}

type Agent = Pick<AgentNodeData, "id" | "sessionId" | "kind" | "state" | "endedAt" | "waiting">;

/** When each finished session's last turn ended. A session counts as finished
 *  only when every agent in it is done, as pruneDoneSessions counts it, so a
 *  subagent still running keeps its session; and not while it is blocked on a
 *  person. */
export function finishedTurns(agents: Iterable<Agent>): Map<string, number> {
  const sessions = new Map<string, { endedAt: number; live: boolean }>();
  for (const a of agents) {
    let s = sessions.get(a.sessionId);
    if (!s) { s = { endedAt: 0, live: false }; sessions.set(a.sessionId, s); }
    if (a.kind === "root" && isAlarming(a.waiting)) s.live = true;
    if (a.state === "done" && a.endedAt != null) s.endedAt = Math.max(s.endedAt, a.endedAt);
    else s.live = true;
  }
  const out = new Map<string, number>();
  for (const [id, s] of sessions) if (!s.live && s.endedAt > 0) out.set(id, s.endedAt);
  return out;
}

/**
 * The sessions to hide now, with the turn each is hidden for.
 *
 * @param afterMs  the delay; 0 hides nothing
 * @param removed  what is already off the board
 * @param handled  the turns already hidden or brought back
 * @param keep     the sessions the reader is looking at, which stay: the
 *                 selected card's, and the one on the terminal stage
 */
export function sessionsToHide(agents: Iterable<Agent>, { afterMs, now, removed, handled, keep }: {
  afterMs: number;
  now: number;
  removed: ReadonlySet<string>;
  handled: ReadonlyMap<string, number>;
  keep?: string | null | readonly (string | null)[];
}): { id: string; endedAt: number }[] {
  if (afterMs <= 0) return [];
  const kept: readonly (string | null | undefined)[] = Array.isArray(keep) ? keep : [keep as string | null | undefined];
  const due: { id: string; endedAt: number }[] = [];
  for (const [id, endedAt] of finishedTurns(agents)) {
    if (now - endedAt < afterMs) continue;
    if (removed.has(id) || kept.includes(id)) continue;
    if (handled.get(id) === endedAt) continue;
    due.push({ id, endedAt });
  }
  return due;
}

/**
 * The sessions that have just come back onto the board — from the session list,
 * from bring back all, or by working again — marked with the turn they were
 * finished at, so that turn does not hide them a second time. The SAME map when
 * nothing came back.
 */
export function markBroughtBack(
  handled: ReadonlyMap<string, number>,
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
  agents: Iterable<Agent>,
): ReadonlyMap<string, number> {
  const back = [...before].filter(id => !after.has(id));
  if (back.length === 0) return handled;
  const finished = finishedTurns(agents);
  let next: Map<string, number> | null = null;
  for (const id of back) {
    const endedAt = finished.get(id);
    if (endedAt == null || handled.get(id) === endedAt) continue;
    next ??= new Map(handled);
    next.set(id, endedAt);
  }
  return next ?? handled;
}
