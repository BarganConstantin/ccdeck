// Write ownership outlives a mounted issue detail. A lost response must remain
// visible and must not allow a second write after navigating away and back.
import { useEffect, useState } from "react";
import { IntegrationFailure } from "./integrations/client";

type State = { busy: boolean; uncertain: boolean; error: string; draft: string };
const empty: State = { busy: false, uncertain: false, error: "", draft: "" };
const states = new Map<string, State>();
const listeners = new Map<string, Set<(state: State) => void>>();

export function definiteJiraWriteFailure(error: unknown): error is IntegrationFailure {
  if (!(error instanceof IntegrationFailure)) return false;
  if (["invalid", "permission", "expired", "auth", "not-found", "rate-limit"].includes(error.kind)) return true;
  return error.status != null && error.status >= 400 && error.status < 500 && error.status !== 408;
}

function update(key: string, patch: Partial<State>) {
  const state = { ...(states.get(key) ?? empty), ...patch };
  if (!state.busy && !state.uncertain && !state.error && !state.draft) states.delete(key);
  else states.set(key, state);
  for (const notify of listeners.get(key) ?? []) notify(state);
}

export function useJiraWriteState(connectionId: string, issueKey: string, kind: "comment" | "transition" | "move") {
  const key = JSON.stringify([connectionId, issueKey, kind]);
  const [view, setView] = useState(() => ({ key, state: states.get(key) ?? empty }));
  useEffect(() => {
    const notify = (state: State) => setView({ key, state });
    let active = listeners.get(key);
    if (!active) listeners.set(key, active = new Set());
    active.add(notify);
    notify(states.get(key) ?? empty);
    return () => { active!.delete(notify); if (!active!.size) listeners.delete(key); };
  }, [key]);
  const state = view.key === key ? view.state : states.get(key) ?? empty;
  return {
    state,
    begin(draft = "") {
      const current = states.get(key) ?? empty;
      if (current.busy || current.uncertain) return false;
      update(key, { busy: true, uncertain: false, error: "", draft });
      return true;
    },
    update: (patch: Partial<State>) => update(key, patch),
  };
}
