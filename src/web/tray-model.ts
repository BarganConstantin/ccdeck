// What the desktop app's tray icon shows (#1160), worked out by the page's own
// code rather than a copy of it.
//
// The waiting count exists only in the page: the reducer decides when a
// session is blocked on a human and when that block clears, with rules about
// subagent attribution and stale sessions that took several issues to get
// right (#348, #361, #377, #968). A second implementation on the server or in
// the app would drift from them, and a tray that disagreed with the topbar chip
// would be worse than no tray. So the app runs this module — bundled for node
// by desktop/vite.tray.config.mjs — over the same `/events` stream the page
// reads, with the same reducer, the same sweep, the same caps and the same
// ambient rule as the favicon.
//
// Pure and DOM-free, like everything it imports, so the suite drives it too.
import { applyEvent, initialState, pruneDoneSessions, pruneOldAgents, STALE_SESSION_MS, sweepStaleSessions, sweepStaleTools } from "./reducer";
import type { GraphState } from "./reducer";
import { blockedSessions, runningSessionCount } from "./ambient-counts";
import { ambientSignal } from "./ambient";
import type { AmbientIcon } from "./ambient";
import { AGENT_CAP, AGENT_GRACE_MS, DONE_SESSION_CAP, DONE_SESSION_GRACE_MS } from "./board-limits";
import type { HookEnvelope, WaitingBlock } from "./types";

export interface TrayBlocked {
  id: string;
  label: string;
  kind: WaitingBlock["kind"];
  since: number;
}

export interface TraySnapshot {
  /** The favicon's mark: offline, waiting, running or idle. */
  icon: AmbientIcon;
  /** Sessions blocked on a human — the topbar chip's number. */
  waiting: number;
  /** Sessions with an agent still working. */
  running: number;
  /** The tab title the page would wear, `(2) ccdeck` or `ccdeck`. */
  title: string;
  /** Longest-blocked first, as the chip lists them. */
  blocked: TrayBlocked[];
}

export interface TrayModel {
  /** Start over — a new connection replays the ring from the beginning. */
  reset(): void;
  apply(env: HookEnvelope): void;
  setConnected(connected: boolean): void;
  /** The page's once-a-second housekeeping: stale tools and sessions swept,
   *  old agents and finished sessions evicted. Never tells the server to forget
   *  anything — the page does that, and a viewer must not. */
  tick(now?: number): void;
  snapshot(): TraySnapshot;
}

export function createTrayModel(): TrayModel {
  let state: GraphState = initialState();
  let connected = false;
  return {
    reset() { state = initialState(); },
    apply(env) { state = applyEvent(state, env); },
    setConnected(v) { connected = v; },
    tick(now = Date.now()) {
      sweepStaleTools(state, now, STALE_SESSION_MS);
      sweepStaleSessions(state, now, STALE_SESSION_MS);
      pruneOldAgents(state, now, AGENT_CAP, AGENT_GRACE_MS);
      pruneDoneSessions(state, now, DONE_SESSION_CAP, DONE_SESSION_GRACE_MS);
    },
    snapshot() {
      const blocked = blockedSessions(state.agents.values());
      const running = runningSessionCount(state.agents.values());
      const signal = ambientSignal({ waiting: blocked.length, running, connected });
      return {
        icon: signal.icon,
        waiting: blocked.length,
        running,
        title: signal.title,
        blocked: blocked.map(b => ({ id: b.id, label: b.label, kind: b.waiting.kind, since: b.waiting.since })),
      };
    },
  };
}
