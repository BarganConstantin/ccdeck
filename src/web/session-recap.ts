// Whether a session's recap still describes it.
//
// The server sends the newest recap Claude Code wrote and retires it when the
// model writes the next turn (see src/server/session-recap.mjs). That leaves a
// few seconds it cannot see: a prompt reaches the deck through its hook before
// the model has written a line, and a recap that outlived the person's answer
// would describe a session that has already moved on. So the card, the session
// list and the detail panel ask this one question, and ask it the same way.
import type { AgentNodeData, SessionRecap } from "./types";

type RecapBearing = Pick<AgentNodeData, "kind" | "recap" | "prompts" | "state" | "closedAt">;

/**
 * The recap to show, or null when there is none worth showing.
 *
 * - A session root only. A recap is about the session a person comes back to.
 * - Not while a turn is running. The recap is where the LAST turn left things.
 * - Not once any prompt is newer than it, the human's or a background task's
 *   notice alike: either one starts the turn that makes it history.
 * - Not on a session that has closed — by its own SessionEnd, or by the sweep
 *   that calls a session silent for STALE_SESSION_MS over. That sweep takes the
 *   "Your turn" badge down on the same grounds, and the recap explains that
 *   badge; it does not outlive it. The arrival of a recap is itself something
 *   heard from the session, so the ninety minutes start when it lands.
 */
export function recapShown(a: RecapBearing): SessionRecap | null {
  const recap = a.recap;
  if (a.kind !== "root" || !recap) return null;
  if (a.state === "active" || a.closedAt != null) return null;
  for (const p of a.prompts) if (p.at > recap.at) return null;
  return recap;
}
