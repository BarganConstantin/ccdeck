// The git view's switch as the page holds it: `git` in the deck's prefs.json,
// which the server reads too — off, it reads no repository at all
// (src/server/git-watch.mjs), and the page hides every branch chip.
//
// One value for the whole page, kept outside React so the cards and the
// Settings dialog read the same answer without it being handed down through
// every node's data. On until the prefs read says otherwise, which is the
// server's own default. A press is optimistic and the server's answer settles
// it, as the auto-update switch does (use-auto-restart.ts); once pressed, a
// prefs read that lands late does not undo it.
import { useSyncExternalStore } from "react";

let on = true;
let pressed = false;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  if (next === on) return;
  on = next;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const read = () => on;

/** The switch's value now, outside React. */
export const gitOnNow = read;

/** Whether the git view is on, re-rendering the caller when it changes. */
export function useGitOn(): boolean {
  return useSyncExternalStore(subscribe, read, read);
}

/** Handed the page's one GET /api/prefs (use-prefs-read.ts). */
export function loadGitPrefs(d: { prefs?: { git?: unknown } }): void {
  if (!pressed) set(d.prefs?.git !== false);
}

/** The switch in Settings › Git was pressed. */
export function toggleGit(): void {
  const next = !on;
  pressed = true;
  set(next);
  fetch("/api/prefs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ git: next }),
  }).then(r => (r.ok ? r.json() : null)).then(d => {
    if (d?.ok) set(d.prefs?.git !== false);
  }).catch(() => {});
}
