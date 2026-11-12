// Whether the deck has no session yet: one answer, read by every part of the
// empty board. With no session the welcome hero speaks alone; the top bar's
// counts, the canvas bar's board controls, the minimap and the status bar's
// keys all act on sessions, so none of them is drawn, and they come back
// together with the first one.
import { createContext, useContext } from "react";
import type { GraphState } from "./graph-state";

/** No session on the deck: what puts the hero on the canvas. */
export function boardIsEmpty(state: Pick<GraphState, "agents">): boolean {
  return state.agents.size === 0;
}

/** App's answer, for whatever it draws. False by default, so a part drawn on
 *  its own (a test, a preview) keeps everything it has. */
export const BoardEmptyContext = createContext(false);

/** True while the deck has no session. */
export function useBoardEmpty(): boolean {
  // Some tests call a component as a plain function, outside React, where a
  // hook throws (as useLanguage allows for): there the board is not empty.
  try {
    return useContext(BoardEmptyContext);
  } catch {
    return false;
  }
}
