// Keys into the pane when asked — now, or the moment there is a pane.
//
// A request belongs to the session it was made for. One that could not be met
// (the stage showed a card, not a pane) is dropped when the stage moves on:
// otherwise j would carry it to the next live pane, and the next Enter would
// land in that agent's prompt — an answer the reader never meant to give. A
// launch asks on its own, since its welcome screen waits for a first prompt.
//
// A CARD IS AN ANSWER TOO. Once the stage has settled on a card instead of a
// pane — ended, not attachable, tmux missing, an error, the empty stage — the
// request is met by `land`, which puts the focus on the card's own action.
// Without it the focus stayed on what was pressed, a card or the Terminal
// button, inside a board about to go inert, and the browser dropped it on the
// body.
//
// A REQUEST SAYS HOW IT ENDED. Met in the pane, `focus` hears which request
// it was; answered by a card, dropped as the stage moved on, or replaced by a
// newer one, `unmet` does. The keys typed before the pane was ready wait on
// exactly one request (type-ahead.ts), and are handed over or let go by its
// end; a stage that closes with a request still open is use-stage.ts's to
// end. `typing` and `settled` are the shown subject's own, never the last
// one's (TerminalStage.tsx).
import { useEffect, useRef } from "react";

export interface FocusRequest {
  /** The subject on the stage (subjectKey). */
  key: string;
  /** The shell's focus token: a new value is a new request. */
  request: number | string | null | undefined;
  /** The subject is a launch, which asks for the keys by itself. */
  launch: boolean;
  /** The pane takes keys now. */
  typing: boolean;
  focus(request: FocusRequest["request"]): void;
  /** The stage shows a card that is its answer, not a pane on its way. */
  settled?: boolean;
  /** Focus onto the card's action; true once the request needs nothing more. */
  land?: () => boolean;
  /** The request ended without the pane taking the keys. */
  unmet?: (request: FocusRequest["request"]) => void;
}

export function useFocusRequest({ key, request, launch, typing, focus, settled = false, land, unmet }: FocusRequest): void {
  const wanted = useRef<{ key: string; request: FocusRequest["request"] } | null>(null);
  // The subject's effect runs first, so a move that brings its own request
  // (the asks run, Enter on a tile) keeps it.
  useEffect(() => {
    const was = wanted.current;
    wanted.current = launch ? { key, request } : null;
    if (was) unmet?.(was.request);
  }, [key]);
  useEffect(() => {
    if (request == null) return;
    const was = wanted.current;
    wanted.current = { key, request };
    if (was && was.request !== request) unmet?.(was.request);
  }, [request]);
  useEffect(() => {
    const want = wanted.current;
    if (want?.key !== key) return;
    if (typing) {
      wanted.current = null;
      focus(want.request);
    } else if (settled && land?.()) {
      wanted.current = null;
      unmet?.(want.request);
    }
  });
}
