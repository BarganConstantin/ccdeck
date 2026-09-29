// Month-to-date usage for the topbar's "this month" phrase.
//
// Lifted out of App.tsx's `Inner` unchanged: two state variables, the phrase's
// ref and one effect, eighty lines that shared nothing with the panel toggles on
// either side of them. What moving them buys is the setters. The figure and the
// failure flag change in exactly one place — the read below — and the rule that
// decides between keeping a stale figure and dropping it (#737) is now the only
// code that can reach either one. App.tsx gets the two values to draw and the
// ref to hang on the phrase, and nothing it can write to.
import { useEffect, useRef, useState } from "react";

import {
  monthlyUsageFrom,
  monthlyUsageSince,
  monthlyReadDue,
  MONTHLY_USAGE_CHECK_MS,
  type MonthlyUsage,
} from "./monthly-usage";

export function useMonthlyUsage() {
  /** Month-to-date usage for the topbar. Unlike the canvas aggregate, this is
   *  read from transcripts via ccusage, so finished sessions never disappear
   *  from the figure when their cards are pruned. */
  const [monthlyUsage, setMonthlyUsage] = useState<MonthlyUsage | null>(null);
  const [monthlyUsageUnavailable, setMonthlyUsageUnavailable] = useState(false);
  /** The phrase itself, so the poll can ask whether it is on screen. */
  const monthUsageRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let alive = true;
    let inFlight = false;
    let lastReadAt: number | null = null;
    let lastSince: string | null = null;
    // The month the figure on screen was read for. A failed read leaves the
    // last good figure standing, as the Usage panel does, but only inside the
    // month it belongs to: once the 1st comes round, last month's total under
    // the words "this month" is the label and the number disagreeing, the one
    // pairing #737 says has to survive the change.
    let goodSince = "";
    const failed = (since: string) => {
      if (!alive) return;
      setMonthlyUsageUnavailable(true);
      if (since !== goodSince) setMonthlyUsage(null);
    };

    const read = () => {
      if (inFlight) return;
      inFlight = true;
      lastReadAt = Date.now();
      const since = monthlyUsageSince();
      lastSince = since;
      fetch(`/api/ccusage?since=${since}`)
        .then(r => (r.ok ? r.json() : null))
        .then(data => {
          if (!alive) return;
          if (!data?.ok) { failed(since); return; }
          goodSince = since;
          setMonthlyUsage(monthlyUsageFrom(data));
          setMonthlyUsageUnavailable(false);
        })
        .catch(() => failed(since))
        .finally(() => { inFlight = false; });
    };

    // Whether the phrase is drawn, asked of the phrase rather than of a copy of
    // the breakpoints it gives way at: a box inside `display: none` has no
    // client rects, and that stays true whatever the stylesheet later decides
    // hides it. Clipped by the readout still counts as drawn.
    const poll = () => {
      const phrase = monthUsageRef.current;
      if (monthlyReadDue({
        shown: !!phrase && phrase.getClientRects().length > 0,
        tabVisible: document.visibilityState === "visible",
        lastSince,
        since: monthlyUsageSince(),
        lastReadAt,
        now: Date.now(),
      })) read();
    };

    poll();
    // Three ways back to a read, all through the one rule: the minute check,
    // the tab coming to the front, and the phrase itself coming back on
    // screen. The observer is the last of those — a box going to or from
    // `display: none` changes its size, so it reports the moment the window
    // is wide enough again rather than up to a minute later.
    const timer = window.setInterval(poll, MONTHLY_USAGE_CHECK_MS);
    document.addEventListener("visibilitychange", poll);
    let seen: ResizeObserver | null = null;
    if (monthUsageRef.current && typeof ResizeObserver !== "undefined") {
      seen = new ResizeObserver(poll);
      seen.observe(monthUsageRef.current);
    }
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
      seen?.disconnect();
    };
  }, []);

  return { monthlyUsage, monthlyUsageUnavailable, monthUsageRef };
}
