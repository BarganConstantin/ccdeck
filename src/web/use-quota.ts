// The usage panel's three reads of quota: Claude's windows, Codex's lanes and
// credits, and the Codex token count from the rollout files on this disk.
//
// Lifted out of UsagePanel.tsx unchanged, with the shapes each route answers
// in. Each hook owns its poll and its setters; the panel gets back the latest
// answer and, from the two its ↻ presses, whether a forced read is out and the
// `refresh` that starts one. Each is switched off entirely on a deck that does
// not watch its CLI (#402), because /api/quota can spawn `claude --print
// /usage` and the Codex poll refreshes an OAuth token against OpenAI.
import { useEffect, useRef, useState } from "react";
import { selfPressAccepted } from "./panel-press";
import type { ResetCredits } from "./reset-credits";

// ── Quota types ────────────────────────────────────────────────────────────
export interface QuotaData {
  ok: boolean;
  session5hPct?: number;
  session5hReset?: string;
  session5hResetAt?: number;   // unix seconds
  session5hWindowSec?: number;
  /** Null, or absent from a CLI reading, when the source said nothing about
   *  the 7-day window — which is not 0%, and the bar says so (#1627). */
  week7dPct?: number | null;
  week7dReset?: string;
  week7dResetAt?: number;      // unix seconds
  week7dWindowSec?: number;
  weekSonnetPct?: number;
  weekOpusPct?: number;
  source?: string;
  /** Why there is nothing to show, when `ok` is false. The server has always
   *  sent this and the panel used to drop it, so every failure printed the one
   *  sentence about running /usage — including on machines where that cannot
   *  help, because they have no subscription window to report. */
  reason?: string;
  fetchedAt?: number;
  /** The server is holding the last reading it has rather than a new one —
   *  over its own floor, through a 429 cooldown, or past the answer's deadline
   *  (quota.mjs). `fetchedAt` is still that reading's own time. The server has
   *  sent it all along; declared so the section can say it. */
  stale?: boolean;

  // ─── Pay-as-you-go top-up, which the server has always sent ───────────────
  //
  // quota.mjs has computed and spread these four since the block was written,
  // and nothing on this side declared them, so `setQuota(await res.json())` —
  // `any` into a typed slot — dropped every one (#1046). A user on a plan with
  // extra usage credits enabled saw the 5h and 7d bars and no sign at all that
  // they were spending against a monthly top-up limit: the one number on this
  // panel with a hard financial edge.
  //
  // Shown as a proportion rather than an amount, deliberately. `used_credits`
  // and `monthly_limit` arrive in whatever unit the upstream API uses and this
  // deck has no way to confirm whether that is currency or cents; printing
  // "$3.40" off an unverified scale would be exactly the kind of confidently
  // wrong money figure the rest of this panel is careful not to produce. A
  // percentage of the limit is true in any unit; the currency code goes in the
  // label, so a reader who knows the scale knows which one they are reading.
  /** The plan has pay-as-you-go credits switched on. */
  extraEnabled?: boolean;
  /** Spent against the top-up this month, in the upstream's own unit. */
  extraUsedCredits?: number;
  /** The ceiling for the month, same unit. Absent means no ceiling was given. */
  extraMonthlyLimit?: number;
  /** ISO currency code, for the title. */
  extraCurrency?: string;

  /** Claude's saved limit resets — "Reset for free" in Claude's Settings →
   *  Usage — that can be spent now, and when the first of them lapses (epoch
   *  milliseconds). The Codex card's `resetCredits`, in the same shape. Absent
   *  whenever the server could not establish the inventory for this account —
   *  which is not the same as having none, and is why nothing is drawn for it. */
  resetCredits?: ResetCredits | null;
}

// ── Quota fetch hook ───────────────────────────────────────────────────────
const QUOTA_POLL_MS = 60_000;

/**
 * How long this side holds a /api/quota request open.
 *
 * The server now answers within a budget of its own (#1011), so on a deck this
 * page is talking to, this never fires. It is here for the deck this page is
 * talking to on a bad day: a bare `fetch(url)` has no deadline at all, and a
 * request nobody will ever answer is held until the tab is closed. What that
 * cost, measured before the server side was bounded, was a panel reading
 * "Checking…" for 47 seconds and one fewer socket in the browser's per-origin
 * pool for the whole of it — the pool is six, and the board's event stream
 * already holds one.
 *
 * Comfortably above the server's five seconds rather than near it: a deadline
 * that raced the answer would turn a slow-but-successful read into a failure,
 * which is the opposite of the point. This is the outer net, not the budget.
 */
const QUOTA_REQUEST_MS = 20_000;

/**
 * @param enabled whether this deck watches Claude Code at all. False stops the
 *   poll rather than only hiding its output: /api/quota is not a cheap read —
 *   it can spawn `claude --print /usage` — and a machine with no Claude Code
 *   would pay for that once a minute forever to render nothing.
 */
export function useQuota(enabled: boolean) {
  const [quota, setQuota] = useState<QuotaData | null>(null);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<number | null>(null);

  // The same fact as `loading`, readable without waiting for a render. The ↻
  // stays enabled while its own request is out (#620), so the second press
  // reaches here and this is what refuses it. Only forced reads take the lock:
  // the poll is not a press and must never be blocked by one.
  const busyRef = useRef(false);

  const fetch_ = async (forceRefresh = false) => {
    if (forceRefresh && !selfPressAccepted(busyRef.current)) return;
    if (forceRefresh) { busyRef.current = true; setLoading(true); }
    try {
      const url = forceRefresh ? "/api/quota?refresh=1" : "/api/quota";
      const res = await fetch(url, { signal: AbortSignal.timeout(QUOTA_REQUEST_MS) });
      if (res.ok) setQuota(await res.json());
    } catch { /* server unreachable, or a request that outlived its usefulness */ }
    finally { if (forceRefresh) { busyRef.current = false; setLoading(false); } }
  };

  useEffect(() => {
    if (!enabled) return;
    fetch_(true); // force on mount — avoids stale ok:false cache from prior run
    timerRef.current = window.setInterval(() => fetch_(false), QUOTA_POLL_MS);
    return () => { if (timerRef.current != null) window.clearInterval(timerRef.current); };
  }, [enabled]);

  const refresh = () => { if (enabled) fetch_(true); };
  return { quota, loading, refresh };
}

// ── Codex quota types + hook ───────────────────────────────────────────────
// Lanes arrive as a list rather than fixed 5h/7d slots: which windows an
// account has depends on its plan (free plans get weekly only, some get a
// 30-day cap), and the server labels each one from the duration the API
// reported instead of from its position in the payload.
interface CodexLane {
  id: string;
  key: "session" | "weekly" | "monthly" | "unknown";
  label: string;
  pct: number;
  windowSec: number | null;
  resetAt: number | null;
  reset: string | null;
}

interface CodexCreditLimit {
  limit: number;
  used: number;
  usedPct: number;
  remaining: number;
  source: string | null;
  resetAt: number | null;
  reset: string | null;
}

export interface CodexQuotaData {
  ok: boolean;
  limitReached?: boolean;
  windows?: CodexLane[];
  extraWindows?: CodexLane[];
  plan?: string | null;
  planLabel?: string | null;
  creditsBalance?: string | null;
  creditsUnlimited?: boolean;
  overageReached?: boolean;
  creditLimit?: CodexCreditLimit | null;
  spendControlReached?: boolean;
  reachedType?: string | null;
  promo?: string | null;
  partial?: boolean;
  resetCredits?: ResetCredits | null;
  reason?: string;
  fetchedAt?: number;
}

// ── Codex usage types + hook (token aggregation fallback) ─────────────────
interface CodexWindow {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  sessionCount: number;
}
export interface CodexUsageData {
  ok: boolean;
  window5h?: CodexWindow;
  window7d?: CodexWindow;
  fetchedAt?: number;
}

const CODEX_POLL_MS = 60_000;

/** @param enabled whether this deck watches Codex — see useQuota above, which
 *   states the same rule for the other side. A Codex poll refreshes an OAuth
 *   token against OpenAI, which is not work to do on a machine with no Codex. */
export function useCodexQuota(enabled: boolean) {
  const [data, setData] = useState<CodexQuotaData | null>(null);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<number | null>(null);

  // See useQuota above: the ↻ presses both hooks, so both hold a lock of their
  // own against the second press (#620).
  const busyRef = useRef(false);

  const fetch_ = async (forceRefresh = false) => {
    if (forceRefresh && !selfPressAccepted(busyRef.current)) return;
    if (forceRefresh) { busyRef.current = true; setLoading(true); }
    try {
      const url = forceRefresh ? "/api/codex-quota?refresh=1" : "/api/codex-quota";
      const res = await fetch(url);
      if (res.ok) setData(await res.json());
    } catch { /* server unreachable */ }
    finally { if (forceRefresh) { busyRef.current = false; setLoading(false); } }
  };

  useEffect(() => {
    if (!enabled) return;
    fetch_(true); // force on mount — get fresh data immediately
    timerRef.current = window.setInterval(() => fetch_(false), CODEX_POLL_MS);
    return () => { if (timerRef.current != null) window.clearInterval(timerRef.current); };
  }, [enabled]);

  const refresh = () => { if (enabled) fetch_(true); };
  return { data, loading, refresh };
}

export function useCodexUsage(enabled: boolean) {
  const [data, setData] = useState<CodexUsageData | null>(null);
  const timerRef = useRef<number | null>(null);

  const fetch_ = async () => {
    try {
      const res = await fetch("/api/codex-usage");
      if (res.ok) setData(await res.json());
    } catch { /* server unreachable */ }
  };

  useEffect(() => {
    if (!enabled) return;
    fetch_();
    timerRef.current = window.setInterval(fetch_, CODEX_POLL_MS);
    return () => { if (timerRef.current != null) window.clearInterval(timerRef.current); };
  }, [enabled]);

  return { data };
}
