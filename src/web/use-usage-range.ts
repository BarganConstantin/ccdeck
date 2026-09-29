// The period the usage panel shows, read from ccusage through the deck's own
// route (#687, #737).
//
// Lifted out of UsagePanel.tsx unchanged, with the minute it polls on. The
// hook keeps each reading together with the period it answers, the refresh a
// press asked for apart from the polls after it, and the poll itself quiet
// behind a hidden tab. What the panel gets back is rangeView's decision — what
// to show, which period it is of, whether a slower one is still coming — plus
// whether a read is out.
import { useEffect, useRef, useState } from "react";
import type { SessionUsage } from "./live-delta";
import { rangeView, sinceFor, type Landed, type PeriodKey } from "./usage-from-ccusage";

/** How often the panel asks ccusage for a fresh reading, and how stale a
 *  reading has to be before returning to the tab is worth one.
 *
 *  A minute, measured rather than picked: a run costs 7.8 CPU-seconds on a
 *  machine with 3,615 transcripts — 13% of a core at this cadence, and 78% at
 *  ten seconds, which is why the number between readings comes from the canvas
 *  instead (see live-delta.ts) rather than from asking oftener. */
const POLL_MS = 60_000;

/**
 * The chosen span, read from ccusage through the deck's own route.
 *
 * This is the panel's answer to #687 and #737. The figures below it used to sum
 * the agents on the canvas — honest numbers with an unusual scope, and the
 * scope was the problem: the canvas evicts finished sessions on a timer, so the
 * total went DOWN while nothing had happened and nothing had been refunded.
 * ccusage reads the transcripts and forgets nothing.
 *
 * NEVER A HARD DEPENDENCY. ccusage is optional — a machine with no npm, or one
 * running under AGENTS_DECK_NO_INSTALL=1, has none — so `data` staying null is
 * an ordinary state and the panel falls back to the board figures it has always
 * drawn. What this adds can only ever add.
 *
 * Refetched on the period AND on a manual refresh, not on a timer: a range is
 * two ccusage children on the far side, and a panel that is open all afternoon
 * must not spawn them on a clock. The route caches per range anyway.
 */
export function useUsageRange(
  period: PeriodKey,
  refreshKey: number,
  /** The board, right now, as a per-session map — called at the instant a
   *  reading lands so the two are committed together — or null while the page
   *  is still replaying its log, when the board is not yet one to measure from
   *  (#1407). Stable by construction in the caller (a ref-backed callback),
   *  because a changing identity here would re-run the fetch on every 250ms
   *  tick. */
  takeBaseline: () => ReadonlyMap<string, SessionUsage> | null,
) {
  // THE ANSWER AND THE QUESTION IT ANSWERS, together.
  //
  // A bare `data` here was a defect: `period` moves the instant a chip is
  // pressed and the response lands seconds later, so between the two the panel
  // drew today's money under the words "all time" and then silently rewrote the
  // number. Everything downstream reads `landed.period` — the label, the noun,
  // both tables — so the figures and the word over them can never disagree,
  // whatever is in flight. The pressed chip still shows the reader's intent.
  const [landed, setLanded] = useState<Landed | null>(null);
  const [loading, setLoading] = useState(false);
  // A panel left open must not freeze at the figure it opened on, and must not
  // become a background job either. Once a minute, which is the rate a reader
  // watching a total actually notices — and it is a real minute: the server's
  // cache is set to the same 60s, so every poll is a fresh reading rather than
  // the same number handed back. That makes this interval the ccusage run rate,
  // and a run walks every transcript on the machine, which is why it is not
  // faster.
  const [tick, setTick] = useState(0);
  // When the reading on screen was taken. The catch-up below is gated on its
  // age rather than on the tab merely coming forward: flicking between two tabs
  // three times must not spend three ccusage runs.
  const landedAtRef = useRef(0);
  useEffect(() => {
    const visible = () => document.visibilityState === "visible";
    // Nothing to keep fresh behind a hidden tab. A deck left open for a week on
    // a second desktop otherwise spends a run a minute updating numbers nobody
    // is looking at — and on this machine a run is 7.8 CPU-seconds, because
    // ccusage walks every transcript whatever period it is asked for.
    const beat = () => { if (visible()) setTick(n => n + 1); };
    const t = window.setInterval(beat, POLL_MS);
    // Coming back to the tab: read again only if the figures are actually
    // stale. A tab hidden for an hour holds an hour-old reading and is worth a
    // run; a tab hidden for four seconds is not.
    const wake = () => {
      if (!visible()) return;
      if (Date.now() - landedAtRef.current >= POLL_MS) setTick(n => n + 1);
    };
    document.addEventListener("visibilitychange", wake);
    return () => { window.clearInterval(t); document.removeEventListener("visibilitychange", wake); };
  }, []);

  // `refresh=1` belongs to the press that asked for it and to nothing after it.
  // Keyed on the value rather than on truthiness: `refreshKey > 0` made every
  // later fetch — including each poll — spawn a ccusage child for the rest of
  // the panel's life, to re-read data the server had already cached.
  const forcedRef = useRef(refreshKey);
  useEffect(() => {
    let alive = true;
    const force = refreshKey !== forcedRef.current;
    forcedRef.current = refreshKey;
    const want = period;
    const since = sinceFor(want);
    setLoading(true);
    fetch(`/api/ccusage?since=${since}${force ? "&refresh=1" : ""}`)
      .then(r => (r.ok ? r.json() : null))
      // The baseline is taken HERE, in the same call that stores the reading
      // (#784). Taken in a follow-up effect it was one render late, so the memo
      // that reads it paired a new reading with the old starting point and the
      // headline overshot by a minute of spend until the next tick.
      .then(d => {
        if (!alive || !d?.ok) return;
        landedAtRef.current = Date.now();
        setLanded({ period: want, data: d, baseline: takeBaseline() });
      })
      // A deck that is down, or a ccusage that is not there. The panel says so
      // by falling back to the board, not by showing an error over numbers it
      // still has — and a failure leaves the last good reading standing rather
      // than blanking a panel that was correct a moment ago.
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [period, refreshKey, tick]);

  // `rangeView` is the decision — what is shown, which period it is OF, and
  // whether a slower one is still coming — and it lives in the shaping layer so
  // a test can hand it a landed reading and a pressed chip. `loading` is the
  // one thing here that is not a function of those two, and the panel does not
  // read it (see the note at the call site).
  return { ...rangeView(landed, period), loading };
}
