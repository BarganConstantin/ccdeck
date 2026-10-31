import { useRef, useState } from "react";
import { useT } from "../i18n";
import type { JiraApi } from "../jira-api";
import { failureOf, IntegrationFailure } from "../integrations/client";
import { definiteJiraWriteFailure, useJiraWriteState } from "../jira-write-state";
import { selfPressAccepted, selfPressProps } from "../panel-press";

export default function JiraCommentForm({ api, connectionId, issueKey, onChanged }: { api: JiraApi; connectionId: string; issueKey: string; onChanged: () => void }) {
  const t = useT();
  const write = useJiraWriteState(connectionId, issueKey, "comment", api);
  const { busy, uncertain, error, loading, operation } = write.state;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const sendRef = useRef<HTMLButtonElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const checkedRef = useRef<HTMLButtonElement>(null);
  const text = write.state.draft;
  const [sent, setSent] = useState(false);
  const send = async () => {
    if (!selfPressAccepted(busyRef.current) || !text.trim() || text.length > 10000 || !write.begin(text)) return;
    busyRef.current = true;
    setSent(false);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await api(`issue/${encodeURIComponent(issueKey)}/comment`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal: controller.signal });
      if (!res.ok) throw await failureOf(res);
      const result = await res.json();
      if (!result?.ok || result.issueKey !== issueKey) throw new Error("Unconfirmed comment");
      if (typeof document !== "undefined" && document.activeElement === sendRef.current) textRef.current?.focus();
      setSent(true); write.update({ busy: false, draft: "", error: "", uncertain: false });
      if (result.operationId) await write.acknowledge(result.operationId);
      onChanged();
    } catch (err) {
      const definite = definiteJiraWriteFailure(err);
      const operation = err instanceof IntegrationFailure ? err.operation : undefined;
      if (!definite && typeof document !== "undefined" && document.activeElement === sendRef.current) textRef.current?.focus();
      write.update({ busy: false, operation, uncertain: !definite, error: definite && err instanceof Error ? err.message : t("integrations.comment.cannotConfirm") });
      onChanged();
    } finally { window.clearTimeout(timer); busyRef.current = false; }
  };
  return <div className="jr-comment-compose">
    <label htmlFor="jira-comment-text">{t("integrations.comment.add")}</label>
    <textarea ref={textRef} id="jira-comment-text" value={text} maxLength={10000} rows={3} readOnly={busy} onChange={e => { if (busyRef.current) return; write.update({ draft: e.target.value, ...(!uncertain && error ? { error: "" } : {}) }); setSent(false); }} placeholder={t("integrations.comment.placeholder")} />
    <div className="jr-comment-actions">
      <button ref={sendRef} type="button" className="btn" {...selfPressProps(busy || !!loading, !text.trim() || uncertain)} onClick={send}>{busy ? t("integrations.comment.sending") : t("integrations.comment.send")}</button>
      {uncertain && <button ref={checkedRef} type="button" className="btn" aria-disabled={operation?.state === "pending" || undefined} onClick={() => { if (typeof document !== "undefined" && document.activeElement === checkedRef.current) textRef.current?.focus(); void write.acknowledge(); }}>{t("integrations.comment.checked")}</button>}
      {sent && <span role="status">{t("integrations.comment.added")}</span>}
    </div>
    {error && <p role="alert">{error}</p>}
  </div>;
}
