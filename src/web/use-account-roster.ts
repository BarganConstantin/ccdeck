// The accounts panel's reading of the store: the roster and the auto-switch
// status beside it, the reload that fetches both — on a press and on a timer —
// and the one line that says what went wrong.
//
// Lifted out of AccountsPanel.tsx unchanged: the two answers, `reloading`, the
// failure, `load` and the poll that calls it. What that buys is the writer
// count on `failure`, which the panel wrote from nine places. A reload writes
// it through nextFailure, which is the rule that keeps a refused switch on
// screen across the reload that follows it, and that rule is private here now.
// Everything else says a refusal or takes the line down by name — sayFailure
// and clearFailure — and nothing outside this file can merge into it.
//
// The one thing a fresh roster reaches beyond this file is the set of open
// lanes, which is the panel's: it is handed in as `onRoster`, stable, and
// called where the set used to be trimmed.
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type Failure,
  RELOAD_SLOW,
  RELOAD_UNREACHABLE,
  answered,
  explainReload,
  nextFailure,
} from "./accounts-reload";
import { type AccountsData, type AutoStatus } from "./claude-accounts";

export const POLL_MS = 15_000;
// Past this, a reload is called dead rather than slow. Both routes can spawn
// cswap, and the server kills those at 20 seconds, so anything shorter would
// abort answers that were still coming.
const RELOAD_TIMEOUT_MS = 30_000;

/**
 * @param onRoster A roster arrived. Called with it on every read that answered,
 *   before the auto-switch status and the verdict are set — the panel trims its
 *   open lanes here. Must be stable: `load` is built once, and the poll with it.
 */
export function useAccountRoster(onRoster: (fresh: AccountsData) => void) {
  const [data, setData] = useState<AccountsData | null>(null);
  const [auto, setAuto] = useState<AutoStatus | null>(null);
  const [reloading, setReloading] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const timerRef = useRef<number | null>(null);

  // A reload the user asked for, and the same one on a timer. Only the forced
  // half touches `reloading`: a poll blinking the ↻ every 15 seconds would read
  // as the panel doing something to itself.
  const load = useCallback(async (force = false) => {
    if (force) setReloading(true);
    // A deck that accepts the connection and then wedges never rejects these
    // fetches. Unbounded, the first load would sit on "Checking…" behind a ↻
    // disabled forever — the dead button this busy state exists to rule out,
    // made permanent.
    const ctl = new AbortController();
    const bell = window.setTimeout(() => ctl.abort(), RELOAD_TIMEOUT_MS);
    try {
      const [accts, autoRes] = await Promise.all([
        fetch(`/api/claude-accounts${force ? "?refresh=1" : ""}`, { signal: ctl.signal }),
        fetch("/api/cswap-auto", { signal: ctl.signal }),
      ]);
      if (accts.ok) {
        const fresh: AccountsData = await accts.json();
        setData(fresh);
        onRoster(fresh);
      }
      if (autoRes.ok)  setAuto(await autoRes.json());
      const verdict = explainReload([await answered(accts), await answered(autoRes)]);
      setFailure(prev => nextFailure(prev, verdict));
    } catch {
      // Our own abort is a deck that answered the connection and then took
      // too long, not one that is gone (#829) — see RELOAD_SLOW.
      setFailure(prev => nextFailure(prev, ctl.signal.aborted ? RELOAD_SLOW : RELOAD_UNREACHABLE));
    } finally {
      window.clearTimeout(bell);
      if (force) setReloading(false);
    }
  }, [onRoster]);

  useEffect(() => {
    load(true);
    timerRef.current = window.setInterval(() => load(false), POLL_MS);
    return () => { if (timerRef.current != null) window.clearInterval(timerRef.current); };
  }, [load]);

  /** Say why a press did not work — at the foot of the panel, or on the row it
   *  was about when it carries `row` — or take the line down. Replaces whatever
   *  was there, a reload's verdict included. */
  const sayFailure = useCallback((f: Failure | null) => setFailure(f), []);
  /** Take the line down: a new request supersedes it, and so does its ×. */
  const clearFailure = useCallback(() => setFailure(null), []);

  return { data, auto, reloading, failure, load, sayFailure, clearFailure };
}
