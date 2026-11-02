// The breakdown of the day selected in the usage-history chart: its date and
// cost, the CLIs that ran it, a table of its models (input, output, cost and
// share, with a total row for two or more) and its cache counts.
//
// Lifted out of UsageHistoryModal.tsx with the small stat it alone draws. It
// is handed the one day and reads nothing else.
import { useT } from "../i18n";
import { reportedCost, storedCostNote, missingPriceNote } from "../reported-cost";
import { fmtTokens } from "../token-format";
import { shortModel } from "../model-label";
import { byCost, dayAgentsLine, modelColor, percentOf, type DayEntry } from "../usage-history";

export default function UsageDayDetail({ selectedDay }: { selectedDay: DayEntry }) {
  const t = useT();
  const agentsLine = dayAgentsLine(selectedDay);
  const missing = selectedDay.modelBreakdowns.some(m => m.missingPricing);
  const stored = selectedDay.modelBreakdowns.filter(m => m.storedCost !== undefined);
  const costNote = storedCostNote(stored.length ? stored.reduce((n, m) => n + m.storedCost!, 0) : null, selectedDay.totalCost);
  return (
    <div className="uh-detail">
      <div className="uh-detail-head">
        <span className="uh-detail-date">{selectedDay.period}</span>
        <span className="uh-detail-cost">{reportedCost(selectedDay.totalCost, missing)}</span>
        {/* Which CLIs ran that day — see dayAgentsLine. The `title`
            carries the same text because this cell now ellipsises;
            the column is whatever the date and the cost leave of the
            row, which is roughly 88 monospace characters, and two
            named CLIs spend about thirty of them. #462 is the
            precedent — the model label overflowed a hard column here
            for exactly one build before anyone noticed, because
            nothing failed, it just wrapped. */}
        {agentsLine && <span className="uh-detail-agents" title={agentsLine}>{agentsLine}</span>}
      </div>
      {missing && <p className="uh-cost-note">{missingPriceNote()}</p>}
      {costNote && <p className="uh-cost-note">{costNote}</p>}
      {/* V4's table: Model, Input, Output, Cost, with each model's share of the day
          after its name, and a total row when two or more models ran. The cache
          counts, which the table has no column for, sit on one quiet line under it. */}
      <table className="uh-day-table">
        <thead>
          <tr>
            <th scope="col">{t("insights.usage.model")}</th>
            <th scope="col">{t("insights.cost.inputTitle")}</th>
            <th scope="col">{t("insights.cost.outputTitle")}</th>
            <th scope="col">{t("insights.usage.cost")}</th>
          </tr>
        </thead>
        <tbody>
          {byCost(selectedDay.modelBreakdowns).map(mb => {
            const pct = percentOf(mb.cost, selectedDay.totalCost);
            return (
              <tr key={mb.modelName} title={mb.modelName}>
                <th scope="row">
                  <span className="uh-model-name">
                    <span className="uh-legend-dot" style={{ background: modelColor(mb.modelName) }} />
                    {/* The label is in a span of its own so it can ellipsise: a label
                        wider than the column degrades to an ellipsis over a title
                        rather than to a broken row (#462). */}
                    <span className="uh-model-label">{shortModel(mb.modelName)}</span>
                    <span className="uh-model-share">{Math.round(pct)}%</span>
                  </span>
                </th>
                <td>{fmtTokens(mb.inputTokens)}</td>
                <td>{fmtTokens(mb.outputTokens)}</td>
                <td>{reportedCost(mb.cost, mb.missingPricing)}</td>
              </tr>
            );
          })}
        </tbody>
        {selectedDay.modelBreakdowns.length > 1 && (
          <tfoot>
            <tr>
              <th scope="row">{t("insights.usage.dayTotal")}</th>
              <td>{fmtTokens(selectedDay.inputTokens)}</td>
              <td>{fmtTokens(selectedDay.outputTokens)}</td>
              <td>{reportedCost(selectedDay.totalCost, missing)}</td>
            </tr>
          </tfoot>
        )}
      </table>
      <div className="uh-detail-mini">
        <MiniStat label={t("insights.usage.cacheWrite")} val={fmtTokens(selectedDay.cacheCreationTokens)} />
        <MiniStat label={t("insights.usage.cacheRead")}  val={fmtTokens(selectedDay.cacheReadTokens)} />
      </div>
    </div>
  );
}

function MiniStat({ label, val }: { label: string; val: string }) {
  return (
    <span className="uh-ministat">
      <span className="uh-ministat-label">{label}</span>
      <span className="uh-ministat-val">{val}</span>
    </span>
  );
}
