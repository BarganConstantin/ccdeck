// The server owns durable write receipts; this store also keeps drafts across mounts.
import { useEffect, useState } from "react";
import { IntegrationFailure, jiraGuardOperation, type JiraGuardOperation } from "./integrations/client";
import type { JiraApi } from "./jira-api";
import { states, listeners, revisions, type JiraWriteState as State } from "./jira-write-store";

const empty: State = { busy: false, uncertain: false, error: "", draft: "" };
let nextRevision = 0;
const acknowledgements = new Set<string>();

function prune(key: string) {
  const state = states.get(key);
  if (!listeners.has(key) && !acknowledgements.has(key) && state && !state.busy && !state.uncertain && !state.draft && !state.operation) {
    states.delete(key);
    revisions.delete(key);
  }
}

export function definiteJiraWriteFailure(error: unknown): error is IntegrationFailure {
  if (!(error instanceof IntegrationFailure) || error.operation) return false;
  if (["invalid", "permission", "expired", "auth", "not-found", "rate-limit"].includes(error.kind)) return true;
  return error.status != null && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 409;
}
function update(key: string, patch: Partial<State>) {
  const previous = states.get(key) ?? empty;
  // Finishing a move must not invalidate a concurrent acknowledgement: its
  // loading lock still prevents another write while busy becomes false.
  const changed = Object.entries(patch).some(([field, value]) => field !== "draft"
    && !(field === "busy" && value === false && acknowledgements.has(key))
    && (field === "operation" ? JSON.stringify(previous.operation) !== JSON.stringify(value)
      : previous[field as keyof State] !== value));
  if (changed) revisions.set(key, ++nextRevision);
  const state = { ...previous, ...patch };
  states.set(key, state);
  for (const notify of listeners.get(key) ?? []) notify(state);
  prune(key);
}
export function useJiraWriteState(connectionId: string, issueKey: string, kind: "comment" | "transition" | "move", api?: JiraApi) {
  const key = JSON.stringify([connectionId, issueKey, kind]);
  const [view, setView] = useState(() => ({ key, state: states.get(key) ?? (api ? { ...empty, loading: true } : empty) }));
  const matches = (op: JiraGuardOperation) => op.connectionId === connectionId && op.kind === (kind === "transition" ? "status" : kind) && (kind === "move" || op.issueKey === issueKey);
  const refresh = async (isActive = () => true) => {
    if (!api || acknowledgements.has(key)) return;
    const revision = revisions.get(key) ?? 0;
    try {
      const res = await api("write-guard", { cache: "no-store" });
      if (!res.ok) throw new Error();
      const body = await res.json();
      if (!Array.isArray(body.operations)) throw new Error();
      const op = body.operations.map(jiraGuardOperation).find((item: JiraGuardOperation | undefined) => item && matches(item));
      if (!isActive() || acknowledgements.has(key) || (revisions.get(key) ?? 0) !== revision) return;
      const current = states.get(key) ?? empty;
      if (current.busy) return;
      update(key, { loading: false, operation: op, uncertain: !!op || current.uncertain, ...(op && kind === "move" && !current.draft ? { draft: `${op.issueKeys?.join(", ")} · Board ${op.boardId}` } : {}), ...(op ? { error: op.state === "pending" ? "Jira is still processing this write. Wait before checking again." : "Check Jira before trying again." } : {}) });
    } catch {
      if (isActive() && !acknowledgements.has(key) && (revisions.get(key) ?? 0) === revision) update(key, { loading: false, uncertain: true, error: "Could not check Jira write safety. Try again before writing." });
    }
  };
  useEffect(() => {
    let mounted = true;
    const notify = (state: State) => setView({ key, state });
    let active = listeners.get(key);
    if (!active) listeners.set(key, active = new Set());
    active.add(notify);
    if (api && !(states.get(key)?.busy) && !acknowledgements.has(key)) update(key, { loading: true });
    notify(states.get(key) ?? empty);
    if (api) { void refresh(() => mounted); }
    const timer = api ? setInterval(() => { void refresh(() => mounted); }, 3000) : undefined;
    return () => { mounted = false; if (timer) clearInterval(timer); active!.delete(notify); if (!active!.size) listeners.delete(key); prune(key); };
  }, [key, api]);
  const state = view.key === key ? view.state : states.get(key) ?? (api ? { ...empty, loading: true } : empty);
  return {
    state,
    begin(draft = "") {
      const current = states.get(key) ?? (api ? { ...empty, loading: true } : empty);
      if (current.busy || current.uncertain || current.loading) return false;
      update(key, { busy: true, uncertain: false, error: "", draft });
      return true;
    },
    update: (patch: Partial<State>) => update(key, patch),
    checkpoint: () => revisions.get(key) ?? 0,
    finishMove(uncertain: boolean, draft: string, operationId?: string, checkpoint?: number) {
      const current = states.get(key) ?? empty;
      if (checkpoint !== undefined && (revisions.get(key) ?? 0) !== checkpoint) {
        update(key, { busy: false });
      } else if (operationId && current.operation && current.operation.operationId !== operationId) {
        update(key, { busy: false, uncertain: true });
      } else {
        update(key, { busy: false, uncertain, draft });
      }
    },
    async acknowledge(operationId?: string) {
      if (!api) { update(key, { uncertain: false, error: "", ...(kind === "move" ? { draft: "" } : {}) }); return true; }
      const current = states.get(key) ?? empty;
      const id = operationId ?? current.operation?.operationId;
      if (current.operation?.state === "pending") return false;
      if (acknowledgements.has(key)) return false;
      acknowledgements.add(key);
      update(key, { loading: true });
      const revision = revisions.get(key) ?? 0;
      const unchanged = () => (revisions.get(key) ?? 0) === revision;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        if (id) {
          const res = await api("write-guard/acknowledge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operationId: id }), signal: controller.signal });
          if (!res.ok && res.status !== 409) throw new Error();
        }
        const check = await api("write-guard", { cache: "no-store", signal: controller.signal });
        if (!check.ok) throw new Error();
        const body = await check.json();
        if (!Array.isArray(body.operations)) throw new Error();
        const op = body.operations.map(jiraGuardOperation).find((item: JiraGuardOperation | undefined) => item && matches(item));
        if (!unchanged()) return false;
        if (op) { update(key, { operation: op, uncertain: true, error: "Check Jira before trying again.", ...(kind === "move" && op.operationId !== id ? { draft: `${op.issueKeys?.join(", ")} · Board ${op.boardId}` } : {}) }); return false; }
        if (!unchanged()) return false;
        update(key, { uncertain: false, error: "", operation: undefined, ...(kind === "move" ? { draft: "" } : {}) }); return true;
      } catch { if (unchanged()) update(key, { uncertain: true, error: "Could not clear the Jira write guard. Check Jira and try again." }); return false; }
      finally {
        clearTimeout(timer);
        acknowledgements.delete(key);
        if (states.has(key)) update(key, { loading: false });
      }
    },
  };
}
