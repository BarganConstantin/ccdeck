import { useEffect, useRef, useState } from "react";
import type { JiraApi } from "../jira-api";
import { failureOf, readThrough, IntegrationFailure } from "../integrations/client";
import { definiteJiraWriteFailure, useJiraWriteState } from "../jira-write-state";
import { selfPressAccepted, selfPressProps } from "../panel-press";

type Transition = { id: string; name: string; to: string; requiresScreen: boolean };

/** Only Jira's currently available workflow actions are offered. */
export default function JiraTransition({ api, connectionId, issueKey, onChanged }: { api: JiraApi; connectionId: string; issueKey: string; onChanged: () => void }) {
  const write = useJiraWriteState(connectionId, issueKey, "transition", api);
  const { busy, uncertain, loading, operation } = write.state;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const toggleRef = useRef<HTMLButtonElement>(null);
  const applyRef = useRef<HTMLButtonElement>(null);
  const checkedRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<Transition[] | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { setOpen(false); setChoices(null); setValue(""); setError(""); }, [issueKey]);
  useEffect(() => { if (uncertain) setOpen(true); }, [uncertain]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setChoices(null); setError("");
    readThrough<{ transitions: Transition[] }>(api, `issue/${encodeURIComponent(issueKey)}/transitions`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setChoices(result.transitions); })
      .catch(() => { if (!controller.signal.aborted) setError("Could not load Jira transitions. Try again."); });
    return () => controller.abort();
  }, [api, issueKey, open]);
  const submit = async () => {
    if (!selfPressAccepted(busyRef.current) || !value || !write.begin()) return;
    busyRef.current = true;
    setError("");
    let attempted = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 30_000);
    try {
      attempted = true;
      const response = await api(`issue/${encodeURIComponent(issueKey)}/transitions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transitionId: value }), signal: controller.signal });
      if (!response.ok) throw await failureOf(response);
      const result = await response.json();
      if (!result?.ok || result.issueKey !== issueKey) throw new Error("Jira did not confirm the change. Refresh before trying again.");
      if (typeof document !== "undefined" && document.activeElement === applyRef.current) toggleRef.current?.focus();
      write.update({ busy: false, uncertain: false, error: "" });
      if (result.operationId && !await write.acknowledge(result.operationId)) return;
      setOpen(false); setValue("");
    } catch (err) {
      const definite = definiteJiraWriteFailure(err);
      if (!definite && typeof document !== "undefined" && document.activeElement === applyRef.current) toggleRef.current?.focus();
      write.update({ busy: false, operation: err instanceof IntegrationFailure ? err.operation : undefined, uncertain: !definite, error: definite && err instanceof Error ? err.message : "Could not confirm the change. Check the status before trying again." });
    }
    finally { window.clearTimeout(timer); busyRef.current = false; if (attempted) onChanged(); }
  };
  return <span className="jr-transition">
    <button ref={toggleRef} type="button" className="btn" aria-expanded={open} onClick={() => { if (!selfPressAccepted(busyRef.current)) return; setOpen(x => !x); }} {...selfPressProps(busy)}>Change status</button>
    {open && <span className="jr-transition-controls">
      {choices && choices.length === 0 && <span className="jr-dim">No transitions available.</span>}
      {choices && choices.length > 0 && <><label className="vis-hidden" htmlFor="jira-transition-choice">Available transitions</label>
        <select id="jira-transition-choice" value={value} aria-disabled={busy || undefined} onChange={e => { if (!busyRef.current) setValue(e.target.value); }}>
          <option value="">Choose transition</option>
          {choices.map(t => <option key={t.id} value={t.id} disabled={t.requiresScreen}>{t.name}{t.to && t.to !== t.name ? ` → ${t.to}` : ""}{t.requiresScreen ? " (open in Jira)" : ""}</option>)}
        </select>
        <button ref={applyRef} type="button" className="btn" onClick={submit} {...selfPressProps(busy, !value || uncertain || loading)}>{busy ? "Changing…" : "Apply"}</button></>}
      {uncertain && <button ref={checkedRef} type="button" className="btn" disabled={operation?.state === "pending"} onClick={() => { if (typeof document !== "undefined" && document.activeElement === checkedRef.current) toggleRef.current?.focus(); void write.acknowledge(); setError(""); }}>I checked the status</button>}
      {!choices && !error && <span className="jr-dim">Loading transitions…</span>}
      {error && <span role="alert">{error}</span>}
      {write.state.error && <span role="alert">{write.state.error}</span>}
    </span>}
  </span>;
}
