// What pressing a card's branch chip does, reached from inside the card without
// threading a callback through every node's data.
//
// The page registers one opener (App.tsx); the chip calls `openGitFor`. Today
// the opener selects the agent and opens its detail panel, the way a
// double-click does. The git view will register its own opener here and open
// on that agent instead — the chip does not change.
type Opener = (agentId: string) => void;

let opener: Opener | null = null;

/** Install the page's opener, or remove it with null. */
export function setGitOpener(fn: Opener | null): void {
  opener = fn;
}

/** The chip was pressed on this agent's card. */
export function openGitFor(agentId: string): void {
  opener?.(agentId);
}
