import { useState, type ButtonHTMLAttributes } from 'react';
import { operationDescription, operationPurposeNote } from '../operation-glossary';
import { useHint, type HintSide } from './use-hint';

/** Existing chrome hint supplies mouse/focus education; touch opens the same inspector. */
export default function ToolAuditOperationButton({ operation, measurementHint, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { operation: string; measurementHint?: string }) {
  const [side, setSide] = useState<HintSide>('below');
  const hint = useHint(side, 'dialog', { followFocusedAnchor: true });
  const entry = operationDescription(operation);
  const bind = hint.bind(entry ? { label: operation, detail: `${entry.purpose} ${measurementHint ?? ''} ${operationPurposeNote}` } : null);
  const place = (el: HTMLElement) => setSide(el.getBoundingClientRect().top > window.innerHeight / 2 ? 'above' : 'below');
  return <><button {...props} title={entry ? undefined : props.title}
    onPointerEnter={event => { place(event.currentTarget); bind.onPointerEnter(event); }} onPointerLeave={bind.onPointerLeave} onPointerDown={bind.onPointerDown}
    onFocus={event => { place(event.currentTarget); bind.onFocus(event); }} onBlur={bind.onBlur} />{hint.node}</>;
}
