// The header of a panel the Inspector folded on the Board (inspector-fold.ts):
// one row at the top of the right column, a button the width of the column
// with the title, one line of the panel's figures and a chevron pointing down,
// the way the panel opens: in place, above the Inspector. Opened there, the
// title is the same button with the chevron turned up, and a press folds the
// panel back to its row. A heading holds the button, as a disclosure's does,
// so the panel keeps its heading.
import type { MouseEvent } from "react";
import { useT, type TFunction } from "../i18n";
import type { QuotaData } from "../use-quota";
import { KitIcon } from "./kit-icons";
import { quotaPctText } from "./QuotaBar";

/** Usage's line while folded: what Claude's two windows have used, with the
 *  bars' percentages ("5h 14% · 7d 40%"), or null with no 5-hour reading. */
export function quotaFoldLine(quota: QuotaData | null | undefined, t: TFunction): string | null {
  if (!quota?.ok || quota.session5hPct == null) return null;
  const pct = (v: number) => quotaPctText(Math.min(100, Math.max(0, v)));
  return quota.week7dPct != null
    ? t("shell.side.quotaSum", { five: pct(quota.session5hPct), week: pct(quota.week7dPct) })
    : t("shell.side.quota5h", { five: pct(quota.session5hPct) });
}

export default function PanelFoldHead({ title, titleId, summary, headingClass, open = false, onToggle }: {
  title: string;
  /** The id the panel's landmark is named by, on the title alone. */
  titleId?: string;
  /** One line of the readings while folded, or nothing while there is none. */
  summary?: string | null;
  headingClass?: string;
  /** Opened in place beside the Inspector: the chevron points up and folds it back. */
  open?: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    const panel = event.currentTarget.closest("aside");
    onToggle();
    // The button goes with the change: the keys go on to the open panel's
    // close, or to the row it folded back to.
    requestAnimationFrame(() => panel?.querySelector<HTMLElement>(open ? ".fold-head" : ".up-close, .sd-close")?.focus());
  };
  return (
    <h2 className={headingClass ? `${headingClass} fold-row` : "fold-row"}>
      <button type="button" className="fold-head" aria-expanded={open} onClick={toggle}
        title={open ? t("shell.side.fold") : t("shell.side.unfold")}>
        <span className="fold-title" id={titleId}>{title}</span>
        {!open && summary && <span className="side-sum">{summary}</span>}
        <KitIcon name="chevron-down" />
      </button>
    </h2>
  );
}
