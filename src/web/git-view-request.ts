// Whether the git view is asked to be open, how, and on what — one value for
// the page, kept outside React like git-pref.ts. The keys, the card chip and
// the glance write it; only the view subscribes, so pressing `g` re-renders
// the view and nothing else on the deck.
import { useSyncExternalStore } from "react";

import type { GitFileRef } from "./git-view-types";

/** How a request reached the view: a pointer animates, a key does not. */
export type GitViewHow = "pointer" | "key";

export interface GitViewRequest {
  open: boolean;
  how: GitViewHow;
  /** Bumped on every request, so a second open with new hints is seen. */
  seq: number;
  /** Put keyboard focus in the view once it is open: the keyboard opened it,
   *  or a glance row did, which the open panel covers. */
  focusInside: boolean;
  /** The history row and file to open on, when a glance row named them. */
  sel?: string | null;
  file?: GitFileRef | null;
}

export const CLOSED_REQUEST: GitViewRequest = { open: false, how: "key", seq: 0, focusInside: false };

let current: GitViewRequest = CLOSED_REQUEST;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** The request now, outside React. */
export const gitViewRequest = (): GitViewRequest => current;

/** Ask the view to open on the selection. */
export function openGitViewRequest(how: GitViewHow, hints: { focusInside?: boolean; sel?: string | null; file?: GitFileRef | null } = {}): void {
  set({ open: true, how, seq: current.seq + 1, focusInside: hints.focusInside ?? how === "key", sel: hints.sel, file: hints.file });
}

/** Ask the view to close; nothing when it is not open. */
export function closeGitViewRequest(how: GitViewHow): void {
  if (current.open) set({ ...current, open: false, how, seq: current.seq + 1, focusInside: false });
}

function set(next: GitViewRequest): void {
  current = next;
  for (const l of listeners) l();
}

/** The request, re-rendering the caller when it changes. */
export function useGitViewRequest(): GitViewRequest {
  return useSyncExternalStore(subscribe, gitViewRequest, gitViewRequest);
}
