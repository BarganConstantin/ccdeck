// The phone sheet's behaviour: one at a time, Esc, and the flick (phone-sheet.ts
// has the rules, styles/phone-sheet.css the look). Only at 640 and under; with
// `phone` false the hook does nothing, so the desktop's panels are untouched.
//
// WHAT IT DOES NOT TOUCH. Each panel's open flag stays where it was (use-left-
// column.ts, use-right-panels.ts); the hook only asks for a flag to be cleared,
// through the same setter the panel's own × uses. Nothing is sent or read.
import { useCallback, useEffect, useRef } from "react";
import {
  GRAB_ZONE_PX, SHEET_CLOSE_MS, SHEET_EASE, SHEET_FADE_MS, SHEET_NAMES, SHEET_OPEN_MS,
  dragOffset, releaseCloses, sheetToKeep, type SheetFlags, type SheetName,
} from "./phone-sheet";
import { prefersReducedMotion } from "./viewport-motion";

/** Where each sheet is in the page. */
const SELECTOR: Record<SheetName, string> = {
  accounts: ".accounts-panel:not([hidden]):not(.leaving)",
  usage: ".usage-panel:not(.leaving)",
  machine: ".sysdetail:not(.leaving)",
  inspector: ".app > .detail",
};
/** Anything in a sheet that answers a press by itself keeps it: a drag only
 *  starts on the handle and on what is not a control. */
const CONTROL = "button, a, input, select, textarea, label, summary, [role='button'], [role='tab'], [role='switch'], [role='menuitem']";
/** What stands over a sheet and owns Esc while it is up. */
const OVER = ".anchored-popover, .modal-backdrop, [role='dialog'], [role='alertdialog']";

/** Nothing open: where the hook starts, never written to. */
const ALL_CLOSED: SheetFlags = { accounts: false, usage: false, machine: false, inspector: false };

export interface PhoneSheets {
  /** The sheet on screen, if any. */
  sheet: SheetName | null;
  /** Closes it the way a flick would: it goes back down the way it came. */
  closeSheet: () => void;
}

/** The sheet's element, or null when it is not drawn. */
export function sheetElement(name: SheetName, root: ParentNode = document): HTMLElement | null {
  return root.querySelector<HTMLElement>(SELECTOR[name]);
}

/** Takes the sheet off the screen the way it came, then calls `done`. A phone
 *  that asks for reduced motion gets a crossfade and no travel. */
function leave(el: HTMLElement, from: number, done: () => void): void {
  if (typeof el.animate !== "function") { done(); return; }
  const reduced = prefersReducedMotion();
  const frames: Keyframe[] = reduced
    ? [{ opacity: 1 }, { opacity: 0 }]
    : [{ transform: `translateY(${from}px)` }, { transform: "translateY(100%)" }];
  const anim = el.animate(frames, { duration: reduced ? SHEET_FADE_MS : SHEET_CLOSE_MS, easing: SHEET_EASE, fill: "forwards" });
  let finished = false;
  const end = () => { if (finished) return; finished = true; done(); window.setTimeout(() => anim.cancel(), 400); };
  anim.onfinish = end;
  anim.oncancel = end;
}

/** The sheet comes back to rest after a drag that did not close it. */
function settle(el: HTMLElement, from: number): void {
  el.style.transform = "";
  el.style.transition = "";
  el.removeAttribute("data-sheet-dragging");
  if (typeof el.animate !== "function" || prefersReducedMotion() || from === 0) return;
  el.animate([{ transform: `translateY(${from}px)` }, { transform: "translateY(0)" }], { duration: SHEET_OPEN_MS, easing: SHEET_EASE });
}

export function usePhoneSheets({ phone, open, close, modalOpenRef }: {
  phone: boolean;
  open: SheetFlags;
  /** Each sheet's own way to close, the same the panel's × takes. */
  close: Record<SheetName, () => void>;
  /** A dialog is up: Esc is its. */
  modalOpenRef?: { readonly current: boolean };
}): PhoneSheets {
  const was = useRef<SheetFlags>(ALL_CLOSED);
  const closeRef = useRef(close);
  closeRef.current = close;
  const keep = phone ? sheetToKeep(was.current, open) : null;
  const flags = SHEET_NAMES.map(n => open[n]).join();

  // ONE AT A TIME. The sheet opened last keeps the screen; the others are
  // asked to close, which is what opening one while another is up means.
  useEffect(() => {
    if (phone) {
      const winner = sheetToKeep(was.current, open);
      for (const n of SHEET_NAMES) if (open[n] && n !== winner) closeRef.current[n]();
    }
    was.current = { ...open };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone, flags]);

  const sheet = keep;
  const sheetRef = useRef<SheetName | null>(sheet);
  sheetRef.current = sheet;

  const closeSheet = useCallback(() => {
    const name = sheetRef.current;
    if (!name) return;
    const el = sheetElement(name);
    if (!el) { closeRef.current[name](); return; }
    leave(el, 0, () => closeRef.current[name]());
  }, []);

  // ESC closes the sheet on screen, unless something over it has the key.
  useEffect(() => {
    if (!phone) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || !sheetRef.current) return;
      if (modalOpenRef?.current || document.querySelector(OVER)) return;
      closeSheet();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phone, closeSheet, modalOpenRef]);

  // THE FLICK. A drag that starts on the handle or on the header's free space
  // follows the finger 1:1; on release a quick downward move closes the sheet
  // whatever the distance, a slow one closes it past 40% of its height, and
  // otherwise it returns. A pull up resists.
  useEffect(() => {
    if (!phone) return;
    let drag: null | {
      id: number; el: HTMLElement; name: SheetName; y0: number; height: number; dy: number;
      samples: Array<[number, number]>;
    } = null;
    const onDown = (e: PointerEvent) => {
      const name = sheetRef.current;
      if (!name || drag || (e.pointerType === "mouse" && e.button !== 0)) return;
      const el = sheetElement(name);
      const target = e.target as Element | null;
      if (!el || !target || !el.contains(target)) return;
      const box = el.getBoundingClientRect();
      if (e.clientY - box.top > GRAB_ZONE_PX) return;
      if (target.closest(CONTROL)) return;
      drag = { id: e.pointerId, el, name, y0: e.clientY, height: box.height, dy: 0, samples: [[e.timeStamp, e.clientY]] };
      try { el.setPointerCapture(e.pointerId); } catch { /* a pointer that is gone */ }
    };
    const onMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag.dy = e.clientY - drag.y0;
      drag.samples.push([e.timeStamp, e.clientY]);
      if (drag.samples.length > 6) drag.samples.shift();
      drag.el.setAttribute("data-sheet-dragging", "");
      drag.el.style.transition = "none";
      drag.el.style.transform = `translateY(${dragOffset(drag.dy)}px)`;
      e.preventDefault();
    };
    const onUp = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      try { d.el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      // The speed over the last stretch of the drag, in px per ms.
      // From the oldest move in the last 100ms, and never from the last one
      // alone: a stretch needs two points, however slowly the events came.
      const last = d.samples[d.samples.length - 1];
      const recent = d.samples.find(([t]) => e.timeStamp - t <= 100);
      const first = recent && recent !== last ? recent : d.samples[Math.max(0, d.samples.length - 2)];
      const ms = last[0] - first[0];
      const moved = last[1] - first[1];
      const from = dragOffset(d.dy);
      if (e.type === "pointerup" && releaseCloses(d.dy, d.height, moved, ms)) {
        d.el.style.transform = "";
        d.el.style.transition = "";
        d.el.removeAttribute("data-sheet-dragging");
        leave(d.el, from, () => closeRef.current[d.name]());
      } else {
        settle(d.el, from);
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("pointermove", onMove, { passive: false });
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
  }, [phone]);

  return { sheet, closeSheet };
}
