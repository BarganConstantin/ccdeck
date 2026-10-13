import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { shortModel } from "../model-label";
import { agentLabel } from "../provider-copy";
import { fmtCost } from "../pricing";
import { fmtTokens } from "../token-format";
import { sessionFailure, type SessionReply, type SessionSelection, type SessionSpeed } from "../session-usage";
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";
import { RefreshGlyph } from "./action-glyphs";

const count = (n: number) => n.toLocaleString();
const at = (value: string) => new Date(value).toLocaleString(undefined, {
  month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
});

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
  const tokens = detail ? [
    { name: "Input", n: detail.inputTokens, color: "var(--usage-blue)" },
    { name: "Output", n: detail.outputTokens, color: "var(--usage-purple)" },
    { name: "Cache read", n: detail.cacheReadTokens, color: "var(--usage-teal)" },
    { name: "Cache write", n: detail.cacheCreationTokens, color: "var(--usage-orange)" },
  ] : [];
  // Composition uses the reported counters, not a guessed split of totalTokens.
  // Reasoning is already in output and must not become a fifth segment.
  const tokenSum = tokens.reduce((sum, token) => sum + token.n, 0);
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
              aria-label="Refresh session usage" title="Refresh session usage"><RefreshGlyph /></button>
            <button type="button" className="glyph-btn" ref={closeRef} onClick={onClose} aria-label="Close session usage (Esc)" title="Close (Esc)">×</button>
          </div>
        </header>
        <div className="modal-body su-body" aria-busy={!reply}>
          <div className="su-scope"><span>{agentLabel(session.agent)}</span><span>Whole session</span></div>
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
            <section aria-labelledby="session-tokens-title">
              <div className="su-section-head"><h3 id="session-tokens-title">Token breakdown</h3></div>
              <div className="su-cache-reuse">
                <span>Cached input reuse</span>
                <strong>{detail.cacheReuse?.pct != null
                  ? `${detail.cacheReuse.pct.toLocaleString(undefined, { maximumFractionDigits: 1 })}%` : "—"}</strong>
                <span className="su-note">{detail.cacheReuse && detail.cacheReuse.measured > 0
                  ? `${detail.cacheReuse.measured} of ${detail.cacheReuse.total} ${detail.cacheReuse.unit} measured${detail.cacheReuse.pct == null ? " · no input tokens" : ""}`
                  : "No cache measurements available"}</span>
              </div>
              {tokenSum > 0 && <div className="su-composition" aria-hidden="true">
                {tokens.filter(token => token.n > 0).map(token => <span key={token.name}
                  style={{ width: `${token.n / tokenSum * 100}%`, background: token.color }} />)}
              </div>}
              <dl className="su-tokens">
                {tokens.map(({ name, n, color }) => <div key={name}>
                  <dt><span className="su-key" style={{ background: color }} aria-hidden="true" />{name}</dt>
                  <dd title={count(n)}>{fmtTokens(n)}<span className="su-share">{tokenSum > 0 ? `${(n / tokenSum * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%` : "—"}</span></dd>
                </div>)}
              </dl>
              {detail.reasoningOutputTokens > 0 && <p className="su-note su-reasoning">{fmtTokens(detail.reasoningOutputTokens)} reasoning tokens, included in output.</p>}
            </section>
            <section className="su-models" aria-labelledby="session-models-title">
              <div className="su-section-head"><h3 id="session-models-title">Models</h3><span>{detail.models.length} used</span></div>
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
              {detail.firstActivity && <div><dt>First activity</dt><dd><time dateTime={detail.firstActivity} title={new Date(detail.firstActivity).toLocaleString()}>{at(detail.firstActivity)}</time></dd></div>}
              {detail.lastActivity && <div><dt>Last activity</dt><dd><time dateTime={detail.lastActivity} title={new Date(detail.lastActivity).toLocaleString()}>{at(detail.lastActivity)}</time></dd></div>}
              {detail.entries != null && <div><dt>Usage records</dt><dd>{count(detail.entries)}</dd></div>}
            </dl>
          </>}
          <footer className="su-footer">
          <p className="su-note">{speed === "auto" ? "Estimated from local logs, not an invoice." : "Pricing scenario · does not change settings or billing."} Includes the whole session.</p>
          <details className="su-id su-assumptions"><summary>Estimate details</summary>
          <p className="su-note">{session.agent === "codex"
            ? speed === "auto"
              ? "ccusage estimates from recorded Standard, Fast and Flex settings; unmarked usage can use your current Codex config. Requested modes do not confirm billed rates."
              : "This scenario applies one mode to the whole session. It does not change Codex or your billing. Models without a published multiplier keep standard pricing."
            : "Cost is the ccusage estimate from local logs, not an invoice."} The whole session can extend beyond the period selected in Usage.</p></details>
          <details className="su-id"><summary>Session ID</summary><code>{session.sessionId}</code></details>
          </footer>
        </div>
      </div>
    </div>, document.body,
  );
}
