// The server owns durable write receipts; this store also keeps drafts across mounts.
import { useEffect, useState } from "react";
import { IntegrationFailure, jiraGuardOperation, type JiraGuardOperation } from "./integrations/client";
import type { JiraApi } from "./jira-api";

type State = { busy: boolean; uncertain: boolean; error: string; draft: string; operation?: JiraGuardOperation; loading?: boolean };
const empty: State = { busy: false, uncertain: false, error: "", draft: "" };
const states = new Map<string, State>();
const listeners = new Map<string, Set<(state: State) => void>>();
const revisions = new Map<string, number>();

export function definiteJiraWriteFailure(error: unknown): error is IntegrationFailure {
  if (!(error instanceof IntegrationFailure) || error.operation) return false;
  if (["invalid", "permission", "expired", "auth", "not-found", "rate-limit"].includes(error.kind)) return true;
  return error.status != null && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 409;
}
function update(key: string, patch: Partial<State>) {
  if (Object.keys(patch).some(k => k !== "draft")) revisions.set(key, (revisions.get(key) ?? 0) + 1);
  const state = { ...(states.get(key) ?? empty), ...patch };
  states.set(key, state);
  for (const notify of listeners.get(key) ?? []) notify(state);
}
export function useJiraWriteState(connectionId: string, issueKey: string, kind: "comment" | "transition" | "move", api?: JiraApi) {
  const key = JSON.stringify([connectionId, issueKey, kind]);
  const [view, setView] = useState(() => ({ key, state: states.get(key) ?? (api ? { ...empty, loading: true } : empty) }));
  const matches = (op: JiraGuardOperation) => op.connectionId === connectionId && op.kind === (kind === "transition" ? "status" : kind) && (kind === "move" || op.issueKey === issueKey);
  const refresh = async () => {
    if (!api) return;
    const revision = revisions.get(key) ?? 0;
    try {
      const res = await api("write-guard", { cache: "no-store" });
      if (!res.ok) throw new Error();
      const body = await res.json();
      if (!Array.isArray(body.operations)) throw new Error();
      const op = body.operations.map(jiraGuardOperation).find((item: JiraGuardOperation | undefined) => item && matches(item));
      if ((revisions.get(key) ?? 0) !== revision) return;
      const current = states.get(key) ?? empty;
      if (current.busy) return;
      update(key, { loading: false, operation: op, uncertain: !!op || current.uncertain, ...(op && kind === "move" && !current.draft ? { draft: `${op.issueKeys?.join(", ")} · Board ${op.boardId}` } : {}), ...(op ? { error: op.state === "pending" ? "Jira is still processing this write. Wait before checking again." : "Check Jira before trying again." } : {}) });
    } catch {
      if ((revisions.get(key) ?? 0) === revision) update(key, { loading: false, uncertain: true, error: "Could not check Jira write safety. Try again before writing." });
    }
  };
  useEffect(() => {
    const notify = (state: State) => setView({ key, state });
    let active = listeners.get(key);
    if (!active) listeners.set(key, active = new Set());
    active.add(notify);
    if (api && !(states.get(key)?.busy)) update(key, { loading: true });
    notify(states.get(key) ?? empty);
    if (api) { void refresh(); }
    const timer = api ? setInterval(() => { void refresh(); }, 3000) : undefined;
    return () => { if (timer) clearInterval(timer); active!.delete(notify); if (!active!.size) listeners.delete(key); };
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
    async acknowledge(operationId?: string) {
      if (!api) { update(key, { uncertain: false, error: "" }); return true; }
      const current = states.get(key) ?? empty;
      const id = operationId ?? current.operation?.operationId;
      if (current.operation?.state === "pending") { void refresh(); return false; }
      try {
        if (id) {
          const res = await api("write-guard/acknowledge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operationId: id }) });
          if (!res.ok) throw new Error();
        } else {
          const res = await api("write-guard", { cache: "no-store" });
          if (!res.ok) throw new Error();
          const body = await res.json();
          if (!Array.isArray(body.operations) || body.operations.map(jiraGuardOperation).some((op: JiraGuardOperation | undefined) => op && matches(op))) throw new Error();
        }
        update(key, { uncertain: false, error: "", operation: undefined }); return true;
      } catch { update(key, { uncertain: true, error: "Could not clear the Jira write guard. Check Jira and try again." }); void refresh(); return false; }
    },
  };
}
