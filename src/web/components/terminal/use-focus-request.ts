// Keys into the pane when asked — now, or the moment there is a pane.
//
// A request belongs to the session it was made for. One that could not be met
// (the stage showed a card, not a pane) is dropped when the stage moves on:
// otherwise j would carry it to the next live pane, and the next Enter would
// land in that agent's prompt — an answer the reader never meant to give. A
// launch asks on its own, since its welcome screen waits for a first prompt.
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
  focus(): void;
}

export function useFocusRequest({ key, request, launch, typing, focus }: FocusRequest): void {
  const wanted = useRef<string | null>(null);
  // The subject's effect runs first, so a move that brings its own request
  // (the asks run, Enter on a tile) keeps it.
  useEffect(() => { wanted.current = launch ? key : null; }, [key]);
  useEffect(() => { if (request != null) wanted.current = key; }, [request]);
  useEffect(() => {
    if (wanted.current === key && typing) {
      wanted.current = null;
      focus();
    }
  });
}
