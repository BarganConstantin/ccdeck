// The page's poll of GET /api/provider-status (#1311): what Anthropic's and
// OpenAI's status pages say, for the topbar's incident chips and the usage
// panel's quota sections.
//
// Every three minutes, which is the server's own rate: it reads the pages when
// asked, at most every two and a half minutes, so a poll any faster would be
// handed the same answer back. None while the tab is hidden — an incident
// nobody can see is not worth a request to someone else's server — and one on
// the way back, if the answer on screen is older than a poll.
//
// The rules are statusPoll's, a function with no React and no DOM in it, so the
// suite can drive them; the hook only wires them to a timer and to
// `visibilitychange`.
import { useEffect, useState } from "react";
import type { ProviderStatusReport } from "./provider-status";

export const PROVIDER_STATUS_POLL_MS = 3 * 60_000;

/** The route answers from its cache or after one read of each page, and a
 *  page read has an eight-second deadline of its own. This is the outer net. */
const REQUEST_MS = 20_000;

export interface StatusPollDeps {
  /** One ask of the route: the report, or null when there was none. Never throws. */
  fetchReport: () => Promise<ProviderStatusReport | null>;
  /** Whether anybody can see the page right now. */
  visible: () => boolean;
  now: () => number;
  onReport: (report: ProviderStatusReport) => void;
}

/**
 * When the page asks: on each `tick` of the three-minute timer while the tab
 * is visible, and on `wake` — the tab coming back — only if the answer on
 * screen is at least a poll old, so flicking between two tabs does not spend
 * a request each time. After `stop`, an answer still on its way is dropped.
 */
export function statusPoll({ fetchReport, visible, now, onReport }: StatusPollDeps) {
  let landedAt = 0;
  let alive = true;
  const load = async () => {
    if (!visible()) return;
    const report = await fetchReport();
    if (!alive || !report) return;
    landedAt = now();
    onReport(report);
  };
  return {
    tick: load,
    wake: async () => {
      if (visible() && now() - landedAt >= PROVIDER_STATUS_POLL_MS) await load();
    },
    stop: () => { alive = false; },
  };
}

async function fetchReport(): Promise<ProviderStatusReport | null> {
  try {
    const res = await fetch("/api/provider-status", { signal: AbortSignal.timeout(REQUEST_MS) });
    return res.ok ? await res.json() : null;
  } catch { return null; /* the deck is down; the connection banner says so */ }
}

/**
 * @param enabled whether the deck watches either CLI. False asks nothing: a
 *   deck that watches neither has no provider to report on.
 */
export function useProviderStatus(enabled: boolean): ProviderStatusReport | null {
  const [report, setReport] = useState<ProviderStatusReport | null>(null);

  useEffect(() => {
    if (!enabled) { setReport(null); return; }
    const poll = statusPoll({
      fetchReport,
      visible: () => document.visibilityState === "visible",
      now: () => Date.now(),
      onReport: setReport,
    });
    poll.tick();
    const timer = window.setInterval(poll.tick, PROVIDER_STATUS_POLL_MS);
    const wake = () => { poll.wake(); };
    document.addEventListener("visibilitychange", wake);
    return () => {
      poll.stop();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [enabled]);

  return report;
}
