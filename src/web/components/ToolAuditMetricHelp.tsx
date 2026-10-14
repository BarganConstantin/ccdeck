import { useId, useRef, useState, type ReactNode } from 'react';
import AnchoredPopover from './AnchoredPopover';
import { auditExplanations } from '../tool-audit-education';

type HelpKind = 'intervals' | 'timing' | 'cumulative' | 'failures' | 'coverage' | 'freshness';
const help: Record<HelpKind, { label: string; title: string; paragraphs: readonly string[] }> = {
  intervals: { label: 'Explain observed call intervals', title: 'Reading observed intervals', paragraphs: [auditExplanations.sample, auditExplanations.intervals] },
  timing: { label: 'Explain Median and P95', title: 'Reading Median & P95', paragraphs: [auditExplanations.p95Example, auditExplanations.sample, auditExplanations.intervals] },
  cumulative: { label: 'Explain cumulative intervals', title: 'Cumulative measured intervals', paragraphs: [auditExplanations.cumulative, auditExplanations.intervals] },
  failures: { label: 'Explain reported failures', title: 'Reported failures', paragraphs: [auditExplanations.failures, auditExplanations.failureRate] },
  coverage: { label: 'Explain timing coverage', title: 'Timing coverage', paragraphs: [auditExplanations.coverage, 'One call can contain several operations. Operation counts cannot be added together.'] },
  freshness: { label: 'Explain snapshot and data freshness', title: 'Snapshot & observed activity', paragraphs: [auditExplanations.freshness] },
};

/** Interactive education uses a dialog; focus never moves into an operation hint. */
export default function ToolAuditMetricHelp({ kind = 'timing', children }: { kind?: HelpKind; children?: ReactNode }) {
  const id = useId().replace(/:/g, '');
  const [open, setOpen] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const content = help[kind];
  return <><button type="button" id={`ta-help-${id}`} className={children ? 'ta-help-label' : 'ta-help-trigger'} aria-label={content.label} aria-expanded={open} aria-controls={open ? `ta-help-popover-${id}` : undefined} aria-haspopup="dialog" onClick={event => { setKeyboard(event.detail === 0); setOpen(value => !value); }}>{children ?? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v1" /></svg>}</button>
    {open && <AnchoredPopover anchorId={`ta-help-${id}`} id={`ta-help-popover-${id}`} className={`ta-education-popover${keyboard ? ' ta-education-instant' : ''}`} focusRef={headingRef} layer={1103} role="dialog" labelledBy={`ta-help-heading-${id}`} onClose={() => setOpen(false)}>
      <h4 ref={headingRef} tabIndex={-1} id={`ta-help-heading-${id}`}>{content.title}</h4>
      {(kind === 'timing' || kind === 'intervals') && <dl>{kind === 'intervals' && <><dt>Average</dt><dd>Adds valid measured intervals and divides by their count. Missing timing is excluded.</dd></>}<dt>Median</dt><dd>{auditExplanations.median}</dd><dt>P95</dt><dd>{auditExplanations.p95}</dd>{kind === 'intervals' && <><dt>Maximum</dt><dd>The longest valid observed containing-call interval.</dd></>}</dl>}
      {content.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
      <button type="button" className="ta-text-button" onClick={() => { document.getElementById(`ta-help-${id}`)?.focus({ preventScroll: true }); setOpen(false); }}>Got it</button>
    </AnchoredPopover>}
  </>;
}
