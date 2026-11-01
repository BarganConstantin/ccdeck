// The rail's motion, read from V4's tokens rather than spelled again. A curve
// or a time handed to the Web Animations API cannot be a var(), so it is read
// off the root, the way use-appearance.ts reads a palette; the fallbacks are
// tokens.css's own values, for a page the sheet has not reached.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { prefersReducedMotion } from "./viewport-motion";
import { joinMotion, measureGate, membershipChange, releaseMotion } from "./rail-model";

const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

const FALLBACK: Record<string, string> = {
  "--dur-fast": "120ms", "--dur-exit": "150ms", "--dur-base": "200ms", "--dur-move": "240ms",
  "--ease": "cubic-bezier(0.23, 1, 0.32, 1)", "--ease-stage": "cubic-bezier(0.32, 0.72, 0, 1)",
};

export function motionToken(name: string): string {
  const read = typeof document === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return read || FALLBACK[name] || "";
}

/** A CSS time in milliseconds. The unit matters: tokens.css says 240ms, but the
 *  built sheet's minifier writes it .24s, and read as a bare number that is a
 *  quarter of a millisecond. */
export function durationMs(text: string): number {
  const v = parseFloat(text);
  if (!Number.isFinite(v)) return 0;
  return /\dms$/i.test(text.trim()) ? v : /\ds$/i.test(text.trim()) ? v * 1000 : v;
}

/** A duration token in milliseconds. */
export function tokenMs(name: string): number {
  return durationMs(motionToken(name));
}

/** The delay a leaving row waits before its space closes, with the fade it
 *  waits for: 100ms of card 124:670. */
export const LEAVE_SPACE_DELAY_MS = 100;

/** How long a row that has left stays drawn, inert, before it goes: the fade,
 *  then the space closing after its delay; reduced, the fade alone. */
export function leaveHoldMs(reduced: boolean): number {
  return reduced ? tokenMs("--dur-exit") : LEAVE_SPACE_DELAY_MS + tokenMs("--dur-base");
}

/** A short fade in on one element: a glyph whose kind has changed. */
export function fadeIn(el: HTMLElement | null): void {
  el?.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: tokenMs("--dur-fast"), easing: motionToken("--ease") });
}

const FLIP_ID = "rail-flip";

/** Where a row sits in the list's own coordinates with any transform an
 *  animation has put on it taken off, and how far that transform has moved it.
 *  The first is the row's place; their sum is where the eye sees it. */
function place(list: HTMLElement, el: HTMLElement): { top: number; shift: number } {
  // Only a row mid-move has a transform to take off; the others cost no style read.
  const flying = el.getAnimations?.().some(a => a.id === FLIP_ID) ?? false;
  const shift = flying ? new DOMMatrixReadOnly(getComputedStyle(el).transform).m42 : 0;
  const top = el.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop - shift;
  return { top, shift };
}

/** Every row's place, by id. Relative to the list and counting its scroll, so
 *  scrolling does not make them stale. */
function record(list: HTMLElement): Map<string, { top: number; shift: number }> {
  const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-rail-id]"));
  return new Map(rows.map(el => [el.dataset.railId!, place(list, el)]));
}

/** The animations a list's rows are running, as far as cancelling goes. */
interface Flier { getAnimations?: () => { id: string; cancel: () => void }[] }

/** Cancels the rows' running moves, and only when the drawn order or the hold
 *  has changed (`changed`): a render that changed nothing leaves them to run
 *  their whole --dur-move. Returns how many it cancelled. */
export function cancelFlights(rows: readonly Flier[], changed: boolean): number {
  if (!changed) return 0;
  let n = 0;
  for (const el of rows) for (const a of el.getAnimations?.() ?? []) if (a.id === FLIP_ID) { a.cancel(); n++; }
  return n;
}

/** A move or fade the rail started and is waiting out. */
interface Flight { el: HTMLElement; kind: "move" | "fade"; from: number; start: number; dur: number }

/** Starts again, for the time left, a flight whose animation is gone before
 *  its time is up. */
function reviveFlights(flights: Map<string, Flight>, now: number): void {
  for (const [id, f] of flights) {
    const left = f.start + f.dur - now;
    if (left <= 0) { flights.delete(id); continue; }
    if (!f.el.isConnected) { flights.delete(id); continue; }
    if (f.el.getAnimations?.().some(a => a.id === FLIP_ID)) continue;
    const p = left / f.dur;
    if (f.kind === "move") {
      f.el.animate([{ transform: `translateY(${f.from * p}px)` }, { transform: "translateY(0)" }],
        { id: FLIP_ID, duration: left, easing: motionToken("--ease-stage") });
    } else {
      f.el.animate([{ opacity: 1 - p }, { opacity: 1 }], { id: FLIP_ID, duration: left, easing: motionToken("--ease") });
    }
  }
}

/** Every row travels once to its new place when the drawn order changes with
 *  nobody aiming at the list: FLIP, from where each row is on screen, so a
 *  change that lands mid-move starts from the row's current place. `signature`
 *  is the drawn order; it moves only when a row would. While the pointer or
 *  focus is on the list (`held`) the order is frozen and nothing travels.
 *
 *  Rows are measured only when the signature or the hold changes (the clock
 *  renders the rail four times a second), and again when the list is resized;
 *  the resize plays nothing. */
export function useRailFlip(listRef: RefObject<HTMLElement | null>, signature: string, held: boolean): void {
  const memo = useRef<{ signature: string; tops: Map<string, number> }>({ signature: "", tops: new Map() });
  const gate = useState(measureGate)[0];
  const flights = useRef(new Map<string, Flight>());
  useBeforePaint(() => {
    const list = listRef.current;
    if (!list) return;
    const changed = gate.check(signature, held);
    // A render that changed nothing leaves a running move alone. Only if a row
    // was lifted out of the DOM and put back (React moving a sibling does that,
    // and the browser cancels the animations of a removed element) is its move
    // started again, for the time it had left.
    if (!changed) { reviveFlights(flights.current, performance.now()); return; }
    const here = record(list);
    if (!held && memo.current.signature && memo.current.signature !== signature) {
      const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-rail-id]"));
      const moved: { el: HTMLElement; from: number }[] = [];
      for (const el of rows) {
        const was = memo.current.tops.get(el.dataset.railId!);
        if (was == null || el.classList.contains("leaving")) continue;
        const now = here.get(el.dataset.railId!)!;
        const from = was + now.shift - now.top;
        if (Math.abs(from) > 0.5) moved.push({ el, from });
      }
      const how = releaseMotion({ moved: moved.length, reduced: prefersReducedMotion() });
      // A change mid-move retargets: `from` above is each row's place on screen
      // now, so the old move is dropped and the new one starts from there.
      cancelFlights(rows, true);
      flights.current.clear();
      const fade = { id: FLIP_ID, duration: tokenMs("--dur-fast"), easing: motionToken("--ease") };
      const start = performance.now();
      if (how === "flip") {
        const dur = tokenMs("--dur-move");
        for (const { el, from } of moved) {
          el.animate([{ transform: `translateY(${from}px)` }, { transform: "translateY(0)" }],
            { id: FLIP_ID, duration: dur, easing: motionToken("--ease-stage") });
          flights.current.set(el.dataset.railId!, { el, kind: "move", from, start, dur });
        }
      } else if (how === "crossfade") {
        list.animate([{ opacity: 0 }, { opacity: 1 }], fade);
      } else if (how === "fade-moved") {
        for (const { el } of moved) {
          el.animate([{ opacity: 0 }, { opacity: 1 }], fade);
          flights.current.set(el.dataset.railId!, { el, kind: "fade", from: 0, start, dur: fade.duration });
        }
      }
    }
    memo.current = { signature, tops: new Map(Array.from(here, ([id, p]) => [id, p.top])) };
  });
  // A resized list moves its rows with the order unchanged: take the places
  // again and play nothing.
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => {
      memo.current = { ...memo.current, tops: new Map(Array.from(record(list), ([id, p]) => [id, p.top])) };
    });
    watch.observe(list);
    return () => watch.disconnect();
  }, [listRef]);
}

/** A row that is really new opens its space and fades in; one that is really
 *  gone fades, then its space closes after 100ms (card 124:670). Driven from
 *  here, by id, and not by the sheet's @starting-style: moving an element in
 *  the DOM (into a fold, out of a ghost) drops its style and would play the
 *  arrival again on top of the FLIP. `ids` are the rows the model holds now,
 *  folded ones included; a leaving row is still drawn, inert, and the sheet
 *  holds its end state (.leaving: clear and closed). */
export function useRailMembership(listRef: RefObject<HTMLElement | null>, ids: readonly string[]): void {
  const before = useRef<ReadonlySet<string> | null>(null);
  useBeforePaint(() => {
    const list = listRef.current;
    const next = new Set(ids);
    const { joined, left } = membershipChange(before.current, next);
    before.current = next;
    if (!list || (joined.length === 0 && left.length === 0)) return;
    const how = joinMotion({ rows: next.size, reduced: prefersReducedMotion() });
    if (how === "instant") return;
    // Direct children only: a row inside an opening fold does not animate twice.
    const row = (id: string) => list.querySelector<HTMLElement>(`:scope > [data-rail-id="${CSS.escape(id)}"]`);
    const easing = motionToken("--ease");
    for (const id of joined) {
      const el = row(id);
      if (!el) continue;
      if (how === "fade") el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: tokenMs("--dur-fast"), easing });
      else el.animate([{ gridTemplateRows: "0fr", opacity: 0 }, { gridTemplateRows: "1fr", opacity: 1 }], { duration: tokenMs("--dur-base"), easing });
    }
    for (const id of left) {
      const el = row(id);
      if (!el) continue;
      // The backwards fill holds the start through the delay.
      el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: tokenMs("--dur-exit"), easing, fill: "backwards" });
      if (how === "fade") {
        // Reduced: the space closes at once, once the fade is done.
        el.animate([{ gridTemplateRows: "1fr" }, { gridTemplateRows: "1fr" }], { duration: tokenMs("--dur-exit"), fill: "backwards" });
      } else {
        el.animate([{ gridTemplateRows: "1fr" }, { gridTemplateRows: "0fr" }],
          { duration: tokenMs("--dur-base"), delay: LEAVE_SPACE_DELAY_MS, easing, fill: "backwards" });
      }
    }
  });
}
