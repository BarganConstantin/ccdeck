// What a card's branch chip opens, installed by the page: the git view on that
// agent, selected the way a click selects it (see git-open.ts). The chip
// itself only names the agent.
import { useEffect } from "react";
import { setGitOpener } from "./git-open";
import type { useSelection } from "./use-selection";

export function useGitOpener({ selectAgent, openGitView }: {
  selectAgent: ReturnType<typeof useSelection>["selectAgent"];
  /** Opens the git view on the selected agent, by pointer. */
  openGitView: (agentId: string) => void;
}): void {
  useEffect(() => {
    setGitOpener(id => {
      selectAgent(id, false);
      openGitView(id);
    });
    return () => setGitOpener(null);
  }, [selectAgent, openGitView]);
}
