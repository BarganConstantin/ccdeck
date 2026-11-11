// The header of a panel the Inspector folded on the Board (inspector-fold.ts):
// one button the width of the header, with the title, one line of the panel's
// readings and a chevron, that opens the panel again. A heading holds the
// button, as a disclosure's does, so the panel keeps its heading.
import type { MouseEvent } from "react";
import { useT, type TFunction } from "../i18n";
import type { QuotaData } from "../use-quota";
import { KitIcon } from "./kit-icons";
import { quotaPctText } from "./QuotaBar";

/** Usage's line while folded: what Claude's two windows have used, printed as
 *  the bars print it ("5h 14% · 7d 40%"), or null with no 5-hour reading. */
export function quotaFoldLine(quota: QuotaData | null | undefined, t: TFunction): string | null {
  if (!quota?.ok || quota.session5hPct == null) return null;
  const pct = (v: number) => quotaPctText(Math.min(100, Math.max(0, v)));
  return quota.week7dPct != null
    ? t("shell.side.quotaSum", { five: pct(quota.session5hPct), week: pct(quota.week7dPct) })
    : t("shell.side.quota5h", { five: pct(quota.session5hPct) });
}

export default function PanelFoldHead({ title, titleId, summary, headingClass, onOpen }: {
  title: string;
  /** The id the panel's landmark is named by, on the title alone. */
  titleId?: string;
  /** One line of the readings, or nothing while there is none. */
  summary?: string | null;
  headingClass?: string;
  onOpen: () => void;
}) {
  const t = useT();
  const open = (event: MouseEvent<HTMLButtonElement>) => {
    const panel = event.currentTarget.closest("aside");
    onOpen();
    // The button goes with the fold: the keys go on to the open panel's close.
    requestAnimationFrame(() => panel?.querySelector<HTMLElement>(".up-close, .sd-close")?.focus());
  };
  return (
    <h2 className={headingClass}>
      <button type="button" className="fold-head" aria-expanded={false} onClick={open} title={t("shell.side.unfold")}>
        <span className="fold-title" id={titleId}>{title}</span>
        {summary && <span className="side-sum">{summary}</span>}
        <KitIcon name="chevron-right" />
      </button>
    </h2>
  );
}
