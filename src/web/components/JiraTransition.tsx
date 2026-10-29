import { useEffect, useRef, useState } from "react";
import type { JiraApi } from "../jira-api";
import { failureOf, IntegrationFailure, readThrough } from "../integrations/client";

type Transition = { id: string; name: string; to: string; requiresScreen: boolean };

/** Only Jira's currently available workflow actions are offered. */
export default function JiraTransition({ api, issueKey, onChanged }: { api: JiraApi; issueKey: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<Transition[] | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const lock = useRef(false);
  useEffect(() => { setOpen(false); setChoices(null); setValue(""); setError(""); setUncertain(false); }, [issueKey]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setChoices(null); setError("");
    readThrough<{ transitions: Transition[] }>(api, `issue/${encodeURIComponent(issueKey)}/transitions`, { signal: controller.signal })
      .then(result => setChoices(result.transitions))
      .catch(() => { if (!controller.signal.aborted) setError("Could not load Jira transitions. Try again."); });
    return () => controller.abort();
  }, [api, issueKey, open]);
  const submit = async () => {
    if (!value || lock.current || uncertain) return;
    lock.current = true; setBusy(true); setError("");
    let attempted = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 30_000);
    try {
      attempted = true;
      const response = await api(`issue/${encodeURIComponent(issueKey)}/transitions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transitionId: value }), signal: controller.signal });
      if (!response.ok) throw await failureOf(response);
      const result = await response.json();
      if (!result?.ok || result.issueKey !== issueKey) throw new Error("Jira did not confirm the change. Refresh before trying again.");
      setOpen(false); setValue("");
    } catch (err) {
      const definite = err instanceof IntegrationFailure && ["invalid", "permission", "expired", "auth", "not-found", "rate-limit"].includes(err.kind);
      setUncertain(!definite);
      setError(definite && err instanceof Error ? err.message : "Could not confirm the change. Check the status before trying again.");
    }
    finally { window.clearTimeout(timer); if (attempted) onChanged(); lock.current = false; setBusy(false); }
  };
  return <span className="jr-transition">
    <button type="button" className="btn jr-transition-toggle" aria-expanded={open} onClick={() => setOpen(x => !x)} disabled={busy}>Change status</button>
    {open && <span className="jr-transition-controls">
      {choices && choices.length === 0 && <span className="jr-dim">No transitions available.</span>}
      {choices && choices.length > 0 && <><label className="vis-hidden" htmlFor="jira-transition-choice">Available transitions</label>
        <select id="jira-transition-choice" value={value} onChange={e => setValue(e.target.value)} disabled={busy}>
          <option value="">Choose transition</option>
          {choices.map(t => <option key={t.id} value={t.id} disabled={t.requiresScreen}>{t.name}{t.to && t.to !== t.name ? ` → ${t.to}` : ""}{t.requiresScreen ? " (open in Jira)" : ""}</option>)}
        </select>
        <button type="button" className="btn" onClick={submit} disabled={!value || busy || uncertain}>{busy ? "Changing…" : "Apply"}</button></>}
      {uncertain && <button type="button" className="btn" onClick={() => { setUncertain(false); setError(""); }}>I checked the status</button>}
      {!choices && !error && <span className="jr-dim">Loading transitions…</span>}
      {error && <span role="alert">{error}</span>}
    </span>}
  </span>;
}
