// A Codex launch becoming its session on the stage.
//
// Claude is told its session id at launch, so the stage waits for the board to
// hear of that id (use-stage.ts, onLaunched). Codex picks its own once it
// starts writing, so the launch route answers "" and the stage had nothing to
// wait for: a Codex started from New session stayed a bare "Codex" on the
// stage, with no model and no status, its tile never marked as the one on the
// stage, the Terminal button unable to go back to it, and Hide finished free
// to take its card off the board while the stage still showed it.
//
// So each Codex session that turns up on the board while the stage shows the
// launch is put to the deck with the launch's key (POST /api/terminal/claim).
// The deck finds the pane the session runs in, the way it does for a click on
// its card, says whether that pane is the one this launch started, and on a
// yes labels the pane with the session's id. The page never guesses: two
// Codex sessions can begin in one folder in the same second, and only the
// deck can tell which pane each is in. A session the board had before the
// launch was asked for is never asked about, since a launch starts a new
// session, and nor is anything once the stage has moved off the launch.

import { useEffect, useRef } from "react";
import type { StageTarget } from "../../stage-shell";
import { claimLaunch } from "../../terminal-api";
import type { AgentNodeData } from "../../types";
import { useMirroredRef } from "../../use-mirrored-ref";

/** How many times one session is put to the deck, and how far apart. A
 *  request that failed, or a tmux that could not say, is asked again; a no
 *  is not. */
export const CODEX_LAUNCH_ASKS = 3;
export const CODEX_LAUNCH_GAP_MS = 1_500;

export interface Asked { tries: number; at: number; busy: boolean; done: boolean }

/** The sessions worth putting to the deck at `now`: Codex sessions the board
 *  did not have when the launch was asked for, not answered, not in flight,
 *  and not asked too recently. Pure. */
export function codexCandidates(
  agents: Iterable<AgentNodeData>,
  before: ReadonlySet<string>,
  asked: ReadonlyMap<string, Asked>,
  now: number,
): AgentNodeData[] {
  const out: AgentNodeData[] = [];
  for (const a of agents) {
    if (a.kind !== "root" || a.provider !== "codex" || before.has(a.id)) continue;
    const seen = asked.get(a.id);
    if (seen && (seen.busy || seen.done || seen.tries >= CODEX_LAUNCH_ASKS || now - seen.at < CODEX_LAUNCH_GAP_MS)) continue;
    out.push(a);
  }
  return out;
}

/** While `target` is a Codex launch, find the board session it became and
 *  hand its id to `onFound` with the launch's key, once. Runs after every
 *  render, which the board's events and the deck's clock both cause, so a
 *  session asked again is asked on the first render after its gap. */
export function useCodexLaunch(
  target: StageTarget | null,
  agents: ReadonlyMap<string, AgentNodeData>,
  onFound: (sessionId: string, key: string) => void,
): void {
  const watch = useRef<{ key: string; before: Set<string>; asked: Map<string, Asked>; found: boolean } | null>(null);
  const found = useMirroredRef(onFound);
  const key = target?.kind === "launch" && target.agent === "codex" ? target.key : null;
  // An answer that comes back after the stage has gone is for nobody.
  useEffect(() => () => { watch.current = null; }, []);
  useEffect(() => {
    if (!key) {
      watch.current = null;
      return;
    }
    if (watch.current?.key !== key) watch.current = { key, before: new Set(agents.keys()), asked: new Map(), found: false };
    const w = watch.current;
    if (w.found) return;
    const now = Date.now();
    for (const a of codexCandidates(agents.values(), w.before, w.asked, now)) {
      const entry: Asked = { tries: (w.asked.get(a.id)?.tries ?? 0) + 1, at: now, busy: true, done: false };
      w.asked.set(a.id, entry);
      void claimLaunch({ sessionId: a.sessionId, provider: "codex", cwd: a.cwd ?? "" }, key).then(answer => {
        entry.busy = false;
        if (!answer.ok) return;
        if (answer.claimed) {
          entry.done = true;
          if (watch.current !== w || w.found) return;
          w.found = true;
          found.current(a.sessionId, key);
          return;
        }
        if (answer.target.kind !== "unsupported") entry.done = true;
      });
    }
  });
}
