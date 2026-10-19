import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useModalDismiss, useScrimDismiss } from './use-modal-dismiss';
import { useMediaQuery } from '../use-media-query';
import { modalStack } from '../modal-dismiss';

/** The details of one row, a tool's or a skill's: `itemKey` names the row, and
 *  `children` is its inspector, whose heading is #tool-operation-heading. */
type Props = { keyboard: boolean; itemKey: string; onClose: () => void; children: ReactNode };

function MobileInspector({ keyboard, onClose, children }: Props) {
  const headingRef = useRef<HTMLElement | null>(null);
  const dialogRef = useModalDismiss(onClose, { focusRef: headingRef });
  const scrim = useScrimDismiss(onClose);
  useEffect(() => {
    headingRef.current = dialogRef.current?.querySelector('#tool-operation-heading') ?? null;
    headingRef.current?.focus({ preventScroll: true });
  }, [dialogRef]);
  return createPortal(<div className="ta-drawer-backdrop" role="presentation" {...scrim}>
    <div className="ta-drawer" data-keyboard={keyboard || undefined} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="tool-operation-heading">{children}</div>
  </div>, document.body);
}

function IntegratedInspector({ keyboard, itemKey, onClose, children }: Props) {
  const root = useRef<HTMLElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => modalStack.push(() => close.current(), 0, 'popover'), []);
  useLayoutEffect(() => {
    if (root.current) root.current.scrollTop = 0;
    const active = document.activeElement;
    if (active === document.body || keyboard && active instanceof HTMLElement && (active.dataset.operation ?? active.dataset.skill) === itemKey) root.current?.querySelector<HTMLElement>('#tool-operation-heading')?.focus({ preventScroll: true });
  }, [itemKey, keyboard]);
  useLayoutEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const content = root.current?.querySelector<HTMLElement>('.ta-inspector');
    const motion = content?.animate?.([{ opacity: 0.65, transform: 'translateX(6px)' }, { opacity: 1, transform: 'translateX(0)' }], {
      duration: 140, easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
    });
    return () => motion?.cancel();
  }, [itemKey]);
  // No local Tab trap: report and evidence form one keyboard workspace.
  return <aside ref={root} className="ta-drawer ta-integrated-inspector" data-keyboard={keyboard || undefined} aria-labelledby="tool-operation-heading">{children}</aside>;
}

export default function ToolAuditDrawer(props: Props) {
  const mobile = useMediaQuery('(max-width: 700px)');
  return mobile ? <MobileInspector {...props} /> : <IntegratedInspector {...props} />;
}
