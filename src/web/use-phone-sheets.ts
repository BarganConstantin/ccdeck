// The phone sheet's behaviour: one at a time, Esc, focus, and the flick
// (phone-sheet.ts has the rules, styles/phone-sheet.css the look). Only at 640
// and under; with `phone` false the hook does nothing, so the desktop's panels
// are untouched.
//
// WHAT IT DOES NOT TOUCH. Each panel's open flag stays where it was (use-left-
// column.ts, use-right-panels.ts); the hook only asks for a flag to be cleared,
// through the same setter the panel's own × uses. Nothing is sent or read.
//
// ONE CLOSE. Every way out (×, Esc, the scrim, a flick, the Sessions door)
// drops the sheet's flag at once, so the scrim fades with the slide, and the
// panel's own leaving state carries the slide down over one close time. A
// second ask during that is nothing. A flick carries on from where the finger
// left the sheet.
//
// ESC HAS ONE OWNER. A sheet on screen is in the deck's dismiss stack
// (modal-dismiss.ts), so the deck's own Esc takes its "dismiss" branch and
// leaves the selection and the focus alone; this hook has no key listener.
//
// A SHEET IS MODAL IN LOOK, SO IT IS IN BEHAVIOUR. What the scrim covers is
// inert while a sheet is up, focus moves into the sheet when it opens, and
// goes back to what opened it when it closes.
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { modalStack } from "./modal-dismiss";
import {
  GRAB_ZONE_PX, SHEET_NAMES, dragOffset, dragStarts, releaseCloses, sheetCloseMs, sheetEase,
  sheetOpenMs, sheetToKeep, topSheet, type SheetFlags, type SheetName,
} from "./phone-sheet";
import { prefersReducedMotion } from "./viewport-motion";

/** Where each sheet is in the page. */
const SELECTOR: Record<SheetName, string> = {
  accounts: ".accounts-panel:not([hidden]):not(.leaving)",
  usage: ".usage-panel:not(.leaving)",
  machine: ".sysdetail:not(.leaving)",
  // In the right column's wrapper, which is no box on a phone (panel-place.css).
  inspector: ".app > .right-col > .detail:not(.leaving)",
};
/** Anything in a sheet that answers a press by itself keeps it: a drag only
 *  starts on the handle and on what is not a control. */
const CONTROL = "button, a, input, select, textarea, label, summary, [role='button'], [role='tab'], [role='switch'], [role='menuitem']";
/** What stands over a sheet and owns Esc while it is up. */
const OVER = ".anchored-popover, .modal-backdrop, [role='dialog'], [role='alertdialog']";
/** What the scrim covers: the top bar, the list, the board and the stage, the
 *  deck's banner and the skip link. Not the dock, not a sheet, not a popover
 *  (those are portaled). */
const COVERED = ".topbar, .left-column, main, .stage-dock, .ver-banner, .conn-banner, .skip-link";
/** How many frames to wait for a sheet's element to be drawn before giving up
 *  on moving focus into it. */
const FOCUS_FRAMES = 12;

/** Nothing open: where the hook starts, never written to. */
const ALL_CLOSED: SheetFlags = { accounts: false, usage: false, machine: false, inspector: false };

export interface PhoneSheets {
  /** The sheet on screen, if any. */
  sheet: SheetName | null;
  /** Closes a sheet (the one on screen, unless named) the way a flick would:
   *  it goes back down the way it came. A second call during the close does
   *  nothing. */
  closeSheet: (name?: SheetName) => void;
}

/** The sheet's element, or null when it is not drawn. */
export function sheetElement(name: SheetName, root: ParentNode = document): HTMLElement | null {
  return root.querySelector<HTMLElement>(SELECTOR[name]);
}

/** A drag in progress, put back: no offset, no held transition. */
function rest(el: HTMLElement): void {
  el.style.transform = "";
  el.style.transition = "";
  el.removeAttribute("data-sheet-dragging");
}

/** The sheet goes the rest of the way down from where the finger left it, over
 *  the close time. Under reduced motion it does not travel: the panel's own
 *  leaving state crossfades it. Returns the animation to cancel if the sheet
 *  comes back. */
function slideOut(el: HTMLElement, from: number): Animation | null {
  rest(el);
  if (typeof el.animate !== "function" || prefersReducedMotion()) return null;
  return el.animate(
    [{ transform: `translateY(${from}px)` }, { transform: "translateY(100%)" }],
    { duration: sheetCloseMs(), easing: sheetEase(), fill: "forwards" },
  );
}

/** The sheet comes back to rest after a drag that did not close it. */
function settle(el: HTMLElement, from: number): void {
  rest(el);
  if (typeof el.animate !== "function" || prefersReducedMotion() || from === 0) return;
  el.animate([{ transform: `translateY(${from}px)` }, { transform: "translateY(0)" }], { duration: sheetOpenMs(), easing: sheetEase() });
}

export function usePhoneSheets({ phone, open, close, openers, modalOpenRef, onLeavePhone, hold, home }: {
  phone: boolean;
  open: SheetFlags;
  /** Each sheet's own way to close, the same the panel's × takes. */
  close: Record<SheetName, () => void>;
  /** What opened each sheet, to hand focus back to when it closes: the dock's
   *  door, or the session's row. When a sheet has none, the element that held
   *  focus when it opened is used. */
  openers?: Partial<Record<SheetName, () => HTMLElement | null>>;
  /** A dialog is up: Esc is its. */
  modalOpenRef?: { readonly current: boolean };
  /** The window grew past a phone's width. */
  onLeavePhone?: () => void;
  /** Each panel's in-memory hold: shut, not stored, and not reopened by this
   *  hook (use-right-panels.ts, use-left-column.ts). Used when the window
   *  narrows to a phone's width with several panels open. */
  hold?: Partial<Record<SheetName, () => void>>;
  /** Where focus goes when what opened a sheet is gone: the Sessions door. */
  home?: () => HTMLElement | null;
}): PhoneSheets {
  const was = useRef<SheetFlags>(ALL_CLOSED);
  const closeRef = useRef(close);
  closeRef.current = close;
  const openersRef = useRef(openers);
  openersRef.current = openers;
  const leaveRef = useRef(onLeavePhone);
  leaveRef.current = onLeavePhone;
  const holdRef = useRef(hold);
  holdRef.current = hold;
  const homeRef = useRef(home);
  homeRef.current = home;
  const prevPhone = useRef(phone);
  /** The sheet being closed right now, so that a second ask is nothing. */
  const closingRef = useRef<SheetName | null>(null);
  /** A flick's slide still holding the sheet down, by sheet. */
  const slidesRef = useRef<Partial<Record<SheetName, Animation>>>({});
  const keep = phone ? sheetToKeep(was.current, open) : null;
  const flags = SHEET_NAMES.map(n => open[n]).join();

  // ONE AT A TIME. The sheet opened last keeps the screen; the others are
  // asked to close, which is what opening one while another is up means. A
  // window narrowed to a phone's width with several open keeps the one on top
  // (the one the reader sees) and holds the rest shut in memory, through the
  // panels' own holds: they are not drawn, their doors read closed, and
  // nothing is stored (a resize is not the reader closing a panel).
  //
  // A layout effect, so the crossing is settled before a frame is painted: the
  // desktop frame after a widening never shows the list and Accounts in one
  // column, and the phone frame after a narrowing never shows two sheets.
  useLayoutEffect(() => {
    const crossed = prevPhone.current !== phone;
    prevPhone.current = phone;
    for (const n of SHEET_NAMES) {
      if (open[n] === was.current[n]) continue;
      if (closingRef.current === n) closingRef.current = null;
      // A sheet that comes back mid-close must not stay held down by the slide.
      if (open[n]) { slidesRef.current[n]?.cancel(); delete slidesRef.current[n]; }
    }
    if (crossed) {
      if (phone) {
        const top = topSheet(open);
        for (const n of SHEET_NAMES) if (open[n] && n !== top) holdRef.current?.[n]?.();
      }
      was.current = { ...open };
      if (!phone) leaveRef.current?.();
      return;
    }
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

  const closeSheet = useCallback((named?: SheetName) => {
    const name = named ?? sheetRef.current;
    if (!name || closingRef.current === name) return;
    closingRef.current = name;
    // A close that changes nothing must not hold the sheet shut for good.
    window.setTimeout(() => { if (closingRef.current === name) closingRef.current = null; }, sheetCloseMs() + 200);
    closeRef.current[name]();
  }, []);

  // ESC. The sheet is in the deck's dismiss stack for as long as it is up, and
  // for the length of its slide after: the deck's Esc asks the stack, so one
  // press closes it once and does nothing else. Over it, a popover or a dialog
  // is on the stack above it and is asked first.
  const dismissRef = useRef<() => void>(() => {});
  dismissRef.current = () => {
    if (modalOpenRef?.current || document.querySelector(OVER)) return;
    closeSheet();
  };
  useEffect(() => {
    if (!phone || !sheet) return;
    const off = modalStack.push(() => dismissRef.current(), 0, "popover");
    return () => { window.setTimeout(off, sheetCloseMs() + 50); };
  }, [phone, sheet]);

  // WHAT THE SCRIM COVERS IS INERT while a sheet is up, and not a moment longer
  // than the sheet is: it ends when the close starts.
  // A covered part that mounts while the sheet is up (a banner when the
  // connection drops) is made inert as it arrives: a MutationObserver on the
  // page's own children, which is where those parts are mounted.
  useEffect(() => {
    if (!phone || !sheet) return;
    const held: Element[] = [];
    const cover = () => {
      for (const el of Array.from(document.querySelectorAll(COVERED))) {
        if (el.hasAttribute("inert")) continue;
        el.setAttribute("inert", "");
        held.push(el);
      }
    };
    cover();
    const root = document.querySelector(".app");
    const watcher = root && typeof MutationObserver === "function" ? new MutationObserver(cover) : null;
    if (root) watcher?.observe(root, { childList: true });
    return () => {
      watcher?.disconnect();
      for (const el of held) el.removeAttribute("inert");
    };
  }, [phone, sheet]);

  // FOCUS goes into the sheet when it opens, so a screen reader announces the
  // panel (the container is made focusable for it, and Tab is not trapped: the
  // dock stays reachable), and back to what opened it when it closes.
  const shownRef = useRef<SheetName | null>(null);
  const sheetElRef = useRef<HTMLElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const before = shownRef.current;
    shownRef.current = phone ? sheet : null;
    if (phone && sheet && sheet !== before) {
      const active = document.activeElement as HTMLElement | null;
      const inside = sheetElRef.current != null && active != null && sheetElRef.current.contains(active);
      openerRef.current = active && active !== document.body && !inside ? active : openerRef.current;
      let frames = 0;
      let frame = 0;
      const find = () => {
        const el = sheetElement(sheet);
        if (!el) {
          if (++frames < FOCUS_FRAMES) frame = window.requestAnimationFrame(find);
          return;
        }
        if (sheetElRef.current && sheetElRef.current !== el) sheetElRef.current.removeAttribute("tabindex");
        sheetElRef.current = el;
        el.tabIndex = -1;
        el.focus({ preventScroll: true });
      };
      find();
      return () => { if (frame) window.cancelAnimationFrame(frame); };
    }
    if (before && !(phone && sheet)) {
      const el = sheetElRef.current;
      sheetElRef.current = null;
      el?.removeAttribute("tabindex");
      if (!phone) return;
      // Closed by any path: if focus is still in the sheet, or has fallen to
      // the page, hand it to what opened the sheet.
      const active = document.activeElement as HTMLElement | null;
      const lost = !active || active === document.body || !active.isConnected || (el != null && el.contains(active));
      if (!lost) return;
      // What opened it, else where focus was when it opened; if that is gone
      // (a session that ended took its row with it), the Sessions door.
      const opener = openersRef.current?.[before]?.() ?? openerRef.current;
      const target = opener && opener.isConnected ? opener : homeRef.current?.() ?? null;
      if (target && target.isConnected) target.focus({ preventScroll: true });
    }
  }, [phone, sheet]);

  // THE FLICK. A drag that starts on the handle or on the header's free space,
  // and goes 8px down or up, follows the finger 1:1; on release a quick
  // downward move that went 12px or more closes the sheet whatever the
  // distance, a slow one closes it past 40% of its height, and otherwise it
  // returns. A pull up resists. A press that never goes 8px is not a drag and is
  // left alone.
  useEffect(() => {
    if (!phone) return;
    let drag: null | {
      id: number; el: HTMLElement; name: SheetName; y0: number; height: number;
      engaged: boolean; dy: number; base: number;
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
      drag = { id: e.pointerId, el, name, y0: e.clientY, height: box.height, engaged: false, dy: 0, base: 0, samples: [[e.timeStamp, e.clientY]] };
    };
    const onMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dy = e.clientY - drag.y0;
      drag.samples.push([e.timeStamp, e.clientY]);
      if (drag.samples.length > 6) drag.samples.shift();
      if (!drag.engaged) {
        if (!dragStarts(dy)) return;
        // From here the sheet follows the finger, from where it was when the
        // drag began (no jump of the 8px it took to begin).
        drag.engaged = true;
        drag.base = dragOffset(dy);
        try { drag.el.setPointerCapture(e.pointerId); } catch { /* a pointer that is gone */ }
      }
      drag.dy = dy;
      drag.el.setAttribute("data-sheet-dragging", "");
      drag.el.style.transition = "none";
      drag.el.style.transform = `translateY(${dragOffset(dy) - drag.base}px)`;
      e.preventDefault();
    };
    const onUp = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      if (!d.engaged) return;
      try { d.el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      // The speed over the last stretch of the drag, in px per ms.
      // From the oldest move in the last 100ms, and never from the last one
      // alone: a stretch needs two points, however slowly the events came.
      const last = d.samples[d.samples.length - 1];
      const recent = d.samples.find(([t]) => e.timeStamp - t <= 100);
      const first = recent && recent !== last ? recent : d.samples[Math.max(0, d.samples.length - 2)];
      const ms = last[0] - first[0];
      const moved = last[1] - first[1];
      const from = dragOffset(d.dy) - d.base;
      if (e.type === "pointerup" && releaseCloses(d.dy, d.height, moved, ms)) {
        const slide = slideOut(d.el, from);
        if (slide) {
          slidesRef.current[d.name]?.cancel();
          slidesRef.current[d.name] = slide;
          // Backstop: a slide that never ends must not hold a sheet down.
          window.setTimeout(() => { slide.cancel(); if (slidesRef.current[d.name] === slide) delete slidesRef.current[d.name]; }, sheetCloseMs() + 200);
        }
        closeSheet(d.name);
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
      // Crossing 640 in the middle of a drag: nothing is left on the panel.
      if (drag) {
        try { drag.el.releasePointerCapture(drag.id); } catch { /* already released */ }
        rest(drag.el);
      }
    };
  }, [phone, closeSheet]);

  return { sheet, closeSheet };
}
