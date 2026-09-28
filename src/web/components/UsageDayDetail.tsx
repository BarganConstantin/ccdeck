// The breakdown of the day selected in the usage-history chart: its date and
// cost, the CLIs that ran it, its four token counts and each model's share.
//
// Lifted out of UsageHistoryModal.tsx with the small stat it alone draws. It
// is handed the one day and reads nothing else.
import { fmtCost } from "../pricing";
import { fmtTokens } from "../token-format";
import { shortModel } from "../model-label";
import { byCost, dayAgentsLine, modelColor, percentOf, type DayEntry } from "../usage-history";

export default function UsageDayDetail({ selectedDay }: { selectedDay: DayEntry }) {
  const agentsLine = dayAgentsLine(selectedDay);
  return (
    <div className="uh-detail">
      <div className="uh-detail-head">
        <span className="uh-detail-date">{selectedDay.period}</span>
        <span className="uh-detail-cost">{fmtCost(selectedDay.totalCost)}</span>
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
      <div className="uh-detail-mini">
        <MiniStat label="input"       val={fmtTokens(selectedDay.inputTokens)} />
        <MiniStat label="output"      val={fmtTokens(selectedDay.outputTokens)} />
        <MiniStat label="cache write" val={fmtTokens(selectedDay.cacheCreationTokens)} />
        <MiniStat label="cache read"  val={fmtTokens(selectedDay.cacheReadTokens)} />
      </div>
      <div className="uh-detail-models">
        {byCost(selectedDay.modelBreakdowns).map(mb => {
          const pct = percentOf(mb.cost, selectedDay.totalCost);
          return (
            <div key={mb.modelName} className="uh-model-row" title={mb.modelName}>
              <span className="uh-model-name">
                <span className="uh-legend-dot" style={{ background: modelColor(mb.modelName) }} />
                {/* The label is in a span of its own so it can
                    ellipsise: this column is a hard 130px and the
                    text used to be an anonymous flex item, which
                    `text-overflow` cannot reach — a label wider than
                    the column wrapped onto a second line and pushed
                    the bar out of the row. Nothing in the known
                    corpus is that wide (see model-label.ts), and the
                    point is that the next qualifier to arrive
                    degrades to an ellipsis over a `title` rather
                    than to a broken row. */}
                <span className="uh-model-label">{shortModel(mb.modelName)}</span>
              </span>
              <span className="uh-model-bar">
                <span className="uh-model-bar-fill" style={{ width: `${pct}%`, background: modelColor(mb.modelName) }} />
              </span>
              <span className="uh-model-cost">{fmtCost(mb.cost)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MiniStat({ label, val }: { label: string; val: string }) {
  return (
    <div className="uh-ministat">
      <span className="uh-ministat-val">{val}</span>
      <span className="uh-ministat-label">{label}</span>
    </div>
  );
}
