// Modal that pops in when a session naturally ends (Stop / SessionEnd
// hook) and shows a recap: total cost + breakdown bar, duration, model,
// agent / tool / prompt counts, top tools used. User-dismissed sessions
// don't re-open on refresh (the dismissed list is in localStorage).
import { useMemo, useRef } from "react";
import { costForUsage, fmtCost } from "../pricing";
import { t as translate, useT, currentLanguage } from "../i18n";
import { sessionSpendLabel } from "../board-usage";
import { agentCost, agentModelIds } from "../usage-models";
import type { GraphState } from "../reducer";
import type { AgentNodeData } from "../types";
import { shortModel, modelFamily } from "../model-label";
import { typedPrompts } from "../injected-prompt";
// The breakdown bar used to be a third copy of one component, `SsCostBar`,
// which differed from the other two by its name and the one class that makes it
// taller (#374). That class is the `size` prop now.
import CostBar from "./CostBar";
import { Dialog } from "./Dialog";
import { StateMark } from "./StateMark";
import { sessionMark, type StateMarkKind } from "../node-face";
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";

interface Props {
  state: GraphState;
  sessionId: string;
  onClose: () => void;
}

export default function SessionSummary({ state, sessionId, onClose }: Props) {
  const t = useT();
  // `state.revision` as well as `state`, for the reason SessionList gives: the
  // prop is `stateRef.current`, which the reducer mutates in place, so its
  // identity never moves and a memo keyed on it alone froze the recap at the
  // moment it opened — the turn's usage that lands after its Stop, a background
  // subagent still working, a session resuming underneath it all stayed out.
  const summary = useMemo(() => buildSummary(state, sessionId), [state, state.revision, sessionId]);
  // Registered before the early return, so the hook order holds on the render
  // where the session has already been pruned. This is the modal nobody asked
  // for — it opens on a Stop hook — which makes Escape the first thing a user
  // reaches for and made its absence here the worst of the two.
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDismiss(onClose, { focusRef: closeRef });
  const scrimPress = useScrimDismiss(onClose);
  if (!summary) return null;

  return (
    <Dialog scrim={scrimPress} dialogRef={dialogRef} className="session-summary" labelledBy="ss-title ss-who-name">
        <div className="modal-head">
          <div className="modal-title">
            <span id="ss-title" className="modal-tool-name">{t("insights.summary.title")}</span>
          </div>
          <div className="modal-actions">
            <span className="modal-dur" title={t("insights.summary.wall")}>{summary.durationLabel}</span>
            <button type="button" ref={closeRef} className="glyph-btn" onClick={onClose} aria-label={t("insights.audit.closeEsc")} title={t("insights.audit.closeEsc")}>×</button>
          </div>
        </div>

        <div className="modal-body">
          {/* V4's who line: the session's mark, its name and its short id. The
              mark is its card's: the cross when its calls failed, not done's tick. */}
          <div className="ss-who" title={summary.cwd ?? summary.sessionId}>
            <StateMark kind={summary.mark} />
            <span id="ss-who-name" className="ss-who-name">{summary.label}</span>
            <span className="ss-who-id">· {summary.sessionId.slice(0, 8)}</span>
          </div>

          <section className="ss-stats">
            {/* The same word retired from the sidebar row beside it (#687):
                this is the sum over the agents of ONE session that are still
                on the board, which is a scope and not a total. The session it
                belongs to is named on the line above, so the scope needs no
                more words than that. */}
            <Stat label={t("insights.summary.spend")} value={fmtCost(summary.cost.total)} title={sessionSpendLabel()} />
            <Stat label={t("insights.summary.agents")} value={summary.agentCount} />
            <Stat label={t("insights.summary.subagents")} value={summary.subagentCount} />
            <Stat label={t("insights.summary.toolCalls")} value={summary.toolCount} />
            <Stat label={t("insights.summary.prompts")} value={summary.promptCount} />
            <Stat label={t("insights.summary.errors")} value={summary.errCount} tone={summary.errCount > 0 ? "err" : undefined} />
            <Stat label={t("insights.usage.tokens")} value={summary.tokensSum.toLocaleString(currentLanguage())} />
          </section>

          {(summary.modelChips.length > 0 || summary.cost.total > 0) && (
            <section className="ss-hero">
              {summary.modelChips.length > 0 && (
                <div className="ss-models">
                  {summary.modelChips.map(m => (
                    <span className="model-chip" key={m} data-family={modelFamily(m)} title={m}>{shortModel(m)}</span>
                  ))}
                </div>
              )}
              {summary.cost.total > 0 && (
                <>
                  <CostBar cost={summary.cost} size="lg" />
                  <div className="ss-cost-legend">
                    <span className="ssl ssl-in">{t("insights.cost.input")} <b>{fmtCost(summary.cost.input)}</b></span>
                    <span className="ssl ssl-out">{t("insights.cost.output")} <b>{fmtCost(summary.cost.output)}</b></span>
                    <span className="ssl ssl-cr">{t("insights.summary.cacheR")} <b>{fmtCost(summary.cost.cacheRead)}</b></span>
                    <span className="ssl ssl-cw">{t("insights.summary.cacheW")} <b>{fmtCost(summary.cost.cacheWrite)}</b></span>
                  </div>
                </>
              )}
            </section>
          )}

          {summary.topTools.length > 0 && (
            <section className="modal-section">
              <h4>{t("insights.summary.topTools")}</h4>
              <div className="ss-top-tools">
                {summary.topTools.map(([name, count]) => (
                  <span className="ss-tt" key={name}>{name} <b>{count}</b></span>
                ))}
              </div>
            </section>
          )}

          {summary.firstPrompt && (
            <section className="modal-section">
              <h4>{t("insights.summary.opening")}</h4>
              <div className="ss-prompt">{summary.firstPrompt}</div>
            </section>
          )}
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn primary" onClick={onClose}>{t("shell.done")}</button>
        </footer>
    </Dialog>
  );
}

function Stat({ label, value, tone, title }: { label: string; value: number | string; tone?: "err"; title?: string }) {
  return (
    <div className={`ss-stat${tone ? ` tone-${tone}` : ""}`} title={title}>
      <div className="ss-stat-value">{value}</div>
      <div className="ss-stat-label">{label}</div>
    </div>
  );
}

interface Summary {
  sessionId: string;
  label: string;
  cwd?: string;
  durationLabel: string;
  cost: ReturnType<typeof costForUsage>;
  modelChips: string[];
  agentCount: number;
  subagentCount: number;
  toolCount: number;
  promptCount: number;
  tokensSum: number;
  errCount: number;
  topTools: Array<[string, number]>;
  firstPrompt?: string;
  /** The mark the session's card and row draw (node-face.ts sessionMark). */
  mark: StateMarkKind;
}

function buildSummary(state: GraphState, sessionId: string): Summary | null {
  const root = state.agents.get(sessionId);
  if (!root) return null;
  const sessionAgents: AgentNodeData[] = [];
  for (const a of state.agents.values()) if (a.sessionId === sessionId) sessionAgents.push(a);
  if (sessionAgents.length === 0) return null;

  // Aggregate cost across every agent in the session — root + subagents
  // can use different models, so sum the per-agent computations.
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const modelSet = new Set<string>();
  const toolCounts = new Map<string, number>();
  let toolCount = 0, promptCount = 0, tokensSum = 0, errCount = 0, subagentCount = 0;
  let firstPrompt: string | undefined;
  let earliestStart = Infinity;
  let latestEnd = 0;

  for (const a of sessionAgents) {
    const c = agentCost(a);
    cost.input += c.input;
    cost.output += c.output;
    cost.cacheRead += c.cacheRead;
    cost.cacheWrite += c.cacheWrite;
    cost.total += c.total;
    // Every model this agent actually SPENT on, not the one model it was last
    // seen on. The principle three lines up — "root + subagents can use
    // different models, so sum the per-agent computations" — was right and
    // applied one level too high: within a single agent the model was treated
    // as a constant it is not, so a session that ran on Opus and finished on
    // Sonnet drew one Sonnet chip over a total priced entirely at Sonnet (#686).
    for (const m of agentModelIds(a)) modelSet.add(m);
    if (a.model) modelSet.add(a.model);
    if (a.kind === "subagent") subagentCount++;
    // Typed prompts only: a background task's notice is not a turn (#834).
    const typed = typedPrompts(a.prompts);
    promptCount += typed.length;
    if (!firstPrompt && typed.length > 0) firstPrompt = typed[0].text;
    tokensSum += a.usage.inputTokens + a.usage.outputTokens;
    // Every call ever made, not just the bounded window the reducer retains —
    // and the errors and the ranking over the same calls (#1809). Read off
    // `tools`, they left out whatever had slid out of that window, beside a
    // total that counted it.
    toolCount += a.toolCount;
    errCount += a.toolErrorCount ?? 0;
    for (const [name, n] of a.toolCountByName ?? []) toolCounts.set(name, (toolCounts.get(name) ?? 0) + n);
    earliestStart = Math.min(earliestStart, a.startedAt);
    latestEnd = Math.max(latestEnd, a.endedAt ?? Date.now());
  }

  const durationMs = Math.max(0, latestEnd - earliestStart);
  const sec = Math.floor(durationMs / 1000);
  const durationLabel = sec < 60
    ? `${sec}s`
    : sec < 3600
      ? `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`
      : `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;

  const topTools = Array.from(toolCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return {
    sessionId,
    label: root.label || root.cwdBasename || translate("insights.summary.session"),
    cwd: root.cwd,
    durationLabel,
    cost,
    modelChips: Array.from(modelSet),
    agentCount: sessionAgents.length,
    subagentCount,
    toolCount,
    promptCount,
    tokensSum,
    errCount,
    topTools,
    firstPrompt,
    mark: sessionMark(root),
  };
}
