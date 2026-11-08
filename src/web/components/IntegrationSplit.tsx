// The list and the detail of an integration panel (#2178), side by side with a
// divider between them the reader can drag — an ARIA window splitter whose
// value is the list's width: the arrows move it by 32 (128 with Shift), Home
// and End go to the ends, Enter or a double click puts the automatic width
// back — and under 900px one screen at a time, the detail drilled into with a
// Back that returns to the row. The divider is its own control: a 6px zone
// with a grip, apart from the dialog's own edges, and it never moves the
// dialog.
//
// The core's, not a provider's: every tracker panel is a list of things and
// the one thing chosen, and each gets the same split and the same memory of
// its width (integrations/layout.ts). The list is held between 280px and 60 %
// of the room; until the reader drags it, it takes what the provider's
// automatic detail share leaves.
//
// What the host does for every panel, so none has to:
// - Escape closes an open detail before it closes the modal, at every width:
//   the detail is an entry on the deck's dismiss stack while it is open, and a
//   search field or a picker opened after it answers first (IntegrationSearch,
//   AnchoredPopover). It calls `onBack`, which is where a panel puts focus
//   back on the row; if focus is left nowhere, the host puts it on the
//   control that opened the detail.
// - On the drill-in screen, a detail that opens while focus is on the hidden
//   list, or nowhere, takes focus on Back rather than dropping it to the page.
// - Motion, all of it in CSS and answered under reduced motion
//   (integrations.css): side by side, each new `detailKey` fades the detail's
//   content in over 120ms and no width ever animates; drilled in, the detail
//   screen comes in from 8px over 160ms, and Back takes it out the same way
//   in 120ms, laid over the list as it returns. Under reduced motion the
//   screens change at once, with a fade at most.
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import {
  autoList, clampList, DETAIL_SHARE, DRILL_IN_QUERY, LIST_STEP, LIST_STEP_LARGE, LIST_WIDTH, listCss, listMost, readSplitWidth, splitCss, splitList,
  writeListWidth, type SplitWidth,
} from "../integrations/layout";
import { useT } from "../i18n";
import { modalStack } from "../modal-dismiss";
import { useMediaQuery } from "../use-media-query";
import { prefersReducedMotion } from "../viewport-motion";

function Splitter({ width, workspace, controls, onCommit, automaticDetailShare }: {
  width: SplitWidth; workspace: RefObject<HTMLDivElement>; controls: string; onCommit: (width: number | null) => void; automaticDetailShare: number;
}) {
  const t = useT();
  const self = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number; room: number; last: number } | null>(null);
  const room = () => workspace.current?.clientWidth ?? window.innerWidth;
  const shown = splitList(width, room(), automaticDetailShare);
  const apply = (next: number) => {
    workspace.current?.style.setProperty("--ig-list-w", listCss(next));
    self.current?.setAttribute("aria-valuenow", String(next));
  };
  const commit = (next: number | null) => {
    if (next == null) {
      workspace.current?.style.setProperty("--ig-list-w", listCss(null, automaticDetailShare));
      self.current?.setAttribute("aria-valuenow", String(autoList(room(), automaticDetailShare)));
    } else apply(next);
    onCommit(next);
  };
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width: shown, room: room(), last: shown };
    workspace.current?.setAttribute("data-resizing", "");
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.last = clampList(d.width + event.clientX - d.x, d.room);
    apply(d.last);
  };
  const end = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    workspace.current?.removeAttribute("data-resizing");
    commit(d.last);
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? LIST_STEP_LARGE : LIST_STEP;
    if (event.key === "Enter") { event.preventDefault(); commit(null); return; }
    const next = event.key === "ArrowLeft" ? shown - step
      : event.key === "ArrowRight" ? shown + step
      : event.key === "Home" ? LIST_WIDTH.min
      : event.key === "End" ? listMost(room()) : null;
    if (next === null) return;
    event.preventDefault();
    commit(clampList(next, room()));
  };
  return (
    <div ref={self} className="ig-splitter" role="separator" aria-orientation="vertical" aria-label={t("integrations.split.listWidth")}
      aria-controls={controls} aria-valuemin={LIST_WIDTH.min} aria-valuemax={listMost(room())} aria-valuenow={shown}
      tabIndex={0} title={t("integrations.split.resize")}
      onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
      onDoubleClick={() => commit(null)} onKeyDown={key}>
      <span className="ig-splitter-grip" aria-hidden="true" />
    </div>
  );
}

export interface IntegrationSplitProps {
  list: ReactNode;
  /** The chosen thing, or null for none (the list takes the whole width). */
  detail: ReactNode | null;
  /** Closes the detail: Back on the drill-in screen, and Escape at any width. */
  onBack: () => void;
  /** What Back says it returns to: "Back to the board". */
  backLabel: string;
  /** Whose list width this is, remembered per browser: "jira". */
  storageKey: string;
  /** The detail's share of the workspace until a list width is saved (the
   *  list takes the rest); default 0.5. */
  automaticDetailShare?: number;
  /** Which thing the detail shows (its key or id). A new one fades the
   *  detail's content in, or brings the drill-in screen in; without it only
   *  the opening of a detail does. */
  detailKey?: string;
}

/** Whether the detail is a screen of its own rather than a column. */
export function useDrillIn(): boolean {
  return useMediaQuery(DRILL_IN_QUERY);
}

export default function IntegrationSplit({ list, detail, onBack, backLabel, storageKey, detailKey, automaticDetailShare = DETAIL_SHARE }: IntegrationSplitProps) {
  const t = useT();
  const drillIn = useDrillIn();
  const splitId = useId();
  const detailId = `${splitId}-detail`;
  const listId = `${splitId}-list`;
  const workspace = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const [width, setWidth] = useState<SplitWidth>(() => readSplitWidth(storageKey));
  const commit = (next: number | null) => { setWidth(next == null ? null : { list: next }); writeListWidth(storageKey, next); };
  const open = detail != null;

  // Back, on a narrow screen: the detail that was showing stays mounted, as it
  // was, for the 120ms it takes to leave over the returning list. Decided while
  // rendering, so the closing render already holds it and nothing remounts.
  const lastDetail = useRef<ReactNode>(null);
  if (open) lastDetail.current = detail;
  const [wasOpen, setWasOpen] = useState(open);
  const [leaving, setLeaving] = useState<ReactNode>(null);
  if (wasOpen !== open) {
    setWasOpen(open);
    setLeaving(!open && drillIn && !prefersReducedMotion() ? lastDetail.current : null);
  }
  const shown = open ? detail : leaving;
  const isLeaving = !open && leaving != null;
  useEffect(() => {
    if (!isLeaving) return;
    const t = window.setTimeout(() => setLeaving(null), 200);
    return () => window.clearTimeout(t);
  }, [isLeaving]);
  useLayoutEffect(() => {
    // Out of the tab order and the accessibility tree while it leaves.
    if (detailRef.current) detailRef.current.inert = isLeaving;
  }, [isLeaving]);

  // A new thing in the detail restarts its entrance: the attribute flips
  // between two names for the same keyframes, before the frame is painted.
  useLayoutEffect(() => {
    const el = detailRef.current;
    if (!el || !open) return;
    el.dataset.flip = el.dataset.flip === "a" ? "b" : "a";
  }, [open, detailKey]);

  // Focus: remember what opened the detail, and on the drill-in screen never
  // leave focus on the hidden list, or on what the panel hid with it (Jira's
  // toolbar, where the modal put focus before an issue was put back).
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && listRef.current?.contains(active)) opener.current = active;
    const hidden = active instanceof HTMLElement && !(active.checkVisibility?.() ?? true);
    if (drillIn && (!active || active === document.body || hidden || listRef.current?.contains(active))) {
      backRef.current?.focus({ preventScroll: true });
    }
  }, [open, drillIn, detailKey]);
  useEffect(() => {
    if (open) return;
    const el = opener.current;
    if (!el) return;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if ((!active || active === document.body) && el.isConnected && (el.checkVisibility?.() ?? true)) el.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // Escape closes the detail first, at every width.
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  useEffect(() => {
    if (!open) return;
    return modalStack.push(() => onBackRef.current(), 0, "popover");
  }, [open]);

  return (
    <div ref={workspace} className="ig-split" data-detail={open || undefined} data-drill-in={drillIn || undefined}
      style={{ "--ig-list-w": splitCss(width, automaticDetailShare) } as CSSProperties}>
      {/* The list stays mounted on the drill-in screen, only hidden, so its
          scroll and its open groups are where the reader left them. */}
      <div ref={listRef} className="ig-list" id={listId} hidden={(drillIn && open) || undefined}>{list}</div>
      {open && !drillIn && <Splitter width={width} workspace={workspace} controls={listId} onCommit={commit} automaticDetailShare={automaticDetailShare} />}
      {shown != null && (
        <section ref={detailRef} className="ig-detail" id={detailId} aria-label={t("integrations.split.details")} data-leaving={isLeaving || undefined}
          onAnimationEnd={event => { if (isLeaving && event.target === event.currentTarget) setLeaving(null); }}>
          {drillIn && (
            <button ref={backRef} type="button" className="ig-back" data-ig-back onClick={onBack}>
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M8.6 3 4.6 7l4 4" /></svg>
              {backLabel}
            </button>
          )}
          {shown}
        </section>
      )}
    </div>
  );
}
