import { adoptCwd, adoptRootLabel, ensureRoot } from "./agent-attribution";
import type { GraphState } from "./graph-state";
import { applyUsageObserved, stampSessionFacts } from "./transcript-events";
import { applyTurnEnd } from "./session-lifecycle";
import { shortPreview } from "./tool-calls";
import type { HookPayload } from "./types";

export function recoverSession(state: GraphState, p: HookPayload, now: number): void {
  const id = p.session_id;
  if ((p.provider !== "codex" && p.provider !== "claude") || typeof id !== "string" || !id) return;
  const existing = state.agents.get(id);
  if (existing?.provider && existing.provider !== p.provider) return;
  // A real event received during the disk read is newer than the snapshot.
  if (existing && Number.isFinite(p.snapshot_observed_at) && (existing.recoveryLiveAt ?? existing.lastEventAt ?? 0) >= p.snapshot_observed_at) return;
  if (p.recovery_active === false) {
    if (existing) {
      applyTurnEnd(state, p.recovery_session_closed === true ? "SessionEnd" : "Stop", id, now);
      existing.restoredFromLog = undefined;
    }
    return;
  }
  const root = ensureRoot(state, id, now, true);
  root.recoveryLiveAt ??= existing?.lastEventAt ?? 0;
  root.provider = p.provider;
  root.state = "active";
  root.endedAt = root.closedAt = root.exitAt = undefined;
  root.reaped = false;
  root.restoredFromLog = true;
  root.lastEventAt = now;
  adoptCwd(root, p); adoptRootLabel(root, p);
  if (typeof p.model === "string" && p.model) root.model = p.model;
  if (!existing && Number.isFinite(p.turn_started_at) && p.turn_started_at <= now) root.startedAt = p.turn_started_at;
  if (typeof p.prompt === "string" && p.prompt) {
    if (root.prompts.at(-1)?.text !== p.prompt) root.prompts.push({ at: now, text: p.prompt });
    if (!root.firstPrompt) root.firstPrompt = shortPreview(p.prompt, 120);
  }
  stampSessionFacts(state, p, id);
  applyUsageObserved(state, p, id);
}
