import { useState, type ButtonHTMLAttributes } from 'react';
import { operationDescription, operationFallback, operationPurposeNote } from '../operation-glossary';
import { useMediaQuery } from '../use-media-query';
import { useHint, type HintSide } from './use-hint';

/** Existing chrome hint supplies mouse/focus education; touch opens the same inspector. */
export default function ToolAuditOperationButton({ operation, measurementHint, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { operation: string; measurementHint?: string }) {
  const mobile = useMediaQuery('(max-width: 700px)');
  const [side, setSide] = useState<HintSide>('below');
  const hint = useHint(side, 'dialog', { followFocusedAnchor: true });
  const entry = operationDescription(operation);
  const purpose = entry?.purpose ?? operationFallback(operation);
  const bind = hint.bind({ label: operation, detail: `${purpose} ${measurementHint ?? ''} ${operationPurposeNote}` });
  const place = (el: HTMLElement) => setSide(el.getBoundingClientRect().top > window.innerHeight / 2 ? 'above' : 'below');
  return <><button {...props} title={undefined} aria-haspopup={mobile ? props['aria-haspopup'] : undefined}
    aria-label={entry ? props['aria-label'] : `${props['aria-label'] ?? operation}. ${purpose} ${operationPurposeNote}`}
    onPointerEnter={event => { place(event.currentTarget); bind.onPointerEnter(event); }} onPointerLeave={bind.onPointerLeave} onPointerDown={bind.onPointerDown}
    onFocus={event => { place(event.currentTarget); bind.onFocus(event); }} onBlur={bind.onBlur} />{hint.node}</>;
}
