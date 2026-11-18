import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/** The selected segment of a group: what the sliding thumb sits under. */
const SELECTED = '[aria-checked="true"], [aria-pressed="true"], [aria-selected="true"]';

/** Puts the thumb of V4's segmented control (styles/segmented.css) under the
 *  selected segment of `group`: writes --thumb-x, --thumb-y, --thumb-w and --thumb-h on it after every
 *  render. Each first placement (the mount, or a selection that comes back after
 *  there was none) is data-thumb="set" (no transition, so it never slides in);
 *  the next frame turns it "live" and later changes move. */
export function useSegmentThumb(group: RefObject<HTMLElement | null>) {
  const frame = useRef(0);
  const place = () => {
    const el = group.current;
    if (!el) return;
    const on = el.querySelector<HTMLElement>(SELECTED);
    if (!on) { el.removeAttribute("data-thumb"); return; }
    el.style.setProperty("--thumb-x", `${on.offsetLeft}px`);
    el.style.setProperty("--thumb-w", `${on.offsetWidth}px`);
    el.style.setProperty("--thumb-y", `${on.offsetTop}px`);
    el.style.setProperty("--thumb-h", `${on.offsetHeight}px`);
    if (el.hasAttribute("data-thumb")) return;
    el.setAttribute("data-thumb", "set");
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => { if (el.getAttribute("data-thumb") === "set") el.setAttribute("data-thumb", "live"); });
  };
  useLayoutEffect(place);
  useEffect(() => {
    const el = group.current;
    if (!el) return;
    const watch = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    watch?.observe(el);
    return () => { cancelAnimationFrame(frame.current); watch?.disconnect(); };
  }, []);
}
