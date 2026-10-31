import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { currentLanguage, useT } from "../i18n";
import { shortModel } from "../model-label";
import { agentLabel } from "../provider-copy";
import { fmtCost } from "../pricing";
import { fmtTokens } from "../token-format";
import { sessionFailure, type SessionReply, type SessionSelection, type SessionSpeed } from "../session-usage";
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";
import { RefreshGlyph } from "./action-glyphs";
import SessionUsageLoading from "./SessionUsageLoading";

const count = (n: number) => n.toLocaleString(currentLanguage());
const at = (value: string) => new Date(value).toLocaleString(currentLanguage(), {
  month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
});

export default function SessionUsageModal({ session, onClose }: { session: SessionSelection; onClose: () => void }) {
  const t = useT();
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
    { id: "input", name: t("insights.cost.inputTitle"), n: detail.inputTokens, color: "var(--usage-blue)" },
    { id: "output", name: t("insights.cost.outputTitle"), n: detail.outputTokens, color: "var(--usage-purple)" },
    { id: "cacheRead", name: t("insights.usage.cacheReadTitle"), n: detail.cacheReadTokens, color: "var(--usage-teal)" },
    { id: "cacheWrite", name: t("insights.usage.cacheWriteTitle"), n: detail.cacheCreationTokens, color: "var(--usage-orange)" },
  ] : [];
  // Composition uses the reported counters, not a guessed split of totalTokens.
  // Reasoning is already in output and must not become a fifth segment.
  const tokenSum = tokens.reduce((sum, token) => sum + token.n, 0);
  return createPortal(
    <div className="modal-backdrop" {...scrim} role="presentation">
      <div className="modal su-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="session-usage-title">
        <header className="modal-head">
          <div className="su-title">
            <h2 id="session-usage-title">{t("insights.session.title")}</h2>
            <span title={session.label}>{session.label}</span>
          </div>
          <div className="modal-actions">
            <button type="button" className="glyph-btn" onClick={() => setRevision(n => n + 1)} disabled={!reply}
              aria-label={t("insights.session.refresh")} title={t("insights.session.refresh")}><RefreshGlyph /></button>
            <button type="button" className="glyph-btn" ref={closeRef} onClick={onClose} aria-label={t("insights.session.closeEsc")} title={t("insights.audit.closeEsc")}>×</button>
          </div>
        </header>
        <div className="modal-body su-body" aria-busy={!reply}>
          <div className="su-scope"><span>{agentLabel(session.agent)}</span><span>{t("insights.session.whole")}</span></div>
          {session.agent === "codex" && <label className="su-pricing">
            {t("insights.session.estimateUsing")}
            <select value={speed} disabled={!reply} onChange={event => { setReply(null); setSpeed(event.target.value as SessionSpeed); }}>
              <option value="auto">{t("insights.session.speed.auto")}</option>
              <option value="standard">{t("insights.session.speed.standard")}</option>
              <option value="fast">{t("insights.session.speed.fast")}</option>
              <option value="flex">{t("insights.session.speed.flex")}</option>
            </select>
          </label>}
          {!reply && <SessionUsageLoading />}
          {reply && !reply.ok && <p className="su-message" role="status" title={reply.error}>
            {sessionFailure(reply)} {t("insights.session.useRefresh")}
          </p>}
          {detail && <div className="su-result">
            <dl className="su-totals">
              <div><dt>{speed === "auto" ? t("insights.session.estimated") : t("insights.session.scenario")}{missing.length > 0 ? ` · ${t("insights.session.partial")}` : ""}</dt>
                <dd>{detail.totalCost > 0 ? fmtCost(detail.totalCost)
                  : detail.totalTokens > 0 ? t("insights.session.noCost") : "$0.00"}{missing.length > 0 && detail.totalCost > 0 ? "+" : ""}</dd></div>
              <div><dt>{t("insights.session.totalTokens")}</dt><dd title={count(detail.totalTokens)}>{fmtTokens(detail.totalTokens)}</dd></div>
            </dl>
            <section aria-labelledby="session-tokens-title">
              <div className="su-section-head"><h3 id="session-tokens-title">{t("insights.session.breakdown")}</h3></div>
              <div className="su-cache-reuse">
                <span>{t("insights.session.reuse")}</span>
                <strong>{detail.cacheReuse?.pct != null
                  ? `${detail.cacheReuse.pct.toLocaleString(currentLanguage(), { maximumFractionDigits: 1 })}%` : "—"}</strong>
                <span className="su-note">{detail.cacheReuse && detail.cacheReuse.measured > 0
                  ? t("insights.session.measured", { measured: detail.cacheReuse.measured, total: detail.cacheReuse.total, unit: t(detail.cacheReuse.unit === "model groups" ? "insights.session.unit.groups" : "insights.session.unit.records") }) + (detail.cacheReuse.pct == null ? ` · ${t("insights.session.noInput")}` : "")
                  : t("insights.session.noMeasure")}</span>
              </div>
              {tokenSum > 0 && <div className="su-composition" aria-hidden="true">
                {tokens.filter(token => token.n > 0).map(token => <span key={token.id}
                  style={{ width: `${token.n / tokenSum * 100}%`, background: token.color }} />)}
              </div>}
              <dl className="su-tokens">
                {tokens.map(({ id, name, n, color }) => <div key={id}>
                  <dt><span className="su-key" style={{ background: color }} aria-hidden="true" />{name}</dt>
                  <dd title={count(n)}>{fmtTokens(n)}<span className="su-share">{tokenSum > 0 ? `${(n / tokenSum * 100).toLocaleString(currentLanguage(), { maximumFractionDigits: 1 })}%` : "—"}</span></dd>
                </div>)}
              </dl>
              {detail.reasoningOutputTokens > 0 && <p className="su-note su-reasoning">{t("insights.session.reasoning", { tokens: fmtTokens(detail.reasoningOutputTokens) })}</p>}
            </section>
            <section className="su-models" aria-labelledby="session-models-title">
              <div className="su-section-head"><h3 id="session-models-title">{t("insights.session.models")}</h3><span>{t("insights.session.used", { n: detail.models.length })}</span></div>
              <table>
                <thead><tr><th scope="col">{t("insights.usage.model")}</th><th scope="col">{t("insights.usage.tokensCol")}</th></tr></thead>
                <tbody>{detail.models.map(model => <tr key={model.model}>
                  <th scope="row" title={model.model}>{shortModel(model.model)}{model.missingPricing && <span className="su-unpriced"> · {t("insights.cost.notPriced")}</span>}</th>
                  <td title={count(model.totalTokens)}>{fmtTokens(model.totalTokens)}</td>
                </tr>)}</tbody>
              </table>
              {detail.models.length === 0 && <p className="su-note">{t("insights.session.noModels")}</p>}
            </section>
            {missing.length > 0 && <p className="su-note">{t("insights.session.unpriced")}</p>}
            <dl className="su-dates">
              {detail.firstActivity && <div><dt>{t("insights.session.first")}</dt><dd><time dateTime={detail.firstActivity} title={new Date(detail.firstActivity).toLocaleString(currentLanguage())}>{at(detail.firstActivity)}</time></dd></div>}
              {detail.lastActivity && <div><dt>{t("insights.session.last")}</dt><dd><time dateTime={detail.lastActivity} title={new Date(detail.lastActivity).toLocaleString(currentLanguage())}>{at(detail.lastActivity)}</time></dd></div>}
              {detail.entries != null && <div><dt>{t("insights.session.records")}</dt><dd>{count(detail.entries)}</dd></div>}
            </dl>
          </div>}
          <footer className="su-footer">
          <p className="su-note">{speed === "auto" ? t("insights.session.note.auto") : t("insights.session.note.scenario")} {t("insights.session.note.whole")}</p>
          <details className="su-id su-assumptions"><summary>{t("insights.session.details")}</summary>
          <p className="su-note">{session.agent === "codex"
            ? speed === "auto"
              ? t("insights.session.detail.auto")
              : t("insights.session.detail.scenario")
            : t("insights.session.detail.claude")} {t("insights.session.detail.period")}</p></details>
          <details className="su-id"><summary>{t("insights.session.id")}</summary><code>{session.sessionId}</code></details>
          </footer>
        </div>
      </div>
    </div>, document.body,
  );
}
