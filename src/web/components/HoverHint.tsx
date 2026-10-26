import { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { placePopover, placeReadingHint } from "../popover-place";
import { modalStack } from "../modal-dismiss";

const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;
// Shared with existing account hints so only one disclosure is visible.
const HINT_OPEN = "ccdeck:account-hint";

export interface HoverHintProps {
  children: ReactElement<HTMLAttributes<HTMLElement>>;
  detail: ReactNode;
  disabled?: boolean;
  className: string;
  portalRootId?: string;
  focusDelay?: number;
  shouldShow?: (anchor: HTMLElement) => boolean;
  /** Reading previews leave the next row available; ordinary hints retain menu placement. */
  placement?: "popover" | "reading";
}

/** Showing a hint adds a description without losing the control's instructions. */
export function hintDescription(existing: string | undefined, hintId: string, visible: boolean): string | undefined {
  if (!visible) return existing;
  return [...new Set([...(existing?.split(/\s+/).filter(Boolean) ?? []), hintId])].join(" ");
}

/** A non-modal hover/focus disclosure that never takes or traps focus. */
export default function HoverHint({ children, detail, disabled = false, className, portalRootId, focusDelay = 0, shouldShow, placement = "popover" }: HoverHintProps) {
  const generatedId = useId();
  const anchorId = children.props.id ?? generatedId;
  const id = `${anchorId}-hint`;
  const [visible, setVisible] = useState(false);
  const timer = useRef(0);
  const surface = useRef<HTMLDivElement>(null);
  const latest = useRef({ disabled, shouldShow });
  latest.current = { disabled, shouldShow };
  const clear = () => window.clearTimeout(timer.current);
  const hide = () => { clear(); setVisible(false); };
  const renderedAnchor = () => {
    const anchor = document.getElementById(anchorId);
    if (!anchor || !anchor.getClientRects().length || anchor.checkVisibility?.() === false) return null;
    const rect = anchor.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) return null;
    return anchor;
  };
  const show = () => {
    clear();
    const anchor = renderedAnchor();
    if (latest.current.disabled || !anchor || latest.current.shouldShow?.(anchor) === false) return;
    document.dispatchEvent(new CustomEvent(HINT_OPEN, { detail: id }));
    setVisible(true);
  };
  const leave = () => { clear(); timer.current = window.setTimeout(() => setVisible(false), 140); };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => { if (disabled) { window.clearTimeout(timer.current); setVisible(false); } }, [disabled]);
  useBeforePaint(() => {
    if (!visible || disabled) return;
    const place = () => {
      const el = surface.current;
      const anchor = renderedAnchor();
      if (!el || !anchor || latest.current.shouldShow?.(anchor) === false) { setVisible(false); return; }
      el.style.maxHeight = "";
      const size = { width: el.offsetWidth, height: el.offsetHeight };
      const viewport = { width: innerWidth, height: innerHeight };
      const style = getComputedStyle(el);
      const number = (value: string) => Number.parseFloat(value) || 0;
      const minimumHeight = (number(style.lineHeight) || number(style.fontSize) * 1.2)
        + number(style.paddingTop) + number(style.paddingBottom) + number(style.borderTopWidth) + number(style.borderBottomWidth);
      const p = placement === "reading"
        ? placeReadingHint(anchor.getBoundingClientRect(), size, viewport, minimumHeight)
        : placePopover(anchor.getBoundingClientRect(), size, viewport);
      if (!p) { setVisible(false); return; }
      el.style.left = `${p.left}px`;
      el.style.top = `${p.top}px`;
      el.style.maxHeight = p.maxHeight == null ? "" : `${p.maxHeight}px`;
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!surface.current?.contains(target) && !document.getElementById(anchorId)?.contains(target)) hide();
    };
    const scroll = (event: Event) => {
      if (!surface.current?.contains(event.target as Node)) hide();
    };
    const another = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) hide();
    };
    place();
    const unregister = modalStack.push(hide, 0, "popover");
    window.addEventListener("resize", place);
    window.addEventListener("scroll", scroll, true);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener(HINT_OPEN, another);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", scroll, true);
      unregister();
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener(HINT_OPEN, another);
    };
  }, [visible, disabled, anchorId, detail, shouldShow, portalRootId, placement]);
  const describedBy = hintDescription(children.props["aria-describedby"], id, visible && !disabled);
  return <>
    {cloneElement(children, {
      id: anchorId,
      title: undefined,
      tabIndex: children.props.tabIndex ?? 0,
      "aria-describedby": describedBy,
      onPointerEnter: event => {
        children.props.onPointerEnter?.(event);
        if (event.pointerType !== "mouse") return;
        clear(); timer.current = window.setTimeout(show, 300);
      },
      onPointerLeave: event => { children.props.onPointerLeave?.(event); leave(); },
      onFocus: event => {
        children.props.onFocus?.(event);
        clear();
        if (focusDelay > 0) timer.current = window.setTimeout(show, focusDelay);
        else show();
      },
      onBlur: event => { children.props.onBlur?.(event); hide(); },
      onClick: event => { hide(); children.props.onClick?.(event); },
      onContextMenu: event => { hide(); children.props.onContextMenu?.(event); },
      onDragStart: event => { hide(); children.props.onDragStart?.(event); },
      onKeyDown: event => { if (event.key !== "Escape") hide(); children.props.onKeyDown?.(event); },
    })}
    {visible && !disabled && createPortal(
      <div ref={surface} id={id} className={className} role="tooltip" onPointerEnter={clear} onPointerLeave={leave}>
        {detail}
      </div>, (portalRootId ? document.getElementById(portalRootId) : null) ?? document.body)}
  </>;
}
