// One hint for the deck's chrome — the edge stripes, the dock, the topbar's
// utilities and the waiting queue — in place of the browser's own `title`: the
// control's name and, while it does something, the key that reaches it in a
// keycap, "Session list  L".
//
// WHEN. After 450ms of rest under a mouse the first time, then at once on the
// next control while the reader is moving along the chrome, and at once under
// keyboard focus (:focus-visible), where a delay would only be a lag. Never for
// a touch or a pen: a fingertip has no hover, and a hint that a tap left
// behind would sit over the thing the tap opened.
//
// WHEN NOT. When it would only repeat a word already on the control — a
// labelled dock or topbar button — it says nothing unless it adds a key or
// detail. Desktop rails use icons alone, so their names always appear in a
// hint, including with single-key shortcuts switched off.
//
// AWAY (WCAG 1.4.13). Escape takes it down from anywhere, through the deck's
// one dismiss stack (modal-dismiss.ts) like every other overlay, so the key
// keeps one owner and a hint over an open menu goes first. The pointer can
// cross onto the hint without losing it — leaving the control waits 100ms for
// that — and leaving the hint, a press, a blur, a scroll or a resize take it
// down.
//
// aria-hidden: each control already carries both halves, its name in its
// accessible name and its key in aria-keyshortcuts, so a screen reader hears
// them once. Portalled to <body>, because a stripe is a stacking context of its
// own and a hint drawn inside it went under the panels it sits beside.
import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
  type FocusEvent, type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { modalStack } from "../modal-dismiss";

export type HintSide = "right" | "left" | "below" | "above";

/** What a hint says. Null is a control whose hint would add nothing. */
export interface HintSpec {
  label: string;
  /** The key, as its keycap prints it, while it does something. */
  keys?: string;
  /** Lines under the name: what the name alone does not say. */
  detail?: string;
}

export const FIRST_HINT_DELAY_MS = 450;
/** After a hint goes, the next one within this long comes at once. */
export const SKIP_DELAY_WINDOW_MS = 400;
/** How long leaving a control waits for the pointer to reach its hint. */
export const HINT_GRACE_MS = 100;
const GAP_PX = 8;
const SIDE_CLASS = { right: "hint hint-right", left: "hint hint-left", below: "hint hint-below", above: "hint hint-above" } as const;
const EDGE_PX = 8;

/** The hint on screen, by its hide, wherever it was opened, so the next one
 *  can take over from it at once instead of queueing behind its exit. */
let current: (() => void) | null = null;
let lastHiddenAt = -Infinity;

/** Whether the next hint skips the first one's wait: one is up now, or one
 *  went a moment ago. */
export function skipsDelay(now: number, hiddenAt: number, anotherShown: boolean): boolean {
  return anotherShown || now - hiddenAt < SKIP_DELAY_WINDOW_MS;
}

interface Shown {
  spec: HintSpec;
  box: DOMRect;
  /** The dialog a dialog-layer hint stays inside, across. */
  within: DOMRect | null;
  instant: boolean;
}

/** Where the hint goes against its control, kept inside the window — and
 *  across, inside the dialog it belongs to, when it has one: a hint over the
 *  end of What's new's strip hung off the dialog onto the scrim. */
function place(side: HintSide, box: DOMRect, w: number, h: number, within: DOMRect | null = null): { left: number; top: number } {
  const minX = Math.max(EDGE_PX, (within?.left ?? 0) + EDGE_PX);
  const maxX = Math.min(window.innerWidth, within?.right ?? Infinity) - w - EDGE_PX;
  const clampX = (x: number) => Math.max(minX, Math.min(x, maxX));
  const clampY = (y: number) => Math.max(EDGE_PX, Math.min(y, window.innerHeight - h - EDGE_PX));
  const midY = box.top + box.height / 2 - h / 2;
  const midX = box.left + box.width / 2 - w / 2;
  if (side === "right") return { left: box.right + GAP_PX, top: clampY(midY) };
  if (side === "left") return { left: box.left - GAP_PX - w, top: clampY(midY) };
  if (side === "above") return { left: clampX(midX), top: box.top - GAP_PX - h };
  return { left: clampX(midX), top: box.bottom + GAP_PX };
}

/** Where the hint is drawn: on the chrome's popover layer, under every dialog,
 *  or over the dialog it belongs to — What's new's actions are inside one. */
export type HintLayer = "chrome" | "dialog";
const LAYER_CLASS: Record<HintLayer, string> = { chrome: "", dialog: " hint-over-dialog" };

export function useHint(side: HintSide, layer: HintLayer = "chrome") {
  const [shown, setShown] = useState<Shown | null>(null);
  const showTimer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);
  const hintRef = useRef<HTMLSpanElement>(null);

  const hide = useCallback(() => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    setShown(was => {
      if (was) lastHiddenAt = performance.now();
      return null;
    });
  }, []);

  const show = useCallback((el: HTMLElement, spec: HintSpec, now: boolean) => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    const another = current !== null;
    const instant = skipsDelay(performance.now(), lastHiddenAt, another);
    const reveal = () => {
      if (current && current !== hide) current();
      current = hide;
      const within = layer === "dialog" ? el.closest('[role="dialog"]')?.getBoundingClientRect() ?? null : null;
      setShown({ spec, box: el.getBoundingClientRect(), within, instant });
    };
    if (now || instant) reveal();
    else showTimer.current = window.setTimeout(reveal, FIRST_HINT_DELAY_MS);
  }, [hide, layer]);

  const leave = useCallback(() => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(hide, HINT_GRACE_MS);
  }, [hide]);

  const up = shown !== null;
  // On the dismiss stack while it is up, as a popover: Escape takes it down
  // and nothing else, and it holds back none of the canvas letters.
  useEffect(() => {
    if (!up) return;
    const off = modalStack.push(hide, 0, "popover");
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", hide, true);
    return () => {
      off();
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", hide, true);
      if (current === hide) current = null;
    };
  }, [up, hide]);

  useEffect(() => () => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    if (current === hide) current = null;
  }, [hide]);

  // Placed once it has a size, before the frame paints, so it never shows at
  // the wrong spot or past the window's edge.
  useLayoutEffect(() => {
    const el = hintRef.current;
    if (!el || !shown) return;
    const { width, height } = el.getBoundingClientRect();
    const at = place(side, shown.box, width, height, shown.within);
    el.style.left = `${at.left}px`;
    el.style.top = `${at.top}px`;
    el.style.visibility = "visible";
  }, [shown, side]);

  /** The handlers a control spreads to have this hint. Null says nothing. */
  const bind = useCallback((spec: HintSpec | null) => ({
    onPointerEnter: (e: PointerEvent<HTMLElement>) => {
      if (spec && e.pointerType === "mouse") show(e.currentTarget, spec, false);
    },
    onPointerLeave: leave,
    onPointerDown: hide,
    onFocus: (e: FocusEvent<HTMLElement>) => {
      if (spec && e.currentTarget.matches(":focus-visible")) show(e.currentTarget, spec, true);
    },
    onBlur: hide,
  }), [show, leave, hide]);

  const node = shown && createPortal(
    <span
      ref={hintRef}
      className={SIDE_CLASS[side] + LAYER_CLASS[layer]}
      data-instant={shown.instant || undefined}
      style={{ left: 0, top: 0, visibility: "hidden" }}
      aria-hidden
      onPointerEnter={() => window.clearTimeout(hideTimer.current)}
      onPointerLeave={hide}
    >
      <span className="hint-head">
        <span className="hint-label">{shown.spec.label}</span>
        {shown.spec.keys && <kbd className="hint-key">{shown.spec.keys}</kbd>}
      </span>
      {shown.spec.detail && <span className="hint-detail">{shown.spec.detail}</span>}
    </span>,
    document.body,
  );

  return { bind, node };
}
