import { cloneElement, useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { placePopover } from "../popover-place";
import { modalStack } from "../modal-dismiss";

const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;
const HINT_OPEN = "ccdeck:account-hint";

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
  const show = () => {
    clear();
    if (disabled) return;
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
      const anchor = document.getElementById(children.props.id ?? "");
      if (!el || !anchor) return;
      const rect = anchor.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= innerHeight) { setVisible(false); return; }
      el.style.maxHeight = "";
      const size = { width: el.offsetWidth, height: el.offsetHeight };
      const viewport = { width: innerWidth, height: innerHeight };
      // Icon hints open vertically so adjacent Home/share controls stay clear.
      const p = placePopover(rect, size, viewport);
      el.style.left = `${p.left}px`;
      el.style.top = `${p.top}px`;
      el.style.maxHeight = p.maxHeight == null ? "" : `${p.maxHeight}px`;
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!surface.current?.contains(target) && !document.getElementById(children.props.id ?? "")?.contains(target)) setVisible(false);
    };
    // Scrolling dismisses a hint, including scrolling a nested account list.
    const scroll = (event: Event) => {
      if (!surface.current?.contains(event.target as Node)) setVisible(false);
    };
    const another = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) setVisible(false);
    };
    place();
    // Use the app's dismissal stack without taking focus or trapping Tab.
    const unregister = modalStack.push(() => setVisible(false), 0, "popover");
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
