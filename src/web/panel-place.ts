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
// (panel-place.css), so a narrower or shorter window keeps the panel's header
// inside the view without a resize listener, and the place itself is not
// rewritten: widen the window again and it is back.
//
// THE ROOM IS THE VIEW, NOTHING ELSE (owner, 2026-11-08): from under the top
// bar to the status bar, the window's full width, with the header always
// whole inside it. The home slot is not a bound: in Workspace the machine
// panel's slot is the column's lower half, and measuring the least top from it
// kept the panel from ever going higher than that half. Nor is the other
// panel: the two may overlap, the one moved last on top.
//
// A phone has no room to move anything in; there the two are sheets and a
// stored place waits for the next desktop load.
//
// IN WORKSPACE the two dock in a side column instead (side-column.ts), and a
// docked panel has no place and no grip. One popped out of the column floats
// here again, with a place of its own: Workspace keeps its floating places
// apart from the Board's (floatKey), and a double click on its header docks it.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from "react";
import { readStored, removeStored, writeStored } from "./storage";
import { useMediaQuery } from "./use-media-query";
import { PHONE_QUERY } from "./phone-load";
import { t } from "./i18n";
import type { PanelDock } from "./side-column";

export type PanelPlace = {
  /** The window edge the panel is kept from. */
  edge: "left" | "right";
  /** From that edge to the panel's near side, in px. */
  x: number;
  /** From the window's top to the panel's top, in px. */
  y: number;
};

/** The room a panel may be moved in: the window's full width (`w`), from the
 *  top bar's foot (`top`) to the status bar's top (`h`). `head` is how far the
 *  header reaches below the panel's top edge (its border and the header), the
 *  part that always stays inside. */
export type PanelRoom = { w: number; h: number; top: number; head: number };

/** The least a panel put above another keeps when the lower one shortens it
 *  (stackCap): its header and a first reading. */
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

/** Where a panel popped out of Workspace's column keeps its place: the Board's
 *  key, for Workspace alone. */
export function floatKey(key: string): string {
  return `${key}.workspace`;
}

/** A docked panel is a part of the column: the stack, the held height and the
 *  drag are the floating panels' alone. */
const isDocked = (el: Element | null) => el?.getAttribute?.("data-dock") === "docked";

/** Where each panel keeps the height it settled at (see useRememberedHeight). */
const HEIGHT_KEYS: Record<string, string> = {
  [PLACE_KEYS.usage]: "agent-dag.usagePanelHeight",
  [PLACE_KEYS.machine]: "agent-dag.machinePanelHeight",
};
/** How long an opened panel holds the height it last settled at: the time its
 *  readings take to arrive, after which it is as tall as its content. */
export const HEIGHT_HOLD_MS = 1500;
/** A held height never takes more than this of the window, so a panel from a
 *  taller window cannot open past the foot of this one. */
const HEIGHT_SPARE = 140;

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
  return dragBox(wanted, place.y, width, room);
}

/** A panel's box at `left`/`top`, kept in the room: its header whole between
 *  the top bar and the status bar, its sides inside the window. */
export function dragBox(left: number, top: number, width: number, room: PanelRoom): { left: number; top: number } {
  return {
    left: clamp(left, 0, room.w - width),
    top: clamp(top, room.top, room.h - room.head),
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

/** Between a panel and one put below it in the same column. */
export const STACK_GAP = 8;

type Box = { left: number; top: number; width: number };

/**
 * ONE PANEL PUT BELOW THE OTHER SHORTENS THE ONE ABOVE (owner, 2026-10-24).
 * Where the two share any of a column, the upper one ends STACK_GAP above the
 * lower one's top and scrolls the rest, the way either already does at the
 * window's foot, so both can be read whole. The heights do not matter: a cap
 * longer than the upper panel's content changes nothing. Where the upper one
 * would keep less than LEAST_SHOWN, there is no cap and they overlap, the
 * one moved last on top.
 */
export function stackCap(a: Box, b: Box): { upper: "a" | "b"; cap: number } | null {
  if (a.left >= b.left + b.width || b.left >= a.left + a.width) return null;
  const [upper, lower, which] = a.top <= b.top ? [a, b, "a" as const] : [b, a, "b" as const];
  const cap = lower.top - upper.top - STACK_GAP;
  return cap >= LEAST_SHOWN ? { upper: which, cap } : null;
}

/** Applies stackCap to the two panels as they stand. Offsets, not rects, so
 *  the 8px of an arriving panel's rail-in does not count. A phone stacks its
 *  two sheets in the sheet already. */
export function fitStack(): void {
  const usage = document.querySelector<HTMLElement>(".usage-panel");
  const machine = document.querySelector<HTMLElement>(".sysdetail");
  usage?.style.removeProperty("max-height");
  machine?.style.removeProperty("max-height");
  if (!usage || !machine || window.matchMedia(PHONE_QUERY).matches) return;
  // A part of Workspace's column is not stacked with anything: the column
  // shares its height.
  if (isDocked(usage) || isDocked(machine)) return;
  const box = (el: HTMLElement): Box => ({ left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth });
  const fit = stackCap(box(usage), box(machine));
  if (fit) (fit.upper === "a" ? usage : machine).style.maxHeight = `${fit.cap}px`;
  // A held height (useRememberedHeight) is a floor that beats max-height, so
  // it is kept inside what each panel has: the cap of the one above, and the
  // room to the status bar for both.
  for (const el of [usage, machine]) {
    const held = parseFloat(el.style.minHeight);
    if (!(held > 0)) continue;
    const cap = parseFloat(el.style.maxHeight);
    el.style.minHeight = `${Math.min(held, Number.isFinite(cap) ? cap : Infinity, roomBelow(el))}px`;
  }
}

/** How much window a panel has from its top to the status bar, less the 8 the
 *  panels keep from an edge. */
export function roomBelow(el: HTMLElement): number {
  const status = document.querySelector(".statusbar")?.getBoundingClientRect().height ?? 0;
  return Math.max(0, window.innerHeight - status - el.offsetTop - 8);
}

/** The air the minimap keeps from the canvas's edges: react-flow.css's
 *  --board-controls-edge, as a number, since nothing here reads the sheet. It
 *  keeps the same from a panel beside it. */
export const BOARD_EDGE = 12;

type Span = { left: number; right: number };

/**
 * NO PANEL STANDS OVER THE MINIMAP OR THE CHARACTER ON IT (owner, 2026-11-10).
 * Both stand at the canvas's bottom right, under the panels' home slots, and an
 * open Usage panel covered the minimap and half the character. Now they step
 * in past every panel their span meets, BOARD_EDGE clear of it, and are not
 * drawn when what the panels leave of the canvas cannot hold them.
 *
 * A panel counts at its full height, as railCover counts it for the fit: its
 * foot moves as its readings arrive, and a minimap that jumped each time would
 * be worse than one that stands clear. A panel the reader put on the left is
 * met only if it is in the way, so it pushes nothing.
 *
 * How much further in than BOARD_EDGE the minimap's right edge stands, or null
 * for no room. `width` is the minimap's.
 */
export function minimapInset(panels: readonly Span[], canvas: Span, width: number): number | null {
  let inset = 0;
  // Each pass steps past at least one panel for good, so one more pass than
  // there are panels always ends on a span nothing meets.
  for (let pass = 0; pass <= panels.length; pass++) {
    const right = canvas.right - BOARD_EDGE - inset;
    const met = panels.filter(p => p.left < right + BOARD_EDGE && p.right > right - width);
    if (met.length === 0) break;
    inset = canvas.right - Math.min(...met.map(p => p.left));
  }
  return canvas.right - BOARD_EDGE - inset - width < canvas.left + BOARD_EDGE ? null : inset;
}

/** Applies minimapInset to the panels as they stand: `--minimap-in` on the
 *  canvas, which the minimap and the character read (react-flow.css,
 *  claude-fm.css), and `data-minimap="off"` when there is no room. Offsets for
 *  the panels, as fitStack, so an arriving panel's 12px of travel does not
 *  count. A docked part is in its column, not over the canvas; a phone's
 *  sheets are not beside the minimap, so a phone keeps it where it was. */
export function fitMinimap(): void {
  const canvas = document.querySelector<HTMLElement>(".canvas-wrap");
  const map = canvas?.querySelector<HTMLElement>(".react-flow__minimap");
  if (!canvas || !map) return;
  const panels = window.matchMedia(PHONE_QUERY).matches ? [] : Array.from(
    document.querySelectorAll<HTMLElement>(".usage-panel:not(.leaving), .sysdetail:not(.leaving)"),
    el => (isDocked(el) || !(el.offsetWidth > 0) ? null : { left: el.offsetLeft, right: el.offsetLeft + el.offsetWidth }),
  ).filter((span): span is Span => span !== null);
  const box = canvas.getBoundingClientRect();
  const inset = minimapInset(panels, { left: box.left, right: box.right }, map.offsetWidth);
  canvas.style.setProperty("--minimap-in", `${inset ?? 0}px`);
  if (inset === null) canvas.setAttribute("data-minimap", "off");
  else canvas.removeAttribute("data-minimap");
}

let fitFrame = 0;
/** fitStack and fitMinimap once in the next frame, however many things asked. */
function scheduleFit(): void {
  if (fitFrame) return;
  fitFrame = requestAnimationFrame(() => { fitFrame = 0; fitStack(); fitMinimap(); });
}

/** The room as the sheet sees it, measured rather than read from the tokens
 *  (nothing here calls getComputedStyle; see render-path-cost-612-613): the
 *  top bar's foot, where the status bar begins (none on a phone, or before it
 *  is drawn: 0), the window's width, and how far the header reaches below the
 *  panel's top. Nothing of the home slot: it is where the panel goes back to,
 *  not a bound. */
export function roomOf(panel: Element, header: Element): PanelRoom {
  const bar = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0;
  const status = document.querySelector(".statusbar")?.getBoundingClientRect().height ?? 0;
  // The header's foot from the panel's top, and the panel's own bottom border
  // under it: the least the panel is drawn at (panel-place.css --place-head).
  const head = header.getBoundingClientRect().bottom - panel.getBoundingClientRect().top + 1;
  return { w: window.innerWidth, h: window.innerHeight - status, top: bar, head };
}

type Drag = {
  id: number; x: number; y: number; moved: boolean;
  start: DOMRect; home: DOMRect; room: PanelRoom | null; at: { left: number; top: number };
};

/**
 * A panel opens at the height it settled at last time (V4's motion spec: it
 * takes its final height on open, and does not grow in steps as its readings
 * arrive). The height is held for HEIGHT_HOLD_MS, then the panel is as tall as
 * its content again; whatever height it has when it closes is remembered. The
 * first open on a machine has nothing to hold and still grows once.
 */
export function useRememberedHeight(panelRef: { readonly current: HTMLElement | null }, key: string): void {
  useLayoutEffect(() => {
    const el = panelRef.current;
    const heightKey = HEIGHT_KEYS[key];
    if (!el || !heightKey || window.matchMedia(PHONE_QUERY).matches) return;
    const saved = Number(readStored(heightKey));
    if (Number.isFinite(saved) && saved > 0) {
      el.style.minHeight = `${Math.min(saved, Math.max(0, window.innerHeight - HEIGHT_SPARE), roomBelow(el))}px`;
      fitStack();
    }
    const release = window.setTimeout(() => {
      el.style.removeProperty("min-height");
    }, HEIGHT_HOLD_MS);
    let latest = 0;
    // Only a floating panel's height is its own: docked, it is the column's share.
    const watch = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => { if (!isDocked(el)) latest = el.offsetHeight; });
    watch?.observe(el);
    const keep = () => { if (latest > 0) writeStored(heightKey, String(Math.round(latest))); };
    window.addEventListener("pagehide", keep);
    return () => {
      window.clearTimeout(release);
      watch?.disconnect();
      window.removeEventListener("pagehide", keep);
      keep();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * The place of one panel, and the props for the panel and its header.
 * `boardKey` is one of PLACE_KEYS. `dock` is the panel's place in Workspace's
 * column (side-column.ts); absent, the panel is the Board's.
 */
export function usePanelPlace(boardKey: string, dock?: PanelDock) {
  const phone = useMediaQuery(PHONE_QUERY);
  const mode = dock?.mode ?? "board";
  const key = mode === "float" ? floatKey(boardKey) : boardKey;
  const [place, setPlace] = useState<PanelPlace | null>(() => parsePlace(readStored(key)));
  const panelRef = useRef<HTMLElement>(null);
  const drag = useRef<Drag | null>(null);
  const stopEscape = useRef<(() => void) | null>(null);
  useEffect(() => () => stopEscape.current?.(), []);
  useRememberedHeight(panelRef, boardKey);
  // Each view keeps its own place: the Board's, or the one Workspace's floating
  // panel was put at. Read again when the panel changes view or floats.
  const keyRef = useRef(key);
  useLayoutEffect(() => {
    if (keyRef.current === key) return;
    keyRef.current = key;
    setPlace(parsePlace(readStored(key)));
  }, [key]);
  // A panel that docks takes nothing of its floating self into the column: no
  // held height, no cap of the stack.
  useLayoutEffect(() => {
    if (mode !== "docked") return;
    panelRef.current?.style.removeProperty("min-height");
    panelRef.current?.style.removeProperty("max-height");
  }, [mode]);

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
    // The other panel gives way as this one passes over it, not after.
    fitStack();
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
      d.room = roomOf(el, event.currentTarget);
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
    d.at = dragBox(d.start.left + dx, d.start.top + dy, d.start.width, d.room!);
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
    // A floating part has no home slot to snap to: the column is its home.
    keep(mode !== "float" && nearHome(d.at, d.home) ? null : placeOf(d.at.left, d.at.top, d.start.width, d.room!.w));
  };
  const onPointerCancel = () => {
    if (!drag.current) return;
    draw(null);
    finish();
  };
  const onDoubleClick = (event: MouseEvent<HTMLElement>) => {
    if (interactive(event.target)) return;
    // Popped out of Workspace's column: back into it.
    if (mode === "float") { dock?.dock(); return; }
    if (!place) return;
    keep(null);
  };
  /** Out of the column, over the view. Where it floated last in Workspace, or
   *  the first time beside the column at the height it was docked at (left of
   *  it while there is room), kept from the nearer edge as any place is. */
  const popOut = () => {
    const el = panelRef.current;
    if (el && !parsePlace(readStored(floatKey(boardKey)))) {
      const r = el.getBoundingClientRect();
      const width = 320;
      const left = r.left - width - 8 >= 0 ? r.left - width - 8 : r.left;
      writeStored(floatKey(boardKey), JSON.stringify(placeOf(left, r.top, width, window.innerWidth)));
    }
    dock?.popOut();
  };

  const placed = place && !phone && mode !== "docked" ? place : null;
  // The pair is fitted when this panel arrives or is put somewhere, before it
  // paints; when it leaves; and when the room around them changes: the window,
  // or the canvas column, which the detail panel and the rating row resize and
  // whose arrival moves a home slot. The minimap with them, at the same times,
  // but not while one is dragged: it would dodge the panel at every step.
  useLayoutEffect(() => { fitStack(); fitMinimap(); }, [placed?.edge, placed?.x, placed?.y]);
  useEffect(() => {
    window.addEventListener("resize", scheduleFit);
    const main = document.querySelector(".app main");
    const resized = main && typeof ResizeObserver !== "undefined" ? new ResizeObserver(scheduleFit) : null;
    if (main) resized?.observe(main);
    return () => {
      window.removeEventListener("resize", scheduleFit);
      resized?.disconnect();
      scheduleFit();
    };
  }, []);
  const panel = {
    ref: panelRef,
    "data-place": placed?.edge,
    // "docked" or "float" in Workspace (workspace.css draws the column); none on the Board.
    "data-dock": mode === "board" ? undefined : mode,
    "data-fold": mode === "docked" && dock?.folded ? "" : undefined,
    style: placed ? ({ "--place-x": `${placed.x}px`, "--place-y": `${placed.y}px` } as CSSProperties) : undefined,
  };
  // A docked part does not move: its header holds its buttons and nothing else.
  const grip = phone || mode === "docked" ? {} : {
    "data-grip": "",
    title: t(mode === "float" ? "shell.side.dragToDock" : "shell.dragToMove"),
    onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onLostPointerCapture: onPointerCancel, onDoubleClick,
  };
  return { place: placed, panel, grip, mode, popOut };
}
