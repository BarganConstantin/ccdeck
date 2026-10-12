import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { shortModel } from "../model-label";
import { agentLabel } from "../provider-copy";
import { fmtCost } from "../pricing";
import { fmtTokens } from "../token-format";
import { sessionFailure, type SessionReply, type SessionSelection, type SessionSpeed } from "../session-usage";
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";

const count = (n: number) => n.toLocaleString();
const at = (value: string) => new Date(value).toLocaleString();

export default function SessionUsageModal({ session, onClose }: { session: SessionSelection; onClose: () => void }) {
  const [speed, setSpeed] = useState<SessionSpeed>("auto");
  const [revision, setRevision] = useState(0);
  const [reply, setReply] = useState<SessionReply | null>(null);
  const refreshedRef = useRef(revision);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDismiss(onClose, { focusRef: closeRef });
  const scrim = useScrimDismiss(onClose);
  const detail = reply?.ok && reply.detail?.speed === speed ? reply.detail : undefined;

  useEffect(() => {
    const controller = new AbortController();
    setReply(null);
    const params = new URLSearchParams({ agent: session.agent, id: session.sessionId, speed });
    // Refresh explicitly asks for a newer reading; a mode change can use its
    // own cache. Neither a closed inspector nor a hidden tab polls this route.
    if (revision !== refreshedRef.current) params.set("refresh", "1");
    refreshedRef.current = revision;
    fetch(`/api/ccusage/session?${params}`, { signal: controller.signal })
      .then(async response => {
        const data = await response.json() as SessionReply;
        if (!controller.signal.aborted) setReply(data);
      })
      .catch(() => { if (!controller.signal.aborted) setReply({ ok: false }); });
    return () => controller.abort();
  }, [session.agent, session.sessionId, speed, revision]);

  const missing = detail?.models.filter(model => model.missingPricing) ?? [];
  return createPortal(
    <div className="modal-backdrop" {...scrim} role="presentation">
      <div className="modal su-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="session-usage-title">
        <header className="modal-head">
          <div className="su-title">
            <h2 id="session-usage-title">Session usage</h2>
            <span title={session.label}>{session.label}</span>
          </div>
          <div className="modal-actions">
            <button type="button" className="glyph-btn" onClick={() => setRevision(n => n + 1)} disabled={!reply}
              aria-label="Refresh session usage" title="Refresh session usage">↻</button>
            <button type="button" className="glyph-btn" ref={closeRef} onClick={onClose} aria-label="Close session usage (Esc)" title="Close (Esc)">×</button>
          </div>
        </header>
        <div className="modal-body su-body" aria-busy={!reply}>
          <div className="su-scope">{agentLabel(session.agent)} · Whole session</div>
          {session.agent === "codex" && <label className="su-pricing">
            Estimate using
            <select value={speed} disabled={!reply} onChange={event => { setReply(null); setSpeed(event.target.value as SessionSpeed); }}>
              <option value="auto">Session settings / config</option>
              <option value="standard">Standard scenario</option>
              <option value="fast">Fast scenario</option>
              <option value="flex">Flex scenario</option>
            </select>
          </label>}
          {!reply && <p className="su-message" role="status">Reading local session usage…</p>}
          {reply && !reply.ok && <p className="su-message" role="status" title={reply.error}>
            {sessionFailure(reply)} Use Refresh to try again.
          </p>}
          {detail && <>
            <dl className="su-totals">
              <div><dt>{speed === "auto" ? "Estimated cost" : "Scenario estimate"}{missing.length > 0 ? " · partial" : ""}</dt>
                <dd>{detail.totalCost > 0 ? fmtCost(detail.totalCost)
                  : detail.totalTokens > 0 ? "No cost reported" : "$0.00"}{missing.length > 0 && detail.totalCost > 0 ? "+" : ""}</dd></div>
              <div><dt>Total tokens</dt><dd title={count(detail.totalTokens)}>{fmtTokens(detail.totalTokens)}</dd></div>
            </dl>
            <dl className="su-tokens">
              {([
                ["Input", detail.inputTokens], ["Output", detail.outputTokens],
                ["Cache read", detail.cacheReadTokens], ["Cache write", detail.cacheCreationTokens],
              ] as const).map(([name, n]) => <div key={name}><dt>{name}</dt><dd title={count(n)}>{fmtTokens(n)}</dd></div>)}
            </dl>
            {detail.reasoningOutputTokens > 0 && <p className="su-note">{fmtTokens(detail.reasoningOutputTokens)} reasoning tokens, included in output.</p>}
            <section className="su-models" aria-labelledby="session-models-title">
              <h3 id="session-models-title">Models</h3>
              <table>
                <thead><tr><th scope="col">Model</th><th scope="col">Tokens</th></tr></thead>
                <tbody>{detail.models.map(model => <tr key={model.model}>
                  <th scope="row" title={model.model}>{shortModel(model.model)}{model.missingPricing && <span className="su-unpriced"> · not priced</span>}</th>
                  <td title={count(model.totalTokens)}>{fmtTokens(model.totalTokens)}</td>
                </tr>)}</tbody>
              </table>
              {detail.models.length === 0 && <p className="su-note">No model breakdown was reported.</p>}
            </section>
            {missing.length > 0 && <p className="su-note">Tokens on unpriced models are included; their cost is missing from the estimate.</p>}
            <dl className="su-dates">
              {detail.firstActivity && <div><dt>First activity</dt><dd>{at(detail.firstActivity)}</dd></div>}
              {detail.lastActivity && <div><dt>Last activity</dt><dd>{at(detail.lastActivity)}</dd></div>}
              {detail.entries != null && <div><dt>Usage records</dt><dd>{count(detail.entries)}</dd></div>}
            </dl>
          </>}
          <p className="su-note">{session.agent === "codex"
            ? speed === "auto"
              ? "ccusage estimates from recorded Standard, Fast and Flex settings; unmarked usage can use your current Codex config. Requested modes do not confirm billed rates."
              : "This scenario applies one mode to the whole session. It does not change Codex or your billing. Models without a published multiplier keep standard pricing."
            : "Cost is the ccusage estimate from local logs, not an invoice."} The whole session can extend beyond the period selected in Usage.</p>
          <details className="su-id"><summary>Session ID</summary><code>{session.sessionId}</code></details>
        </div>
      </div>
    </div>, document.body,
  );
}
