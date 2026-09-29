// The page's poll of GET /api/provider-status (#1311): what Anthropic's and
// OpenAI's status pages say, for the topbar's incident chips and the usage
// panel's quota sections.
//
// Every three minutes, which is the server's own cache: a poll any faster
// would be handed the same answer back. None while the tab is hidden — an
// incident nobody can see is not worth a request to someone else's server —
// and one on the way back, if the answer on screen is older than a poll.
import { useEffect, useRef, useState } from "react";
import type { ProviderStatusReport } from "./provider-status";

export const PROVIDER_STATUS_POLL_MS = 3 * 60_000;

/** The route answers from its cache or after one read of each page, and a
 *  page read has an eight-second deadline of its own. This is the outer net. */
const REQUEST_MS = 20_000;

/**
 * @param enabled whether the deck watches either CLI. False asks nothing: a
 *   deck that watches neither has no provider to report on.
 */
export function useProviderStatus(enabled: boolean): ProviderStatusReport | null {
  const [report, setReport] = useState<ProviderStatusReport | null>(null);
  const landedAt = useRef(0);

  useEffect(() => {
    if (!enabled) { setReport(null); return; }
    let alive = true;
    const visible = () => document.visibilityState === "visible";
    const load = async () => {
      if (!visible()) return;
      try {
        const res = await fetch("/api/provider-status", { signal: AbortSignal.timeout(REQUEST_MS) });
        if (!res.ok) return;
        const data = await res.json();
        if (!alive) return;
        landedAt.current = Date.now();
        setReport(data);
      } catch { /* the deck is down; the connection banner says so */ }
    };
    load();
    const timer = window.setInterval(load, PROVIDER_STATUS_POLL_MS);
    const wake = () => {
      if (visible() && Date.now() - landedAt.current >= PROVIDER_STATUS_POLL_MS) load();
    };
    document.addEventListener("visibilitychange", wake);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [enabled]);

  return report;
}
