import { useState } from "react";
import AnchoredPopover from "./AnchoredPopover";
import { type TelemetryLine } from "../org-telemetry";
import AccountHint from "./AccountHint";
import { useT } from "../i18n";

/** A persistent privacy indicator; its full explanation also works on touch. */
export default function AccountTelemetry({ num, name, telemetry, boundaryId = "ap-scroll" }: {
  num: number; name: string; telemetry: TelemetryLine; boundaryId?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const anchor = `ap-telemetry-mark-${num}`;
  const popover = `ap-telemetry-pop-${num}`;
  return <>
    <AccountHint detail={telemetry.detail} disabled={open}>
      <button type="button" id={anchor} className="ap-more ap-telemetry" data-tone={telemetry.tone}
        title={telemetry.detail} aria-label={t("accounts.telemetry.label", { name })}
        aria-describedby={`ap-telemetry-${num}`} aria-haspopup="dialog" aria-expanded={open}
        aria-controls={open ? popover : undefined} onClick={() => setOpen(value => !value)}>
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor"
          strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M7 1.5 11.5 3v3.4c0 2.7-1.8 4.8-4.5 6.1-2.7-1.3-4.5-3.4-4.5-6.1V3Z" />
          <path d="M7 4.4v3M7 9.3v.05" />
        </svg>
      </button>
    </AccountHint>
    <span className="vis-hidden" id={`ap-telemetry-${num}`}>{telemetry.detail}</span>
    {open && <AnchoredPopover anchorId={anchor} boundaryId={boundaryId} id={popover}
      className="ap-pop ap-issue-pop ap-telemetry-pop" role="dialog" labelledBy={`${popover}-title`}
      onClose={() => setOpen(false)}>
      <div className="ap-pop-form">
        <p className="ap-pop-title" id={`${popover}-title`}>{t("accounts.telemetry.title")}</p>
        <p className="ap-pop-note">{telemetry.detail}</p>
        <div className="ap-pop-actions">
          <button type="button" className="btn" onClick={() => setOpen(false)}>{t("accounts.done")}</button>
        </div>
      </div>
    </AnchoredPopover>}
  </>;
}
