import { useState } from "react";
import AnchoredPopover from "./AnchoredPopover";
import { WarnGlyph } from "./AccountIssuePopover";
import { type TelemetryLine } from "../org-telemetry";
import AccountHint from "./AccountHint";

/** A persistent privacy indicator; its full explanation also works on touch. */
export default function AccountTelemetry({ num, name, telemetry, boundaryId = "ap-scroll" }: {
  num: number; name: string; telemetry: TelemetryLine; boundaryId?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchor = `ap-telemetry-mark-${num}`;
  const popover = `ap-telemetry-pop-${num}`;
  return <>
    <AccountHint detail={telemetry.detail} disabled={open}>
      <button type="button" id={anchor} className="ap-more ap-telemetry" data-tone={telemetry.tone}
        title={telemetry.detail} aria-label={`Organization telemetry for ${name}`}
        aria-describedby={`ap-telemetry-${num}`} aria-haspopup="dialog" aria-expanded={open}
        aria-controls={open ? popover : undefined} onClick={() => setOpen(value => !value)}>
        <WarnGlyph />
      </button>
    </AccountHint>
    <span className="vis-hidden" id={`ap-telemetry-${num}`}>{telemetry.detail}</span>
    {open && <AnchoredPopover anchorId={anchor} boundaryId={boundaryId} id={popover}
      className="ap-pop ap-issue-pop ap-telemetry-pop" role="dialog" labelledBy={`${popover}-title`}
      onClose={() => setOpen(false)}>
      <div className="ap-pop-form">
        <p className="ap-pop-title" id={`${popover}-title`}>Organization telemetry</p>
        <p className="ap-pop-note">{telemetry.detail}</p>
        <div className="ap-pop-actions">
          <button type="button" className="btn" onClick={() => setOpen(false)}>Done</button>
        </div>
      </div>
    </AnchoredPopover>}
  </>;
}
