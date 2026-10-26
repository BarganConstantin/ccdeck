import type { HTMLAttributes, ReactElement } from "react";
import HoverHint from "./HoverHint";

interface Item {
  key: string;
  summary: string;
  fixVersions?: readonly string[];
  epic?: { key: string; name: string } | null;
}

/** A read-only full-value preview. Enter/tap still opens the native detail. */
export default function JiraRowPreview({ item, portalRootId, children }: {
  item: Item;
  portalRootId: string;
  children: ReactElement<HTMLAttributes<HTMLElement>>;
}) {
  const versions = item.fixVersions ?? [];
  const clipped = (anchor: HTMLElement) => {
    // The draggable source is the row wrapper, outside this hint's child.
    if (anchor.closest(".jr-board")?.querySelector("[data-dragging]")) return false;
    if (versions.length > 1) return true; // The row shows a compact count.
    return Array.from(anchor.querySelectorAll<HTMLElement>(".jr-key, .jr-summary, .jr-version, .jr-epic"))
      .some(el => el.getClientRects().length === 0 || el.scrollWidth > el.clientWidth + 1
        || (el.classList.contains("jr-summary") && el.scrollHeight > el.clientHeight + 2));
  };
  return <HoverHint className="jr-row-preview" portalRootId={portalRootId} placement="reading" focusDelay={250} shouldShow={clipped}
    detail={<>
      <div className="jr-preview-key">{item.key}</div>
      <div className="jr-preview-summary">{item.summary}</div>
      {(versions.length > 0 || item.epic) && <dl className="jr-preview-fields">
        {versions.length > 0 && <><dt>{versions.length === 1 ? "Version" : "Versions"}</dt><dd>{versions.join(", ")}</dd></>}
        {item.epic && <><dt>Epic</dt><dd>{item.epic.key}: {item.epic.name}</dd></>}
      </dl>}
    </>}>
    {children}
  </HoverHint>;
}
