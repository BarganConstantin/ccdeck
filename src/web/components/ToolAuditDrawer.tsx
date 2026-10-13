import { useEffect, useRef, type ComponentProps } from 'react';
import { createPortal } from 'react-dom';
import ToolAuditInspector from './ToolAuditInspector';
import { useModalDismiss } from './use-modal-dismiss';

export default function ToolAuditDrawer({ keyboard, ...props }: ComponentProps<typeof ToolAuditInspector> & { keyboard: boolean }) {
  const closeRef = useRef<HTMLElement | null>(null);
  const dialogRef = useModalDismiss(props.onClose, { focusRef: closeRef });
  useEffect(() => {
    const root = dialogRef.current;
    closeRef.current = root?.querySelector('[aria-label="Close operation details"]') ?? null;
    (keyboard ? root?.querySelector<HTMLElement>('#tool-operation-heading') : closeRef.current)?.focus({ preventScroll: true });
  }, [keyboard, dialogRef]);
  return createPortal(<div className="ta-drawer-backdrop" onClick={event => { if (event.target === event.currentTarget) props.onClose(); }}>
    <div className="ta-drawer" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="tool-operation-heading">
      <ToolAuditInspector {...props} />
    </div>
  </div>, document.body);
}
