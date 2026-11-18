// The state the Inspector names for the agent it is about.
//
// A session's state is said in three places in the Workspace: the rail's row, the
// pane's header and the Inspector's title. The pane's sentence is
// stageStatusFrom(boardFactsFor(root, subagents)), and the Inspector takes that
// same sentence for a session's root, so an own-tmux session that has had no
// prompt reads "ready · for a first prompt" in all of them, not "Working"
// because its reducer state is still active. A subagent has no pane of its own:
// it says what its card says, and so does any session on the Board, where
// there is no pane to agree with.
//
// The pane's functions live with the stage, which a visit with the terminal off
// never loads (terminal-stage-lazy.test.ts), so they are read through a dynamic
// import, only while the Workspace is drawn (inspector-status-pane.ts). Until
// they arrive the title says what the card says.
import { useEffect, useState } from "react";

import type { KitStateName } from "./components/kit-icons";
import { t } from "./i18n";
import { faceStatus } from "./node-face";
import type { AgentNodeData } from "./types";

export interface InspectorStatus {
  /** The kit's state glyph for the title. */
  glyph: KitStateName;
  /** The sentence the pane's header prints: "ready · for a first prompt". */
  phrase: string;
}

/** What the card says, as a glyph and a word: the status of a subagent, of any
 *  agent on the Board, and of a session until the pane's sentence has loaded. */
export function cardStatus(agent: AgentNodeData): InspectorStatus {
  // The card's own head (faceStatus): a finished agent whose calls failed is
  // the partial mark and "Done · 1 failed" there, so here too.
  const state = faceStatus(agent);
  const glyph: KitStateName = state.tone === "active" ? "working" : state.tone === "waiting" ? "waiting" : state.tone === "partial" ? "partial" : state.tone === "err" ? "error" : state.tone === "ready" ? "idle" : "done";
  const word = state.tone === "partial" ? `${t("board.card.stateDone")} · ${state.word}` : state.word;
  return { glyph, phrase: word.toLowerCase() };
}

type Pane = typeof import("./inspector-status-pane");

/** The status to print for `selected`. With `workspace` set, a session's root
 *  takes the pane's sentence as soon as the stage's functions have loaded. */
export function useInspectorStatus(selected: AgentNodeData, agents: ReadonlyMap<string, AgentNodeData>, now: number, workspace: boolean): InspectorStatus {
  const [pane, setPane] = useState<Pane | null>(null);
  useEffect(() => {
    if (!workspace || pane) return;
    let live = true;
    void import("./inspector-status-pane").then(m => { if (live) setPane(m); }, () => {});
    return () => { live = false; };
  }, [workspace, pane]);
  return pane && selected.kind === "root" ? pane.paneStatus(selected, agents, now) : cardStatus(selected);
}
