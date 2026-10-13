import type { Account } from "../../claude-accounts";
export const NOW = 1_800_000_000;
export const account = (resetAt = NOW - 1): Account => ({
  num: 1, email: "sample@example.test", alias: null, org: null, active: true,
  disabled: false, lanes: [
    { id: "five_hour", label: "5h", pct: 100, resetAt },
    { id: "seven_day", label: "7d", pct: 100, resetAt },
  ], headroom: 0, fetchedAt: (NOW - 60) * 1000, nextAt: null, stale: false, error: null,
});
