import { useEffect, useLayoutEffect, type RefObject } from "react";

/** The selected segment of a group: what the sliding thumb sits under. */
const SELECTED = '[aria-checked="true"], [aria-pressed="true"], [aria-selected="true"]';

/** Puts the thumb of V4's segmented control (styles/segmented.css) under the
 *  selected segment of `group`: writes --thumb-x, --thumb-y, --thumb-w and --thumb-h on it after every
 *  render. The first placement is data-thumb="set" (no transition, so first
 *  paint never slides); the next frame turns it "live" and later changes move. */
export function useSegmentThumb(group: RefObject<HTMLElement | null>) {
  const place = () => {
    const el = group.current;
    if (!el) return;
    const on = el.querySelector<HTMLElement>(SELECTED);
    if (!on) { el.removeAttribute("data-thumb"); return; }
    el.style.setProperty("--thumb-x", `${on.offsetLeft}px`);
    el.style.setProperty("--thumb-w", `${on.offsetWidth}px`);
    el.style.setProperty("--thumb-y", `${on.offsetTop}px`);
    el.style.setProperty("--thumb-h", `${on.offsetHeight}px`);
    if (!el.hasAttribute("data-thumb")) el.setAttribute("data-thumb", "set");
  };
  useLayoutEffect(place);
  useEffect(() => {
    const el = group.current;
    if (!el) return;
    const frame = requestAnimationFrame(() => { if (el.getAttribute("data-thumb") === "set") el.setAttribute("data-thumb", "live"); });
    const watch = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    watch?.observe(el);
    return () => { cancelAnimationFrame(frame); watch?.disconnect(); };
  }, []);
}
