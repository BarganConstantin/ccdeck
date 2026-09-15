// Which recap notes have been put away.
//
// A recap's note opens by itself: the moment a session comes to rest with one
// is the moment it is worth reading, and the moment the person is least likely
// to be looking at that card. What the deck remembers is the opposite — which
// notes somebody closed — so a closed note stays closed through the re-renders
// a live canvas does four times a second and through a reload, and the next
// recap the session writes opens again, because it is a different key.
//
// Kept per recap, not per session: "I have read this one" is a fact about the
// sentence, not about the terminal it came from.
//
// A store rather than React context because the cards are React Flow nodes,
// rendered by React Flow from node data; threading a callback through every
// node's data would re-render the whole graph each time one note closed.
import { useSyncExternalStore } from "react";
import { readStored } from "./storage";

const DISMISSED_KEY = "agent-dag.recapsDismissed";
/** The bound the session-summary list keeps, for the same reason: this lives
 *  in localStorage, and sessions do not stop coming. */
const DISMISSED_CAP = 200;

function load(): string[] {
  const raw = readStored(DISMISSED_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x: unknown): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

let dismissed = new Set<string>(load());
const listeners = new Set<() => void>();
/** Moves on every change, for the canvas to rebuild on. */
let version = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function commit(next: Set<string>): void {
  dismissed = next;
  version++;
  if (typeof window !== "undefined") {
    try {
      // Insertion order is the order things were put away, so the slice keeps
      // the newest — and a note brought back and closed again moves to the end.
      const arr = Array.from(next);
      window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(arr.length > DISMISSED_CAP ? arr.slice(-DISMISSED_CAP) : arr));
    } catch { /* private mode: remembered for this page, not the next */ }
  }
  for (const listener of listeners) listener();
}

/** One recap's identity: the session, and the moment Claude Code wrote it. */
export function recapKey(sessionId: string, at: number): string {
  return `${sessionId}@${at}`;
}

export function isRecapDismissed(key: string): boolean {
  return dismissed.has(key);
}

/** The note's ×: put this recap's note away. */
export function dismissRecap(key: string): void {
  if (dismissed.has(key)) return;
  const next = new Set(dismissed);
  next.add(key);
  commit(next);
}

/** The card's ※: bring the note back, or put it away. */
export function toggleRecapDismissed(key: string): void {
  const next = new Set(dismissed);
  if (!next.delete(key)) next.add(key);
  commit(next);
}

/** Whether this recap's note has been put away. No recap — null — is never
 *  dismissed, and re-renders nothing. */
export function useRecapDismissed(key: string | null): boolean {
  return useSyncExternalStore(subscribe, () => key != null && dismissed.has(key), () => false);
}

/** The canvas id of a session root's recap note, beside the `group:` ids the
 *  session drag handles use. */
export function recapNoteId(rootId: string): string {
  return `recap:${rootId}`;
}

/** Whether a canvas id is a recap note's. */
export function isRecapNoteId(id: string): boolean {
  return id.startsWith("recap:");
}

/** A number that moves whenever a note is put away or brought back. The note
 *  nodes are built from this store, so the canvas rebuilds on it — a × has to
 *  take its note away now, not on the next clock tick. */
export function useRecapNotesVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => 0);
}
