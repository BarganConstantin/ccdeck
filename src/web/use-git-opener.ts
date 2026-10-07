// What a card's branch chip opens, installed by the page: the git view on that
// agent, selected the way a click selects it (see git-open.ts). The chip
// itself only names the agent; a commit in the lane under a card names the
// commit too.
import { useEffect } from "react";
import { setGitOpener, type GitOpenHints } from "./git-open";
import type { useSelection } from "./use-selection";

export function useGitOpener({ selectAgent, openGitView }: {
  selectAgent: ReturnType<typeof useSelection>["selectAgent"];
  /** Opens the git view on the selected agent: sliding in from a pointer,
   *  at once from a key. */
  openGitView: (agentId: string, how: "pointer" | "key", hints?: GitOpenHints) => void;
}): void {
  useEffect(() => {
    setGitOpener((id, how, hints) => {
      selectAgent(id, false);
      openGitView(id, how, hints);
    });
    return () => setGitOpener(null);
  }, [selectAgent, openGitView]);
}
