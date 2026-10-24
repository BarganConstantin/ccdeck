// Usage and the machine panel, moved by hand (owner, 2026-10-24).
//
// Both float over the board in the right-hand slots --rail-r gives them. The
// owner turned a dock beside the stripe down twice and asked instead that the
// reader can pick a panel up by its header and put it where the board is
// empty: lower, further left, wherever the agents are not. The slot stays the
// home a panel returns to: a double click on the header, or a drop close to
// it, puts it back, and it follows the detail panel from there as before.
//
// A PLACE IS KEPT FROM THE NEARER EDGE. Most windows change width more than
// height, and a panel put down near the right stripe should stay near it when
// the window widens, the way the home slot does; one put near the left stays
// near the left. The top is kept from the top. The sheet does the clamping
// (panel-place.css), so a narrower or shorter window keeps the panel between
// the stripes and below the bar without a resize listener, and the place
// itself is not rewritten: widen the window again and it is back.
//
// A phone has no room to move anything in; there the two are sheets and a
// stored place waits for the next desktop load.
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from "react";
import { readStored, removeStored, writeStored } from "./storage";
import { useMediaQuery } from "./use-media-query";
import { PHONE_QUERY } from "./phone-load";

export type PanelPlace = {
  /** The window edge the panel is kept from. */
  edge: "left" | "right";
  /** From that edge to the panel's near side, in px. */
  x: number;
  /** From the window's top to the panel's top, in px. */
  y: number;
};

/** The room a panel may be moved in: the window, less the stripes and an
 *  8px inset at each side, and below the bar. */
export type PanelRoom = { w: number; h: number; side: number; top: number };

/** How much of a panel stays above the window's foot, so its header and a
 *  first reading can always be reached and moved back. */
export const LEAST_SHOWN = 120;
/** A drop this close to the home slot, on both axes, is a drop home. */
export const HOME_SNAP = 24;
/** A press has to travel this far before it is a move, so a click on the
 *  header stays a click. */
export const MOVE_START = 4;

export const PLACE_KEYS = {
  usage: "agent-dag.usagePanelPlace",
  machine: "agent-dag.machinePanelPlace",
} as const;

/** The place a panel at `left`/`top` is kept as, from the edge its centre is
 *  nearer to. */
export function placeOf(left: number, top: number, width: number, windowW: number): PanelPlace {
  const right = windowW - left - width;
  return left + width / 2 > windowW / 2
    ? { edge: "right", x: Math.round(right), y: Math.round(top) }
    : { edge: "left", x: Math.round(left), y: Math.round(top) };
}

/** Where a panel is drawn for a place in a room: the sheet's clamp, in
 *  numbers, for the drag that has to agree with it. */
export function boxOf(place: PanelPlace, width: number, room: PanelRoom): { left: number; top: number } {
  const wanted = place.edge === "left" ? place.x : room.w - place.x - width;
  return {
    left: clamp(wanted, room.side, room.w - room.side - width),
    top: clamp(place.y, room.top, room.h - LEAST_SHOWN),
  };
}

/** A clamp that, like CSS's, lets the least win when the room is smaller
 *  than the panel. */
export function clamp(value: number, least: number, most: number): number {
  return Math.max(least, Math.min(value, most));
}

export function nearHome(at: { left: number; top: number }, home: { left: number; top: number }): boolean {
  return Math.abs(at.left - home.left) <= HOME_SNAP && Math.abs(at.top - home.top) <= HOME_SNAP;
}

/** A stored place, or null for a missing, older or unreadable one. */
export function parsePlace(raw: string | null): PanelPlace | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<PanelPlace>;
    if ((v.edge === "left" || v.edge === "right") && Number.isFinite(v.x) && Number.isFinite(v.y)) {
      return { edge: v.edge, x: v.x as number, y: v.y as number };
    }
  } catch { /* not ours */ }
  return null;
}

/** The room as the sheet sees it, measured rather than read from the tokens
 *  (nothing here calls getComputedStyle; see render-path-cost-612-613): the
 *  stripe's width, and the home slot's top, which is the sheet's least top,
 *  under the bar and under the rating row while it is shown. */
function roomOf(home: DOMRect): PanelRoom {
  const stripe = document.querySelector(".edge-rail-right")?.getBoundingClientRect().width ?? 0;
  return { w: window.innerWidth, h: window.innerHeight, side: stripe + 8, top: home.top };
}

type Drag = {
  id: number; x: number; y: number; moved: boolean;
  start: DOMRect; home: DOMRect; room: PanelRoom | null; at: { left: number; top: number };
};

/**
 * The place of one panel, and the props for the panel and its header.
 * `key` is one of PLACE_KEYS.
 */
export function usePanelPlace(key: string) {
  const phone = useMediaQuery(PHONE_QUERY);
  const [place, setPlace] = useState<PanelPlace | null>(() => parsePlace(readStored(key)));
  const panelRef = useRef<HTMLElement>(null);
  const drag = useRef<Drag | null>(null);
  const stopEscape = useRef<(() => void) | null>(null);
  useEffect(() => () => stopEscape.current?.(), []);

  const keep = (next: PanelPlace | null) => {
    if (next) writeStored(key, JSON.stringify(next));
    else removeStored(key);
    setPlace(next);
  };
  const draw = (at: { left: number; top: number } | null) => {
    const el = panelRef.current;
    if (!el) return;
    if (at) {
      el.style.left = `${at.left}px`;
      el.style.top = `${at.top}px`;
      el.style.right = "auto";
    } else {
      el.style.removeProperty("left");
      el.style.removeProperty("top");
      el.style.removeProperty("right");
    }
  };
  const finish = () => {
    const el = panelRef.current;
    el?.removeAttribute("data-moving");
    stopEscape.current?.();
    stopEscape.current = null;
    drag.current = null;
  };
  /** The home slot, measured with the place lifted off for one read. */
  const homeOf = (el: HTMLElement): DOMRect => {
    const edge = el.getAttribute("data-place");
    if (!edge) return el.getBoundingClientRect();
    el.removeAttribute("data-place");
    const home = el.getBoundingClientRect();
    el.setAttribute("data-place", edge);
    return home;
  };

  const interactive = (target: EventTarget | null) =>
    target instanceof Element && target.closest("button, a, input, select, textarea, [role='button']") !== null;

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    const el = panelRef.current;
    if (!el || event.button !== 0 || interactive(event.target)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = el.getBoundingClientRect();
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false,
      start, home: start, room: null, at: { left: start.left, top: start.top } };
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    const el = panelRef.current;
    if (!d || !el || event.pointerId !== d.id) return;
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < MOVE_START) return;
      d.moved = true;
      d.home = homeOf(el);
      d.room = roomOf(d.home);
      // The one moved last is the one on top where the two overlap.
      document.querySelectorAll<HTMLElement>("[data-front]").forEach(other => other.removeAttribute("data-front"));
      el.setAttribute("data-front", "");
      el.setAttribute("data-moving", "");
      const escape = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        draw(null);
        finish();
      };
      window.addEventListener("keydown", escape, true);
      stopEscape.current = () => window.removeEventListener("keydown", escape, true);
    }
    const width = d.start.width;
    const room = d.room!;
    d.at = {
      left: clamp(d.start.left + dx, room.side, room.w - room.side - width),
      top: clamp(d.start.top + dy, room.top, room.h - LEAST_SHOWN),
    };
    draw(d.at);
  };
  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || event.pointerId !== d.id) return;
    finish();
    if (!d.moved) return;
    // The inline box comes off in the same task as the render that draws the
    // place through the sheet, so nothing paints between the two.
    draw(null);
    keep(nearHome(d.at, d.home) ? null : placeOf(d.at.left, d.at.top, d.start.width, d.room!.w));
  };
  const onPointerCancel = () => {
    if (!drag.current) return;
    draw(null);
    finish();
  };
  const onDoubleClick = (event: MouseEvent<HTMLElement>) => {
    if (interactive(event.target) || !place) return;
    keep(null);
  };

  const placed = place && !phone ? place : null;
  const panel = {
    ref: panelRef,
    "data-place": placed?.edge,
    style: placed ? ({ "--place-x": `${placed.x}px`, "--place-y": `${placed.y}px` } as CSSProperties) : undefined,
  };
  const grip = phone ? {} : {
    "data-grip": "",
    title: "Drag to move · double-click to put it back",
    onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onLostPointerCapture: onPointerCancel, onDoubleClick,
  };
  return { place: placed, panel, grip };
}
