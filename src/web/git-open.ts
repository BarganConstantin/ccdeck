// What pressing a card's branch chip does, reached from inside the card without
// threading a callback through every node's data.
//
// The page registers one opener (App.tsx); the chip calls `openGitFor`. Today
// the opener selects the agent and opens its detail panel, the way a
// double-click does. The git view will register its own opener here and open
// on that agent instead — the chip does not change.
//
// The lane of commits under a card (CommitBand.tsx) goes through the same
// door, naming the commit to open on (`sel`, its full SHA).
/** How the chip was pressed: a pointer opens the view with its slide, a key
 *  (Enter or Space on the focused chip) opens it at once. */
type Opener = (agentId: string, how: "pointer" | "key", hints?: GitOpenHints) => void;

/** What to open on: a history row, by its full SHA. */
export interface GitOpenHints {
  sel?: string | null;
}

let opener: Opener | null = null;

/** Install the page's opener, or remove it with null. */
export function setGitOpener(fn: Opener | null): void {
  opener = fn;
}

/** The chip was pressed on this agent's card — or a commit in the lane under
 *  it, which `hints.sel` names. */
export function openGitFor(agentId: string, how: "pointer" | "key" = "pointer", hints?: GitOpenHints): void {
  opener?.(agentId, how, hints);
}
