// The usage panel's By model table, from ccusage for a period or from the
// board right now.
//
// Lifted out of UsagePanel.tsx unchanged. The two sources give different rows
// — ccusage one cost per model and all four token kinds, the board a priced
// breakdown over the two kinds it can price per agent — so the table keeps a
// branch for each, and says so where they differ. Which rows are worth a line
// is decided in the panel, which hands both lists in under the names the
// markup used.
import { UNKNOWN_MODEL, type BoardModelRow } from "../board-usage";
import { shortModel } from "../model-label";
import { fmtCost, UNPRICED_LABEL } from "../pricing";
import { fmtTokens } from "../token-format";
import type { ModelRow } from "../usage-from-ccusage";

export default function UsageModelTable({ fromRange, rangeModelRows, boardModelRows, staleCls }: {
  /** ccusage answered, so the rows are its models for the period. */
  fromRange: boolean;
  /** ccusage's models, summed across the days in the range. */
  rangeModelRows: ModelRow[];
  /** The board's models, when ccusage has not answered. */
  boardModelRows: BoardModelRow[];
  /** " up-stale" while a slower period loads, or "". */
  staleCls: string;
}) {
  return (
    <section className={`up-section${staleCls}`}>
      <h3 className="up-section-title">By model</h3>
      <table className="up-table">
        <thead>
          <tr>
            <th>Model</th>
            <th>Tokens</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {fromRange
            ? rangeModelRows.map(m => (
              <tr key={m.model}>
                <td className="up-model-name" title={m.model}>{shortModel(m.model)}</td>
                {/* Every token, not input plus output. The board's row
                    counts the two it can price per agent; ccusage sends
                    all four, and on an agentic session the cache is the
                    larger part by two orders of magnitude — 9.56B
                    against 320k on the machine this was written on. */}
                <td className="up-num">{fmtTokens(m.tokens)}</td>
                {m.cost > 0
                  ? <td className="up-num up-cost-val">{fmtCost(m.cost)}</td>
                  : <td className="up-num up-unpriced">{UNPRICED_LABEL}</td>}
              </tr>
            ))
            : boardModelRows.map(m => (
              <tr key={m.model}>
                {/* `__unknown__` is the map's key for an agent that has
                    not reported a model yet, and it is not a word. The
                    row still belongs here — its tokens are in the strip
                    above — but under a name a person can read. */}
                <td className="up-model-name" title={m.model === UNKNOWN_MODEL ? "no model reported yet" : m.model}>
                  {m.model === UNKNOWN_MODEL ? "unknown" : shortModel(m.model)}
                </td>
                <td className="up-num">{fmtTokens(m.inputTokens + m.outputTokens)}</td>
                {m.priced
                  ? <td className="up-num up-cost-val">{fmtCost(m.cost.total)}</td>
                  : <td className="up-num up-unpriced">{UNPRICED_LABEL}</td>}
              </tr>
            ))}
        </tbody>
      </table>
    </section>
  );
}
