// A small surface hung off one control, over everything around it.
//
// The accounts panel's `⋯` used to open its own row into a form — name field,
// slot picker, share, remove, all at once — and push every account under it
// down the column. This is what it opens now: a menu that overlays the panel,
// anchored to the button, and changes into the one small form an item needs
// once that item is chosen. The row underneath never changes height.
//
// ── what it owns ────────────────────────────────────────────────────────────
//
// The portal, the placement, and the dismissals a popover has that a modal
// does not. Escape, holding Tab inside a form view and the focus hand-back are
// useModalDismiss's, the same way SoundMenu takes them: that hook owns "an
// overlay that answers Escape, holds Tab, and gives focus back", and a second
// spelling of it here is the thing its own header warns against.
//
// PORTALLED, because the panel it opens from clips. `.accounts-panel` scrolls
// (`overflow: hidden auto`), so a popover positioned inside it is cut off at
// the panel's edge, and the last account's menu — the one nearest the bottom of
// the window — is exactly the one that needs to open upward past it. Drawn at
// the top of the document it is placed against the window by popover-place.ts
// and sits on the sound menu's layer: above the canvas, under every dialog.
//
// PLACED ON EVERY RENDER, NOT ONCE. The row it hangs off moves: the panel
// scrolls, the roster re-polls every fifteen seconds, a row above it grows a
// refusal. One getBoundingClientRect per render is cheap and cannot drift, and
// scroll and resize place it between renders. When the anchor scrolls out of
// the column that holds it, the popover closes rather than float over a row
// that is no longer on screen.
//
// ── as a menu ───────────────────────────────────────────────────────────────
//
// With `role="menu"` it also answers the keys a menu owes (menu-keys.ts): Up
// and Down walk the items, Home and End are the ends, and the pointer moves the
// same focus the arrows do, so the two never disagree about which item is
// current. Tab leaves the way focus came in — back to the anchor, and on to the
// control after it for a plain Tab — instead of stepping through four items
// the arrows already walk. In a form view Tab stays inside, which is the hook's
// trap and the sound menu's behaviour: a form's draft is not lost to a Tab.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { menuMove } from "../menu-keys";
import { placePopover } from "../popover-place";
import { useModalDismiss } from "./use-modal-dismiss";

interface Props {
  /** The control this hangs off, by id. Looked up at each placement rather
   *  than held, so a row re-rendered under it is followed rather than lost. */
  anchorId: string;
  /** The element the anchor scrolls inside. Once the anchor has left it, the
   *  popover closes. Named rather than discovered: finding it would mean
   *  asking the style engine about every ancestor on every scroll. */
  boundaryId?: string;
  id: string;
  className?: string;
  role: "menu" | "dialog";
  /** The element that names it: the anchor for a menu — whose own label
   *  already says whose actions these are — and a form view's title otherwise. */
  labelledBy: string;
  /** Which end of a menu focus starts at. ArrowUp on the anchor opens at the
   *  last item, the way a native menu button does. */
  start?: "first" | "last";
  /** Asked to go. By the time this runs, focus has been handed back to the
   *  anchor if it was inside — the caller only has to stop rendering it. */
  onClose: () => void;
  children: ReactNode;
}

const ITEM = '[role="menuitem"]';

/** The items the arrows can land on, in order. A disabled button cannot take
 *  focus, so it is not a stop — the same rule isTabbable applies to Tab. */
function itemsIn(root: HTMLElement | null): HTMLButtonElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLButtonElement>(ITEM)).filter(b => !b.disabled);
}

export default function AnchoredPopover({
  anchorId, boundaryId, id, className, role, labelledBy, start = "first", onClose, children,
}: Props) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Escape reaches this through App's one listener and the dismiss stack. It
  // hands focus to the anchor before closing, rather than leaving it to the
  // hook's restore on unmount: that restore goes to whatever was focused when
  // the popover mounted, and Safari does not focus a button it clicks, so there
  // it would be <body> and nothing would be restored at all.
  const ref = useModalDismiss<HTMLDivElement>(() => {
    document.getElementById(anchorId)?.focus();
    closeRef.current();
  });

  const place = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const anchor = document.getElementById(anchorId);
    // The row it hung off is gone — removed from another terminal, or moved.
    if (!anchor) { closeRef.current(); return; }
    const box = anchor.getBoundingClientRect();
    const clip = boundaryId ? document.getElementById(boundaryId)?.getBoundingClientRect() : null;
    if (clip && (box.bottom <= clip.top || box.top >= clip.bottom)) {
      // Scrolled away. Focus inside would fall to <body> as this unmounts, so it
      // goes to the anchor — without scrolling the column back to it, which
      // would undo the scroll that caused this.
      if (el.contains(document.activeElement)) anchor.focus({ preventScroll: true });
      closeRef.current();
      return;
    }
    // Measured at its natural height, so a popover that was squeezed last time
    // is allowed to grow back when there is room again.
    el.style.maxHeight = "";
    const p = placePopover(box, { width: el.offsetWidth, height: el.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight });
    el.style.top = `${p.top}px`;
    el.style.left = `${p.left}px`;
    el.style.maxHeight = p.maxHeight == null ? "" : `${p.maxHeight}px`;
    el.dataset.side = p.side;
  }, [anchorId, boundaryId, ref]);

  // Before paint, every render: the first one is what puts it beside the
  // anchor at all, and the rest follow a row that moved.
  useLayoutEffect(() => { place(); });

  useEffect(() => {
    // Capture, because the panel's scroll does not bubble to window. A scroll
    // inside the popover itself is its own content moving and is left alone —
    // re-measuring would reset it to the top.
    const onScroll = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return;
      place();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
    };
  }, [place, ref]);

  // A press anywhere else closes it — the rule SoundMenu spells out, for the
  // same reasons: `pointerdown` so a press that starts outside counts even if
  // it ends inside, on window in the capture phase so a control that stops
  // propagation still closes it first, and never for the anchor, whose own
  // onClick is what closes it on a second press. Focus is left where the press
  // put it: it landed on something the user chose.
  useEffect(() => {
    const onDown = (e: globalThis.PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || ref.current?.contains(t) || document.getElementById(anchorId)?.contains(t)) return;
      closeRef.current();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [anchorId, ref]);

  // Where a menu's focus starts. The hook's own mount focus has already put it
  // on the first item; this is what makes ArrowUp on the anchor land on the
  // last. Mount only — a menu that re-renders under a poll must not pull focus
  // back to an end.
  useEffect(() => {
    if (role !== "menu") return;
    const items = itemsIn(ref.current);
    (start === "last" ? items[items.length - 1] : items[0])?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (role === "menu" && e.key === "Tab") {
      // Out, the way focus came in. Stopped here so the form views' Tab trap —
      // which listens on window — never sees it. Shift+Tab lands on the anchor
      // itself; a plain Tab is left to the browser from the anchor, which
      // carries on to the control after it.
      e.stopPropagation();
      document.getElementById(anchorId)?.focus();
      if (e.shiftKey) e.preventDefault();
      closeRef.current();
      return;
    }
    if (role === "menu") {
      const items = itemsIn(ref.current);
      const move = menuMove(e, items.indexOf(document.activeElement as HTMLButtonElement), items.length);
      if (move.kind === "focus") {
        e.preventDefault();
        items[move.index].focus();
      }
    }
    // Nothing typed in here is a canvas shortcut, and every one of those is a
    // single character. App's gate hands a button the MOUSE pressed back to
    // the shortcuts (#851), so a letter after clicking `Share` would otherwise
    // reach `r` — which clears every stored position with no undo. Named keys
    // travel on: the dismiss stack is waiting for one of them, and a form
    // view's trap for another.
    if (e.key.length === 1) e.stopPropagation();
  };

  // A press on the popover's own padding or title would move focus to <body>,
  // where the next letter is a canvas shortcut again. It keeps focus where it
  // was instead. Controls still take the press, and so does the share text,
  // which a press selects whole.
  const onMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (!(e.target as Element).closest("button, input, select, textarea, code")) e.preventDefault();
  };

  // The pointer and the arrows move one focus. Without this a hovered item and
  // a focused one could be two different rows, and the next Down would start
  // from the one the reader was not looking at. Touch has no hover to follow.
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (role !== "menu" || e.pointerType === "touch") return;
    const item = (e.target as Element).closest<HTMLButtonElement>(ITEM);
    if (item && !item.disabled && document.activeElement !== item) item.focus({ preventScroll: true });
  };

  return createPortal(
    <div
      ref={ref}
      id={id}
      className={`anchored-popover${className ? ` ${className}` : ""}`}
      role={role}
      aria-labelledby={labelledBy}
      onKeyDown={onKeyDown}
      onMouseDown={onMouseDown}
      onPointerMove={onPointerMove}
    >
      {children}
    </div>,
    document.body,
  );
}
