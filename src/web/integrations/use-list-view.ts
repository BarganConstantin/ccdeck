// An integration panel's chosen item and its two scrolls, kept per list in
// view-memory.ts (#2178, #2179): the Jira panel and the forges' share it.
//
//   const view = useListView({ listKey, drawn, same, sideBySide, root, listScroller });
//   view.selection     what the detail shows, or null
//   view.auto          put there by the panel (the remembered item put back,
//                      or the list's first row)
//   view.choose(next)  the reader's own choice: a row, a link, or null (Close)
//
// ON ARRIVAL at a list — the panel mounting as the modal opens, or another
// board, project or tab — the remembered view is read back and `arrive`
// decides, once the list says what it has drawn. Until then the detail is
// empty, never a wrong item for a moment. Decided before the browser paints
// (layout effects), so a list drawn from what was kept opens as it was left.
//
// THE PANEL'S CHOICE IS QUIET. An item put back, or a first row opened, moves
// no focus and is not the reader's: a panel draws it like any other selection
// and leaves focus where the modal put it. `auto` says which, for a detail
// that would otherwise move focus once its item is read.
//
// SCROLLS are recorded as the reader scrolls (one listener on the panel,
// catching both scrollers' scroll events) and put back on arrival, waiting
// for the rows or the item to be tall enough. A scroller being put back is
// not recorded, so a list still loading never overwrites where it was.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type RefObject } from "react";
import { choose as chooseIn, enter, keepList, settle, type Drawn, type ViewState } from "./view-memory";

/** A layout effect in the browser, and nothing on the server, where the suite
 *  draws components to markup and a layout effect only warns. */
export const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** How long a scroll waits for its content, while it is on screen. */
const RESTORE_MS = 3000;
/** What the reader does that ends a restore: their own scroll wins. */
const READER_INPUT = ["wheel", "pointerdown", "touchstart", "keydown"] as const;

/**
 * Scrolls `el` to `top` once its content is tall enough: at once when it is,
 * else as the content arrives, until the reader scrolls or presses in it, or
 * three seconds pass with it on screen. A scroller that is not on screen (a
 * phone's list under its detail) waits until it is. `done` is called once,
 * however it ends; the stop it returns ends it early.
 */
export function restoreScroll(el: HTMLElement, top: number, done: () => void): () => void {
  let over = false;
  let frame = 0;
  let deadline = 0;
  let watch: ResizeObserver | null = null;
  const finish = () => {
    if (over) return;
    over = true;
    cancelAnimationFrame(frame);
    watch?.disconnect();
    for (const type of READER_INPUT) el.removeEventListener(type, finish);
    done();
  };
  const attempt = () => {
    if (over) return;
    if (!el.isConnected) { finish(); return; }
    if (el.clientHeight === 0) {
      // Hidden: wait for it to come back, without counting the time.
      if (!watch && typeof ResizeObserver !== "undefined") {
        watch = new ResizeObserver(() => {
          if (el.clientHeight === 0) return;
          watch?.disconnect();
          watch = null;
          attempt();
        });
        watch.observe(el);
      }
      return;
    }
    if (!deadline) deadline = performance.now() + RESTORE_MS;
    const room = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = Math.min(top, room);
    if (room >= top || performance.now() >= deadline) { finish(); return; }
    frame = requestAnimationFrame(attempt);
  };
  for (const type of READER_INPUT) el.addEventListener(type, finish, { passive: true });
  attempt();
  return finish;
}

export interface ListViewOptions<S> {
  /** The list on show (view-memory.ts `listKey`). */
  listKey: string;
  /** What `listKey`'s list has drawn, or null while it draws nothing of its
   *  own yet (another list's rows, a board still unread). */
  drawn: Drawn<S> | null;
  /** Whether two selections are the same item. */
  same: (a: S, b: S) => boolean;
  /** The detail opens beside the list (not a screen of its own, below
   *  900px), so a first row can open without hiding the list. */
  sideBySide: boolean;
  /** The panel's own box: the scrollers are found inside it. */
  root: RefObject<HTMLElement | null>;
  /** The list's scroller inside `root`: ".jr-list-scroll". The detail's is
   *  the host's `.ig-detail` (IntegrationSplit). */
  listScroller: string;
}

export interface ListView<S> {
  selection: S | null;
  /** The panel put `selection` there, not the reader. */
  auto: boolean;
  /** The reader's choice: a row pressed, a link followed, or null for the
   *  detail closed (Close, Back, Escape), which this list then remembers. */
  choose: (next: S | null) => void;
}

const DETAIL_SCROLLER = ".ig-detail";

export function useListView<S>({ listKey, drawn, same, sideBySide, root, listScroller }: ListViewOptions<S>): ListView<S> {
  const [state, setState] = useState<ViewState<S>>(() => enter<S>(listKey, true));
  // Another list: its own memory, decided afresh. Set while rendering, so the
  // other list's item is never drawn beside this list's rows.
  let current = state;
  if (state.key !== listKey) {
    current = enter<S>(listKey, false);
    setState(current);
  }
  const latest = useRef(current);
  latest.current = current;
  const sameRef = useRef(same);
  sameRef.current = same;

  // Put the scrolls back, after the item the plan came with is drawn. Its
  // own entrance (a forge page starts at the top) runs first, in the child.
  const restoringList = useRef(false);
  const restoringDetail = useRef(false);
  const plan = current.plan;
  useBeforePaint(() => {
    const box = root.current;
    if (!plan || !box) return;
    const stops: (() => void)[] = [];
    const put = (restoring: MutableRefObject<boolean>, selector: string, top: number | null) => {
      const el = top == null ? null : box.querySelector<HTMLElement>(selector);
      if (!el || top == null) return;
      restoring.current = true;
      stops.push(restoreScroll(el, top, () => { restoring.current = false; }));
    };
    put(restoringList, listScroller, plan.list);
    put(restoringDetail, DETAIL_SCROLLER, plan.detail);
    return () => { for (const stop of stops) stop(); };
  }, [plan, root, listScroller]);

  // Decide, once the list has drawn enough to.
  useBeforePaint(() => {
    const next = settle(current, drawn, sideBySide);
    if (next !== current) setState(next);
  }, [current, drawn, sideBySide]);

  // Record both scrolls as the reader scrolls. A scroll event does not
  // bubble, so one listener catches them on their way down.
  useEffect(() => {
    const box = root.current;
    if (!box) return;
    const onScroll = (event: Event) => {
      const el = event.target;
      if (!(el instanceof HTMLElement)) return;
      if (el.matches(DETAIL_SCROLLER)) {
        if (!restoringDetail.current) keepList<S>(latest.current.key, { detailTop: el.scrollTop });
      } else if (el.matches(listScroller)) {
        if (!restoringList.current) keepList<S>(latest.current.key, { listTop: el.scrollTop });
      }
    };
    box.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => box.removeEventListener("scroll", onScroll, { capture: true });
  }, [root, listScroller]);

  // An item the reader opened starts where its pane is now: at the top for a
  // forge page, which resets it, and wherever the last issue left it in
  // Jira's. Recorded once it is drawn, so a reader who does not scroll it
  // finds it that way again.
  const { selection, auto } = current;
  useBeforePaint(() => {
    if (auto || !selection || restoringDetail.current) return;
    const pane = root.current?.querySelector<HTMLElement>(DETAIL_SCROLLER);
    keepList<S>(latest.current.key, { detailTop: pane?.scrollTop ?? 0 });
  }, [selection, auto, root]);

  const choose = useCallback((next: S | null) => setState(chooseIn(latest.current, next, sameRef.current)), []);

  return { selection, auto, choose };
}
