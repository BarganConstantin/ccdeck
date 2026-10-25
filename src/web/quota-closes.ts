import { useEffect, useState } from "react";

/** How full one quota window was when it ended (quota-closes.mjs). */
export interface QuotaClose {
  id: string; label: string; windowSec: number;
  /** When the window reset, epoch seconds. */
  resetAt: number;
  /** The last reading before it ended, and the highest. */
  pct: number; peak: number;
  /** When that last reading and the first were taken, epoch ms; how many there were. */
  t: number; first: number; n: number;
  plan?: string;
  /** "early" when a new window was already running before this one's reset. */
  ended: "reset" | "early";
}
export interface QuotaCloses { ok: boolean; storageOk: boolean; account: string; closed: QuotaClose[] }

/** A week read this close to its reset says how full it ended. One read earlier
 *  may have gone on filling, and is left out rather than guessed at. */
export const READ_NEAR_RESET_MS = 12 * 3600_000;
const mainWeek = new Set(["seven_day", "weekly"]);

/** The account's last `count` weeks that ran to their reset and were read near
 *  it, newest first. */
export function endedWeeks(closed: QuotaClose[], count = 4): QuotaClose[] {
  return closed.filter(c => mainWeek.has(c.id) && c.ended === "reset" && c.resetAt * 1000 - c.t <= READ_NEAR_RESET_MS)
    .sort((a, b) => b.resetAt - a.resetAt).slice(0, count);
}

/** "Last 4 weeks ended 62% used, 38% unused", or null with no week to say it of. */
export function weekEndsLine(weeks: QuotaClose[]): string | null {
  if (!weeks.length) return null;
  const used = Math.round(weeks.reduce((sum, c) => sum + c.pct, 0) / weeks.length);
  return `${weeks.length === 1 ? "Last week" : `Last ${weeks.length} weeks`} ended ${used}% used, ${100 - used}% unused`;
}

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const before = (ms: number) => ms < 3600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : `${Math.round(ms / 3600_000)} h`;

/** Each week on its own line, for the title: what it ended at and how near its reset that was read. */
export function weekEndsTitle(weeks: QuotaClose[]): string {
  return [
    ...weeks.map(c => `${day(c.resetAt * 1000)}: ${Math.round(c.pct)}% used, read ${before(c.resetAt * 1000 - c.t)} before the reset`),
    "An average of the weekly window's last reading before each reset",
  ].join("\n");
}

const CLOSES_POLL_MS = 15 * 60_000;

/** The ended weeks of one account, read when the account changes and every
 *  quarter hour after: a week ends at most once a week, so nothing is lost. */
export function useEndedWeeks(provider: "claude" | "codex", account: string | undefined): QuotaClose[] {
  const [weeks, setWeeks] = useState<QuotaClose[]>([]);
  useEffect(() => {
    setWeeks([]);
    if (!account) return;
    let live = true;
    const read = async () => {
      try {
        const res = await fetch(`/api/quota/closes?provider=${provider}&account=${encodeURIComponent(account)}`, { signal: AbortSignal.timeout(12_000) });
        const reply = await res.json() as QuotaCloses;
        if (live && res.ok && reply.ok && reply.account === account && Array.isArray(reply.closed)) setWeeks(endedWeeks(reply.closed));
      } catch { /* the line is a footnote; without it the panel is whole */ }
    };
    void read();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void read(); }, CLOSES_POLL_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [provider, account]);
  return weeks;
}
