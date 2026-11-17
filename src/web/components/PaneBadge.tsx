import { useT } from "../i18n";
import type { PaneLink } from "../workspace-split";

/** A shared reference, not a button or a claim that this pane owns the keyboard. */
export default function PaneBadge({ pane }: { pane: PaneLink }) {
  const t = useT();
  const label = t(pane.active ? "board.stage.split.activePane" : "board.stage.split.paneNumber", { number: pane.number });
  return <span className="pane-badge" data-active={pane.active || undefined} title={label}>
    <span className="vis-hidden">{label}</span><span aria-hidden="true">{pane.number}</span>
  </span>;
}
