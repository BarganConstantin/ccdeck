import { useRef, useState } from "react";
import type { JiraApi } from "../jira-api";
import { failureOf, IntegrationFailure } from "../integrations/client";

export default function JiraCommentForm({ api, issueKey, onChanged }: { api: JiraApi; issueKey: string; onChanged: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [sent, setSent] = useState(false);
  const lock = useRef(false);
  const send = async () => {
    if (lock.current || !text.trim() || text.length > 10000 || uncertain) return;
    lock.current = true; setBusy(true); setError(""); setSent(false);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await api(`issue/${encodeURIComponent(issueKey)}/comment`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal: controller.signal });
      if (!res.ok) throw await failureOf(res);
      const result = await res.json();
      if (!result?.ok || result.issueKey !== issueKey) throw new Error("Unconfirmed comment");
      setText(""); setSent(true); onChanged();
    } catch (err) {
      const definite = err instanceof IntegrationFailure && ["invalid", "permission", "expired", "auth", "not-found", "rate-limit"].includes(err.kind);
      setUncertain(!definite);
      setError(definite && err instanceof Error ? err.message : "Could not confirm whether Jira saved the comment. Check the comments before sending again.");
      onChanged();
    } finally { window.clearTimeout(timer); lock.current = false; setBusy(false); }
  };
  return <div className="jr-comment-compose">
    <label htmlFor="jira-comment-text">Add a comment</label>
    <textarea id="jira-comment-text" value={text} maxLength={10000} rows={3} disabled={busy} onChange={e => { setText(e.target.value); setSent(false); }} placeholder="Write a comment…" />
    <div className="jr-comment-actions">
      <button type="button" className="btn" disabled={!text.trim() || busy || uncertain} onClick={send}>{busy ? "Sending…" : "Add comment"}</button>
      {uncertain && <button type="button" className="btn" onClick={() => { setUncertain(false); setError(""); }}>I checked the comments</button>}
      {sent && <span role="status">Comment added.</span>}
    </div>
    {error && <p role="alert">{error}</p>}
  </div>;
}
