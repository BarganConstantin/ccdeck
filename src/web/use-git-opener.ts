// What a card's branch chip opens, installed by the page: today the agent's
// detail panel, selected and brought into view the way a double-click does
// (use-canvas-clicks.ts). The git view replaces this opener with its own — see
// git-open.ts.
import { useEffect } from "react";
import { setGitOpener } from "./git-open";
import type { useSelection } from "./use-selection";

export function useGitOpener({ selectAgent, focusAgent }: {
  selectAgent: ReturnType<typeof useSelection>["selectAgent"];
  focusAgent: (id: string) => void;
}): void {
  useEffect(() => {
    setGitOpener(id => {
      selectAgent(id, false);
      // A paint later, for the canvas the panel has just narrowed.
      window.setTimeout(() => { try { focusAgent(id); } catch { /* the card left */ } }, 80);
    });
    return () => setGitOpener(null);
  }, [selectAgent, focusAgent]);
}
