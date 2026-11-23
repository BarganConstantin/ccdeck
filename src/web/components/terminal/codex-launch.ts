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
//
// A no that names a pane, or that there is none, is final. A C (a plain
// process in some other terminal) is not: on Windows the deck answers C for a
// new Codex while it cannot yet tell which console the session runs in, as
// when another Codex process was running at that moment — the deck runs one
// itself every couple of minutes to read the account. Taken as final, that
// first C left the launch unbound, and Chat said "Not connected" for a
// session started right there. So a C is asked again, further apart each
// time, for ten minutes at most. Linux and macOS answer such a moment as
// unsupported, which is asked again anyway.

import { useEffect, useRef } from "react";
import type { StageTarget } from "../../stage-shell";
import { claimLaunch } from "../../terminal-api";
import type { AgentNodeData } from "../../types";
import { useMirroredRef } from "../../use-mirrored-ref";

/** How many times one session is put to the deck, and how far apart. A
 *  request that failed, or a tmux that could not say, is asked again; a no
 *  that names a pane, or that there is none, is not. */
export const CODEX_LAUNCH_ASKS = 3;
export const CODEX_LAUNCH_GAP_MS = 1_500;

/** A C is asked again after these gaps, the last one repeating, until
 *  CODEX_UNSURE_FOR_MS after the first C: the deck may only be unable to
 *  tell yet (see the top of this file). Once a C has come, these and not the
 *  two above decide when the session is asked. */
export const CODEX_UNSURE_GAPS_MS: readonly number[] = [3_000, 6_000, 12_000, 30_000];
export const CODEX_UNSURE_FOR_MS = 10 * 60_000;

/** One session's asks: how many, when the last one went out (after a C, when
 *  that answer came back), whether one is in flight, whether the answer is
 *  final, and how many Cs since when. */
export interface Asked { tries: number; at: number; busy: boolean; done: boolean; unsure?: number; since?: number }

/** Whether a session asked before is not to be asked at `now`. */
function resting(seen: Asked, now: number): boolean {
  if (seen.busy || seen.done) return true;
  if (seen.unsure && seen.since !== undefined) {
    const gap = CODEX_UNSURE_GAPS_MS[Math.min(seen.unsure, CODEX_UNSURE_GAPS_MS.length) - 1];
    return now - seen.since >= CODEX_UNSURE_FOR_MS || now - seen.at < gap;
  }
  return seen.tries >= CODEX_LAUNCH_ASKS || now - seen.at < CODEX_LAUNCH_GAP_MS;
}

/** The sessions worth putting to the deck at `now`: Codex sessions the board
 *  did not have when the launch was asked for, not answered for good, not in
 *  flight, and not asked too recently. Pure. */
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
    if (seen && resting(seen, now)) continue;
    out.push(a);
  }
  return out;
}

/** While `target` is a Codex launch, find the board session it became and
 *  hand its id to `onFound` with the launch's key, once. Runs after every
 *  render, which the board's events and the deck's clock both cause (the
 *  clock renders the deck every quarter second, every second while the
 *  terminal has the keys: use-board-tick.ts), so a session asked again is
 *  asked on the first render after its gap. */
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
      const was = w.asked.get(a.id);
      const entry: Asked = { tries: (was?.tries ?? 0) + 1, at: now, busy: true, done: false, unsure: was?.unsure, since: was?.since };
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
        if (answer.target.kind === "C") {
          const at = Date.now();
          entry.unsure = (entry.unsure ?? 0) + 1;
          entry.since ??= at;
          entry.at = at;
          return;
        }
        if (answer.target.kind !== "unsupported") entry.done = true;
      });
    }
  });
}
