// The list and the detail of an integration panel (#2178), side by side with a
// line between them the reader can drag — Tool activity's splitter, an ARIA
// window splitter: arrows move it, Home and End go to the ends, Enter or a
// double click puts the automatic width back — and under 900px one screen at
// a time, the detail drilled into with a Back that returns to the row.
//
// The core's, not a provider's: every tracker panel is a list of things and
// the one thing chosen, and each gets the same split and the same memory of
// its width (integrations/layout.ts). Until the reader drags it the detail
// defaults to half the room, or the provider's automatic share, never under
// 320px nor so much that the list goes
// under 420px.
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
import { autoDetailCss, autoDetail, DETAIL_SHARE, clampDetail, DETAIL_WIDTH, DRILL_IN_QUERY, readDetailWidth, writeDetailWidth } from "../integrations/layout";
import { useT } from "../i18n";
import { modalStack } from "../modal-dismiss";
import { useMediaQuery } from "../use-media-query";
import { prefersReducedMotion } from "../viewport-motion";

function Splitter({ width, workspace, controls, onCommit, automaticDetailShare }: {
  width: number | null; workspace: RefObject<HTMLDivElement>; controls: string; onCommit: (width: number | null) => void; automaticDetailShare: number;
}) {
  const t = useT();
  const self = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number; room: number; last: number } | null>(null);
  const room = () => workspace.current?.clientWidth ?? window.innerWidth;
  const shown = width == null ? autoDetail(room(), automaticDetailShare) : clampDetail(width, room());
  const apply = (next: number) => {
    workspace.current?.style.setProperty("--ig-detail-w", `${next}px`);
    self.current?.setAttribute("aria-valuenow", String(next));
  };
  const commit = (next: number | null) => {
    if (next == null) {
      workspace.current?.style.setProperty("--ig-detail-w", autoDetailCss(automaticDetailShare));
      self.current?.setAttribute("aria-valuenow", String(autoDetail(room(), automaticDetailShare)));
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
    d.last = clampDetail(d.width + d.x - event.clientX, d.room);
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
    const step = event.shiftKey ? 64 : 16;
    if (event.key === "Enter") { event.preventDefault(); commit(null); return; }
    const next = event.key === "ArrowLeft" ? shown + step
      : event.key === "ArrowRight" ? shown - step
      : event.key === "Home" ? DETAIL_WIDTH.min
      : event.key === "End" ? DETAIL_WIDTH.max : null;
    if (next === null) return;
    event.preventDefault();
    commit(clampDetail(next, room()));
  };
  return <div ref={self} className="ig-splitter" role="separator" aria-orientation="vertical" aria-label={t("integrations.split.width")}
    aria-controls={controls} aria-valuemin={DETAIL_WIDTH.min} aria-valuemax={clampDetail(DETAIL_WIDTH.max, room())} aria-valuenow={shown}
    tabIndex={0} title={t("integrations.split.resize")}
    onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
    onDoubleClick={() => commit(null)} onKeyDown={key} />;
}

export interface IntegrationSplitProps {
  list: ReactNode;
  /** The chosen thing, or null for none (the list takes the whole width). */
  detail: ReactNode | null;
  /** Closes the detail: Back on the drill-in screen, and Escape at any width. */
  onBack: () => void;
  /** What Back says it returns to: "Back to the board". */
  backLabel: string;
  /** Whose detail width this is, remembered per browser: "jira". */
  storageKey: string;
  /** Fraction of the workspace used until a pixel width is saved; default 0.5. */
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
  const detailId = `${useId()}-detail`;
  const workspace = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const [width, setWidth] = useState<number | null>(() => readDetailWidth(storageKey));
  const commit = (next: number | null) => { setWidth(next); writeDetailWidth(storageKey, next); };
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
      style={{ "--ig-detail-w": width == null ? autoDetailCss(automaticDetailShare) : `${width}px` } as CSSProperties}>
      {/* The list stays mounted on the drill-in screen, only hidden, so its
          scroll and its open groups are where the reader left them. */}
      <div ref={listRef} className="ig-list" hidden={(drillIn && open) || undefined}>{list}</div>
      {open && !drillIn && <Splitter width={width} workspace={workspace} controls={detailId} onCommit={commit} automaticDetailShare={automaticDetailShare} />}
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
