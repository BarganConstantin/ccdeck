// The one dialog shell, and the one place a dialog gets to leave.
//
// Thirty-three files used to spell the same scrim, surface and header, and each
// mount site spelled `{open && <Modal/>}`, so a dialog that was closed with the
// pointer was removed from the DOM on the next frame: no fade, no scale, no
// Exit 150. Two parts fix that together.
//
//   DialogPresence  wraps a mount site. It keeps the last rendered dialog
//                   drawn, flagged as closing, for --dur-exit, and clears the
//                   flag on the same node if the dialog is asked for again.
//   Dialog          is the markup every dialog repeats: the scrim (pressing it
//                   dismisses), the surface with role="dialog", and
//                   data-state on the scrim, which the CSS answers with
//                   transitions.
//
// The closing dialog must not hold anything: useModalDismiss reads the same
// context and, the moment close starts, pops its stack entry, hands focus back
// and stops trapping Tab, and the shell makes the leaving node inert and
// pointer-transparent so a click lands on what is under it.
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type HTMLAttributes, type ReactNode, type Ref, type TransitionEvent,
} from "react";
import {
  EXIT_SLACK_MS, finish, isDrawn, lastInputWasKey, settle, startPresence, type Presence,
} from "../dialog-presence";
import { tokenMs } from "../rail-motion";
import { KitIcon } from "./kit-icons";
import type { useScrimDismiss } from "./use-modal-dismiss";

interface PresenceValue {
  /** The dialog is leaving: it holds no focus, Tab, Escape or pointer input. */
  closing: boolean;
  /** The scrim's exit transition ended: unmount now rather than at the timer. */
  exited: () => void;
}

const NOT_LEAVING: PresenceValue = { closing: false, exited: () => {} };
const PresenceContext = createContext<PresenceValue>(NOT_LEAVING);

/** Whether the dialog this component is inside is on its way out. */
export function useDialogClosing(): boolean {
  return useContext(PresenceContext).closing;
}

type Truthy<T> = Exclude<T, false | null | undefined | 0 | "">;

interface PresenceProps<T> {
  /** The owner's state: a flag, or the value the dialog is opened on (a tool, a
   *  session id). Truthy means open. */
  when: T;
  /** Called only while `when` is truthy, with it. The last element it returned stays on
   *  screen while the dialog leaves, so a dialog whose props come from state
   *  that is cleared on close keeps showing its last props. A lazy dialog's
   *  Suspense goes inside this, so the closing node stays. */
  children: (value: Truthy<T>) => ReactNode;
}

export function DialogPresence<T>({ when, children }: PresenceProps<T>) {
  const last = useRef<ReactNode>(null);
  const open = Boolean(when);
  if (open) last.current = children(when as Truthy<T>);
  const [p, setP] = useState<Presence>(() => startPresence(open));
  const next = settle(p, open, {
    instant: typeof document !== "undefined" && lastInputWasKey(document.documentElement),
    hasContent: last.current != null,
  });
  if (next !== p) setP(next);
  // A presence inside another (the capacity dialog waits for its roster inside
  // the one App mounts) is closing when either is, and its end ends both.
  const parent = useContext(PresenceContext);
  const own = next.closing;
  const closing = own || parent.closing;
  const parentExited = parent.exited;
  const exited = useCallback(() => { setP(finish); parentExited(); }, [parentExited]);

  useEffect(() => {
    if (!own) return;
    const id = window.setTimeout(exited, tokenMs("--dur-exit") + EXIT_SLACK_MS);
    return () => window.clearTimeout(id);
  }, [own, exited]);

  const value = useMemo<PresenceValue>(() => ({ closing, exited }), [closing, exited]);
  if (!isDrawn(next)) return null;
  return <PresenceContext.Provider value={value}>{last.current}</PresenceContext.Provider>;
}

type ScrimHandlers = ReturnType<typeof useScrimDismiss>;

export interface DialogProps extends Omit<HTMLAttributes<HTMLDivElement>, "role" | "className" | "children"> {
  /** `useScrimDismiss(close)`. */
  scrim: ScrimHandlers;
  /** `useModalDismiss(...)`: the ref the surface must carry. */
  dialogRef: Ref<HTMLDivElement>;
  /** Classes after `modal` on the surface: its size and its own name. */
  className?: string;
  /** The id of the element that names the dialog. */
  labelledBy?: string;
  /** Extra classes on the scrim (a dialog that dresses it, like the radio). */
  backdropClassName?: string;
  /** Extra attributes on the scrim: drag handlers, a data flag. */
  backdropProps?: HTMLAttributes<HTMLDivElement> & { [key: `data-${string}`]: string | boolean | undefined };
  children: ReactNode;
}

/** The scrim alone: what Dialog draws around its surface, for a dialog whose
 *  surface is its own (the radio's panel carries its own role=dialog). */
export function DialogScrim({
  scrim, className, backdropProps, children,
}: {
  scrim: ScrimHandlers;
  className?: string;
  backdropProps?: DialogProps["backdropProps"];
  children: ReactNode;
}) {
  const { closing, exited } = useContext(PresenceContext);
  const onTransitionEnd = (e: TransitionEvent<HTMLDivElement>) => {
    backdropProps?.onTransitionEnd?.(e);
    if (closing && e.target === e.currentTarget && e.propertyName === "opacity") exited();
  };
  // `inert` is not in React 18's attribute types; it is a plain attribute.
  const inert = closing ? { inert: "" } : {};
  return (
    <div
      {...backdropProps}
      className={className ? `modal-backdrop ${className}` : "modal-backdrop"}
      role="presentation"
      data-state={closing ? "closing" : "open"}
      {...scrim}
      {...inert}
      onTransitionEnd={onTransitionEnd}
    >
      {children}
    </div>
  );
}

/** The scrim and the surface of one dialog. Everything else in `rest` lands on
 *  the surface (an id, a style, a data flag, a keydown handler). */
export function Dialog({
  scrim, dialogRef, className, labelledBy, backdropClassName, backdropProps, children, ...rest
}: DialogProps) {
  return (
    <DialogScrim scrim={scrim} className={backdropClassName} backdropProps={backdropProps}>
      <div
        {...rest}
        ref={dialogRef}
        className={className ? `modal ${className}` : "modal"}
        onClick={e => { e.stopPropagation(); rest.onClick?.(e); }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
      >
        {children}
      </div>
    </DialogScrim>
  );
}

/** The × of a dialog header: the kit's 28 icon button (dialogs.css gives
 *  `.modal-actions .glyph-btn` its size and radius) with the kit's Close icon,
 *  14 at a 1.5 stroke in --muted, as the banners draw theirs. */
export function DialogClose({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" className="glyph-btn" onClick={onClick} aria-label={label} title={label}><KitIcon name="close" /></button>
  );
}

interface HeaderProps {
  /** The title element's id, for the dialog's aria-labelledby. */
  titleId: string;
  /** The title text. */
  title: ReactNode;
  /** A muted note beside the title. */
  note?: ReactNode;
  /** Buttons before the ×. */
  actions?: ReactNode;
  onClose: () => void;
  closeLabel: string;
}

/** The one dialog header: title left, note beside it, actions and × right.
 *  A dialog with a header of its own composes `DialogClose` instead. */
export function DialogHeader({ titleId, title, note, actions, onClose, closeLabel }: HeaderProps) {
  return (
    <header className="modal-head">
      <div className="modal-title">
        <h2 id={titleId}>{title}</h2>
        {note != null && <span className="modal-dur">{note}</span>}
      </div>
      <div className="modal-actions">
        {actions}
        <DialogClose onClick={onClose} label={closeLabel} />
      </div>
    </header>
  );
}
