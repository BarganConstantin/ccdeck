// The ribbon in the topbar naming the selected agent: its state, its label, what
// it has cost and, while it runs, at what rate. Clicking it zooms to the agent
// and its session; its × clears the selection.
//
// Moved out of App.tsx's markup unchanged. App.tsx still decides when it shows
// (only while something is selected) and owns the selection and the zoom.
import { fmtCost, fmtCostRate } from "../pricing";
import type { AgentNodeData } from "../types";
// The topbar strip, the burn ticker, the selected-session ribbon and the detail
// panel all multiply usage by a price, and all four used to multiply a whole
// session's cumulative tokens by the one model it was last seen on. See
// usage-models.ts (#686).
import { agentCost } from "../usage-models";
import { withKey } from "../single-key-shortcuts";
import { useSingleKeyShortcuts } from "../use-single-key-shortcuts";

export default function SelectedRibbon({ selected, now, selectedIds, focusAgent, clearSelection }: {
  /** The primary selection, which is the one the ribbon names. */
  selected: AgentNodeData;
  now: number;
  /** Every selected id, so the ribbon can say how many more there are. */
  selectedIds: ReadonlySet<string>;
  focusAgent: (id: string) => void;
  clearSelection: () => void;
}) {
  const singleKeys = useSingleKeyShortcuts();
  const c = agentCost(selected);
  const elapsedSec = Math.max(0, ((selected.endedAt ?? now) - selected.startedAt) / 1000);
  // Not for a session the deck joined late, the rule the card has kept since
  // #822 (card-cost.ts): its cost is the whole session's and its clock only the
  // part this page saw, so the quotient overstated the burn — "$105/min"
  // sixteen seconds after joining a session hours old.
  const rate = selected.state === "active" && !selected.synthetic ? fmtCostRate(c.total, elapsedSec) : null;
  const extra = selectedIds.size - 1;
  return (
    <button
      type="button"
      className="selected-ribbon"
      /* The cost rides in the title as well as in the chip, because the
         chip drops it where the bar is short (see WHERE THE MONTH GIVES
         WAY in styles.css) and a hover should still find it there. */
      title={`${withKey(`Zoom to ${selected.label} and its session`, "Z", singleKeys)}${
        c.total > 0 ? `\n${fmtCost(c.total)} spent${rate ? ` · ${rate}` : ""}` : ""}`}
      onClick={() => { try { focusAgent(selected.id); } catch {} }}
    >
      <span className={`state-pill state-${selected.state}`}>
        {selected.state === "active" ? "live" : selected.state}
      </span>
      <span className="selected-label">{selected.label}</span>
      {c.total > 0 && <span className="selected-cost">{fmtCost(c.total)}{rate ? <span className="selected-rate"> · {rate}</span> : null}</span>}
      {extra > 0 && <span className="selected-extra">+{extra}</span>}
      {/* A mouse shortcut, not a control. It sits inside the ribbon's
          own <button>, so it can never be a button itself — nesting one
          is invalid, and it carried no tabIndex, which left a
          role="button" labelled "Deselect" that no keyboard could ever
          reach or operate. The keyboard has the same verb on Escape
          from anywhere on the page, so the honest markup is decoration
          with a click on it. */}
      <span
        aria-hidden
        className="selected-close"
        onClick={(e) => { e.stopPropagation(); clearSelection(); }}
      >×</span>
    </button>
  );
}
