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
  /** The agent the request opened the view on: the row and file it names
   *  are that agent's, and another agent the view follows never opens on them. */
  agentId?: string | null;
}

export const CLOSED_REQUEST: GitViewRequest = { open: false, how: "key", seq: 0, focusInside: false };

let current: GitViewRequest = CLOSED_REQUEST;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** The request now, outside React. */
export const gitViewRequest = (): GitViewRequest => current;

/** Ask the view to open on the selection. */
export function openGitViewRequest(how: GitViewHow, hints: { focusInside?: boolean; sel?: string | null; file?: GitFileRef | null; agentId?: string | null } = {}): void {
  set({ open: true, how, seq: current.seq + 1, focusInside: hints.focusInside ?? how === "key", sel: hints.sel, file: hints.file, agentId: hints.agentId ?? null });
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

// `n` takes the newest diff of the file the open view shows — from inside the
// view, and from the deck while the view is open. The view installs it.
let newest: (() => void) | null = null;
export function setGitViewNewest(fn: (() => void) | null): void { newest = fn; }
export function gitViewNewest(): void { newest?.(); }

// The glance's rows open the view through the page's own opener, which checks
// the folder can be read and remembers what had focus. The page installs it.
type ViewOpener = (how: GitViewHow, hints: { agentId?: string; focusInside?: boolean; sel?: string | null; file?: GitFileRef | null }) => void;
let viewOpener: ViewOpener | null = null;
export function setGitViewOpener(fn: ViewOpener | null): void { viewOpener = fn; }
export function openGitViewFrom(how: GitViewHow, hints: Parameters<ViewOpener>[1]): void { viewOpener?.(how, hints); }

// A collision line's way to the other agent: select it and bring it into
// view. The page installs it.
let agentFocuser: ((id: string) => void) | null = null;
export function setGitAgentFocuser(fn: ((id: string) => void) | null): void { agentFocuser = fn; }
export function focusAgentFrom(id: string): void { agentFocuser?.(id); }
