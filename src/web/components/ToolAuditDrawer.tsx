import { useEffect, useLayoutEffect, useRef, type ComponentProps } from 'react';
import { createPortal } from 'react-dom';
import ToolAuditInspector from './ToolAuditInspector';
import { useModalDismiss, useScrimDismiss } from './use-modal-dismiss';
import { useMediaQuery } from '../use-media-query';
import { modalStack } from '../modal-dismiss';

type Props = ComponentProps<typeof ToolAuditInspector> & { keyboard: boolean };

function MobileInspector({ keyboard, ...props }: Props) {
  const headingRef = useRef<HTMLElement | null>(null);
  const dialogRef = useModalDismiss(props.onClose, { focusRef: headingRef });
  const scrim = useScrimDismiss(props.onClose);
  useEffect(() => {
    headingRef.current = dialogRef.current?.querySelector('#tool-operation-heading') ?? null;
    headingRef.current?.focus({ preventScroll: true });
  }, [dialogRef]);
  return createPortal(<div className="ta-drawer-backdrop" role="presentation" {...scrim}>
    <div className="ta-drawer" data-keyboard={keyboard || undefined} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="tool-operation-heading"><ToolAuditInspector {...props} /></div>
  </div>, document.body);
}

function IntegratedInspector({ keyboard, ...props }: Props) {
  const root = useRef<HTMLElement>(null);
  const close = useRef(props.onClose); close.current = props.onClose;
  useEffect(() => modalStack.push(() => close.current(), 0, 'popover'), []);
  useLayoutEffect(() => {
    if (root.current) root.current.scrollTop = 0;
    if (document.activeElement === document.body || keyboard && document.activeElement instanceof HTMLElement && document.activeElement.dataset.operation === props.row.operation) root.current?.querySelector<HTMLElement>('#tool-operation-heading')?.focus({ preventScroll: true });
  }, [props.row.operation, keyboard]);
  useLayoutEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const content = root.current?.querySelector<HTMLElement>('.ta-inspector');
    const motion = content?.animate?.([{ opacity: 0.65, transform: 'translateX(6px)' }, { opacity: 1, transform: 'translateX(0)' }], {
      duration: 140, easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
    });
    return () => motion?.cancel();
  }, [props.row.operation]);
  // No local Tab trap: report and evidence form one keyboard workspace.
  return <aside ref={root} className="ta-drawer ta-integrated-inspector" data-keyboard={keyboard || undefined} aria-labelledby="tool-operation-heading"><ToolAuditInspector {...props} /></aside>;
}

export default function ToolAuditDrawer(props: Props) {
  const mobile = useMediaQuery('(max-width: 700px)');
  return mobile ? <MobileInspector {...props} /> : <IntegratedInspector {...props} />;
}
