import { cloneElement, useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { placeBeside, placePopover } from "../popover-place";

const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Non-modal account hints reuse the panel's hover surface and placement. */
export default function AccountHint({ children, detail, disabled = false }: {
  children: ReactElement<HTMLAttributes<HTMLElement>>;
  detail: string;
  disabled?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const timer = useRef(0);
  const surface = useRef<HTMLDivElement>(null);
  const id = `${children.props.id}-hint`;
  const clear = () => window.clearTimeout(timer.current);
  const hide = () => { clear(); setVisible(false); };
  const show = () => { clear(); if (!disabled) setVisible(true); };
  const leave = () => { clear(); timer.current = window.setTimeout(() => setVisible(false), 140); };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => { if (disabled) { window.clearTimeout(timer.current); setVisible(false); } }, [disabled]);
  useBeforePaint(() => {
    if (!visible || disabled) return;
    const place = () => {
      const el = surface.current;
      const anchor = document.getElementById(children.props.id ?? "");
      if (!el || !anchor) return;
      const rect = anchor.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= innerHeight) { setVisible(false); return; }
      el.style.maxHeight = "";
      const size = { width: el.offsetWidth, height: el.offsetHeight };
      const viewport = { width: innerWidth, height: innerHeight };
      const beside = placeBeside(rect, size, viewport);
      // A clamped side placement can cover the icon on a phone. A focus
      // hint must never intercept the click that follows that focus.
      const coversAnchor = beside.left < rect.right && beside.left + size.width > rect.left
        && beside.top < rect.bottom && beside.top + size.height > rect.top;
      const p = coversAnchor ? placePopover(rect, size, viewport) : beside;
      el.style.left = `${p.left}px`;
      el.style.top = `${p.top}px`;
      el.style.maxHeight = p.maxHeight == null ? "" : `${p.maxHeight}px`;
    };
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); setVisible(false);
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!surface.current?.contains(target) && !document.getElementById(children.props.id ?? "")?.contains(target)) setVisible(false);
    };
    // Scrolling dismisses a hint, including scrolling a nested account list.
    const scroll = () => setVisible(false);
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", scroll, true);
    document.addEventListener("keydown", dismiss, true);
    document.addEventListener("pointerdown", outside, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", scroll, true);
      document.removeEventListener("keydown", dismiss, true);
      document.removeEventListener("pointerdown", outside, true);
    };
  }, [visible, disabled, children.props.id, detail]);
  return <>
    {cloneElement(children, {
      title: undefined,
      tabIndex: children.props.tabIndex ?? 0,
      "aria-describedby": children.props["aria-describedby"] ?? (visible && !disabled ? id : undefined),
      onPointerEnter: event => {
        children.props.onPointerEnter?.(event);
        if (event.pointerType !== "mouse") return;
        clear(); timer.current = window.setTimeout(show, 300);
      },
      onPointerLeave: event => { children.props.onPointerLeave?.(event); leave(); },
      onFocus: event => { children.props.onFocus?.(event); show(); },
      onBlur: event => { children.props.onBlur?.(event); hide(); },
      onClick: event => { hide(); children.props.onClick?.(event); },
    })}
    {visible && !disabled && createPortal(
      <div ref={surface} id={id} className="ap-peek ap-account-hint" role="tooltip"
        onPointerEnter={clear} onPointerLeave={leave}>
        {detail}
      </div>, document.body)}
  </>;
}
