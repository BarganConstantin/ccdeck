// A session started from the Command Panel, as the board knows it.
//
// The stage launches a session under a key (use-stage.ts) and learns its id
// from the launch's answer — or, for a Codex, which picks its own, once the
// deck has recognised it on the board (codex-launch.ts). The launch is noted
// here, on the session's root card (`panelLaunch`), and kept there for the
// session's life. Two things read it:
//
//   - visibility.ts. A session whose first turn ended inside three seconds
//     having done nothing is a ghost the board hides. One the reader has just
//     started from the panel is not, whatever its first turn did — a Codex
//     asked one word answers in under a second with no tool. Until it ends
//     (`closedAt`): from then on the ordinary rule holds, as it does for every
//     session the panel did not start.
//   - stage-board.ts. On Windows, a session this deck launched and cannot
//     reach is said to be that, not one started outside the deck.
//
// A launch known before its card — a new Claude asks its folder's trust
// question before any hook fires — waits in `panelLaunches` until the card is
// made (adoptPanelLaunch, which the reducer calls as it makes one).
import { rootAgentId, type GraphState } from "./graph-state";

/** How many launches may wait for their card at once: a tab starts a few. */
export const PANEL_LAUNCHES_MAX = 32;

/** The launch `key` started session `sessionId`. */
export function notePanelLaunch(state: GraphState, sessionId: string, key: string): void {
  if (!sessionId || !key) return;
  const root = state.agents.get(rootAgentId(sessionId));
  if (root) {
    if (root.panelLaunch === key) return;
    root.panelLaunch = key;
    state.revision += 1;
    return;
  }
  state.panelLaunches.delete(sessionId);
  state.panelLaunches.set(sessionId, key);
  while (state.panelLaunches.size > PANEL_LAUNCHES_MAX) {
    const oldest = state.panelLaunches.keys().next().value;
    if (oldest === undefined) break;
    state.panelLaunches.delete(oldest);
  }
}

/** The session's card exists now: it takes the launch that waited for it. */
export function adoptPanelLaunch(state: GraphState, sessionId: string): void {
  const key = state.panelLaunches.get(sessionId);
  const root = key === undefined ? undefined : state.agents.get(rootAgentId(sessionId));
  if (!root) return;
  state.panelLaunches.delete(sessionId);
  root.panelLaunch = key;
}
