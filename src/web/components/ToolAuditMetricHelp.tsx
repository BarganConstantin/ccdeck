import { useId, useRef, useState } from 'react';
import AnchoredPopover from './AnchoredPopover';
import { auditExplanations } from '../tool-audit-education';
export default function ToolAuditMetricHelp() {
  const id = useId().replace(/:/g, ''); const [open, setOpen] = useState(false); const [keyboard, setKeyboard] = useState(false); const headingRef = useRef<HTMLHeadingElement>(null);
  return <><button type="button" id={`ta-help-${id}`} className="ta-help-trigger" aria-label="Explain Median and P95" aria-expanded={open} aria-controls={open ? `ta-help-popover-${id}` : undefined} aria-haspopup="dialog" onClick={event => { setKeyboard(event.detail === 0); setOpen(value => !value); }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v1" /></svg></button>
    {open && <AnchoredPopover anchorId={`ta-help-${id}`} id={`ta-help-popover-${id}`} className={`ta-education-popover${keyboard ? ' ta-education-instant' : ''}`} focusRef={headingRef} layer={1103} role="dialog" labelledBy={`ta-help-heading-${id}`} onClose={() => setOpen(false)}>
      <h4 ref={headingRef} tabIndex={-1} id={`ta-help-heading-${id}`}>Reading Median & P95</h4><dl><dt>Median</dt><dd>{auditExplanations.median}</dd><dt>P95</dt><dd>{auditExplanations.p95}</dd></dl><p>{auditExplanations.sample}</p><p>{auditExplanations.intervals}</p><button type="button" className="ta-text-button" onClick={() => { document.getElementById(`ta-help-${id}`)?.focus({ preventScroll: true }); setOpen(false); }}>Got it</button>
    </AnchoredPopover>}
  </>;
}
